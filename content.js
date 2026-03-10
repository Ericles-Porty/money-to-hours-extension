'use strict';

// ── Constants ──────────────────────────────────────────────
const CLS_WRAPPER  = 'preco-horas-wrapper';
const CLS_TIME     = 'preco-horas-time';
const CLS_ORIGINAL = 'preco-horas-original';

const ATTR_EL   = 'data-prh-el';   // marks a replaced element; value = parsed price
const ATTR_ORIG = 'data-prh-orig'; // stores original innerHTML for restoration

// Matches R$ prices in Brazilian format inside a single text node:
//   R$ 1.234,56 | R$ 1234,56 | R$ 1.234 | R$50 | R$ 0,99
const PRICE_RE = /R\$\s*((?:\d{1,3})(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe',
  'input', 'textarea', 'select', 'option',
  'code', 'pre', 'kbd', 'samp',
]);

// ── State ──────────────────────────────────────────────────
let hourlyRate   = 0;
let enabled      = true;
let processDelay = 1000;  // ms before first processDocument (default 1 s)
let observer     = null;
let debounceId   = null;
let initTimerId  = null;

// ── Styles ─────────────────────────────────────────────────
(function injectStyles() {
  if (document.getElementById('preco-horas-style')) return;
  const s = document.createElement('style');
  s.id = 'preco-horas-style';
  s.textContent = `
    .${CLS_WRAPPER}  { display: inline; white-space: nowrap; }
    .${CLS_TIME}     { font-weight: 700; color: inherit; }
    .${CLS_ORIGINAL} { font-size: 0.72em; opacity: 0.65; font-weight: 400; margin-left: 2px; }
  `;
  (document.head || document.documentElement).appendChild(s);
})();

// ── Shared helpers ─────────────────────────────────────────

function parsePriceStr(s) {
  s = s.trim();
  s = s.replace(/\.(?=\d{3}(?:[,\s]|$))/g, ''); // remove thousands-separator dots
  s = s.replace(',', '.');
  return parseFloat(s) || 0;
}

/**
 * Extract a price from arbitrary text. Handles:
 *   "R$ 419,90"                     → 419.90
 *   "419 reais"                     → 419.00
 *   "419 reais com 90 centavos"     → 419.90
 *   "5799 reais"                    → 5799.00  (sem separador de milhar)
 *   "5.799 reais"                   → 5799.00  (com separador de milhar)
 */
function parsePriceFromText(text) {
  if (!text) return 0;
  PRICE_RE.lastIndex = 0;
  const m1 = PRICE_RE.exec(text);
  if (m1) return parsePriceStr(m1[1]);
  // Matches formatted numbers (e.g. "5.799") OR bare integers (e.g. "5799").
  // Using alternation with the formatted form first ensures "5.799 reais" is
  // captured whole rather than partially (avoids matching "799" inside "5799").
  const m2 = text.match(
    /((?:\d{1,3}(?:[.\s]\d{3})+|\d+))\s*reais?(?:\s+com\s+(\d{1,2})\s*centavos?)?/i,
  );
  if (m2) {
    return parseInt(m2[1].replace(/[.\s]/g, '')) + (m2[2] ? parseInt(m2[2]) / 100 : 0);
  }
  return 0;
}

/** Walk up to 5 ancestors looking for an aria-label that contains a price. */
function priceFromAria(el) {
  let cur = el;
  for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
    const price = parsePriceFromText(cur.getAttribute('aria-label') || '');
    if (price > 0) return price;
    cur = cur.parentElement;
  }
  return 0;
}

function priceToTime(price) {
  if (!hourlyRate || hourlyRate <= 0) return null;
  const totalMin = Math.round((price / hourlyRate) * 60);
  return { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

function formatTime({ hours, minutes }) {
  if (hours === 0 && minutes === 0) return '< 1min';
  if (hours === 0)   return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}min`;
}

function formatBRL(price) {
  return `R$ ${price.toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

// ── DOM builders ───────────────────────────────────────────

/** Build an inline <span> wrapper for text-node replacements. */
function buildInline(originalText, price) {
  const time = priceToTime(price);
  if (!time) return null;
  const wrapper = document.createElement('span');
  wrapper.className = CLS_WRAPPER;
  const tSpan = document.createElement('span');
  tSpan.className = CLS_TIME;
  tSpan.setAttribute('data-price', price);
  tSpan.textContent = formatTime(time);
  const oSpan = document.createElement('span');
  oSpan.className = CLS_ORIGINAL;
  oSpan.textContent = `(${originalText.trim()})`;
  wrapper.append(tSpan, oSpan);
  return wrapper;
}

/**
 * Replace an element's entire inner content with the time display.
 * Stores original innerHTML for full restoration later.
 */
function replaceElContent(el, price, origLabel) {
  const time = priceToTime(price);
  if (!time) return;
  el.setAttribute(ATTR_EL, price);
  el.setAttribute(ATTR_ORIG, el.innerHTML);
  const tSpan = document.createElement('span');
  tSpan.className = CLS_TIME;
  tSpan.setAttribute('data-price', price);
  tSpan.textContent = formatTime(time);
  const oSpan = document.createElement('span');
  oSpan.className = CLS_ORIGINAL;
  oSpan.textContent = `(${origLabel})`;
  el.innerHTML = '';
  el.append(tSpan, oSpan);
}

// ═══════════════════════════════════════════════════════════════════════════
// SITE ADAPTERS
// ───────────────────────────────────────────────────────────────────────────
// Add a new entry to SITE_ADAPTERS to support a new website.
//
// Each adapter must implement:
//
//   name       {string}
//     Human-readable label (used only for debugging).
//
//   selector   {string}
//     CSS selector that matches the price CONTAINER element on that site.
//     Keep it as specific as possible to avoid false positives.
//
//   getPrice(containerEl) → number
//     Receives the element matched by `selector`.
//     Must return the parsed price as a float, or 0 to skip this element.
//     Use the shared helpers: parsePriceFromText(), priceFromAria(),
//     parsePriceStr(), and formatBRL().
//
//   getTarget(containerEl) → Element | null   [optional]
//     Returns the specific child element whose innerHTML will be replaced.
//     Defaults to the container element itself.
//     Use this when the element to replace is different from the matched one
//     (e.g. Amazon: match .a-price, replace [aria-hidden="true"] inside it).
//
//   onDone(containerEl)                       [optional]
//     Called after a successful replacement.
//     Use it to mark the container so it isn't re-processed by other passes.
//
// ─────────────────────────────────────────────────────────────────────────
// PATTERN EXAMPLES (uncomment and adapt for new sites):
//
//  ① Simple aria-label:
//     { name: 'Exemplo', selector: '.price-box[aria-label]',
//       getPrice: el => parsePriceFromText(el.getAttribute('aria-label') || '') }
//
//  ② Whole + fraction split (like Amazon):
//     { name: 'Exemplo', selector: '.price-container',
//       getPrice(el) {
//         const int  = parseInt(el.querySelector('.price-int')?.textContent  || '0');
//         const cent = parseInt(el.querySelector('.price-cent')?.textContent || '0');
//         return int + cent / 100;
//       } }
//
//  ③ Replace a child, not the container:
//     { name: 'Exemplo', selector: '.product-price',
//       getPrice: el => parsePriceFromText(el.textContent || ''),
//       getTarget: el => el.querySelector('.price-display') }
// ═══════════════════════════════════════════════════════════════════════════

const SITE_ADAPTERS = [

  // ── Mercado Livre ─────────────────────────────────────────────────────
  // Price is split into separate spans (R$ symbol | integer | cents).
  // The outer element carries a reliable aria-label with the full price.
  // HTML: <span data-andes-money-amount="true" aria-label="Agora: 419 reais">
  //         <span class="andes-money-amount__currency" aria-hidden>R$</span>
  //         <span class="andes-money-amount__fraction" aria-hidden>419</span>
  //         <span class="andes-money-amount__cents"    aria-hidden>90</span>  ← optional
  //       </span>
  {
    name: 'Mercado Livre',
    selector: '[data-andes-money-amount="true"]',
    getPrice(el) {
      // Prefer aria-label: "Agora: 419 reais com 90 centavos"
      const fromAria = parsePriceFromText(el.getAttribute('aria-label') || '');
      if (fromAria) return fromAria;

      // Fallback: reconstruct from Andes-specific DIRECT child spans.
      // :scope > prevents picking up values from nested money-amount elements
      // (e.g. an installment price of R$999 nested inside a R$5.799 container).
      const frac  = el.querySelector(':scope > .andes-money-amount__fraction');
      const cents = el.querySelector(':scope > .andes-money-amount__cents');
      if (!frac) return 0;
      return (parseInt(frac.textContent.replace(/\D/g, '')) || 0)
           + (cents ? (parseInt(cents.textContent.replace(/\D/g, '')) || 0) / 100 : 0);
    },
  },

  // ── Amazon ────────────────────────────────────────────────────────────
  // The visible price is split into .a-price-symbol / .a-price-whole / .a-price-fraction
  // inside an [aria-hidden="true"] span. The sibling .a-offscreen has the full price
  // and is already processed by Pass 1 (text-node pass).
  // HTML: <span class="a-price">
  //         <span class="a-offscreen">R$ 37,70</span>          ← handled by Pass 1
  //         <span aria-hidden="true">
  //           <span class="a-price-symbol">R$</span>
  //           <span class="a-price-whole">37</span>
  //           <span class="a-price-fraction">70</span>
  //         </span>
  //       </span>
  {
    name: 'Amazon',
    selector: '.a-price',
    getPrice(container) {
      const offscreen = container.querySelector('.a-offscreen');

      // Price from already-replaced offscreen (Pass 1 ran first)
      if (offscreen) {
        const tEl = offscreen.querySelector(`.${CLS_TIME}`);
        if (tEl) return parseFloat(tEl.getAttribute('data-price')) || 0;
        const fromText = parsePriceFromText(offscreen.textContent || '');
        if (fromText) return fromText;
      }

      // Fallback: reconstruct from split spans
      const whole    = container.querySelector('.a-price-whole');
      const fraction = container.querySelector('.a-price-fraction');
      if (!whole) return 0;
      const int  = parseInt(whole.textContent.replace(/\D/g, '')) || 0;
      const cent = fraction ? parseInt(fraction.textContent.replace(/\D/g, '')) || 0 : 0;
      return int + cent / 100;
    },
    // Replace only the visible (aria-hidden) child, not the whole container
    getTarget: container => container.querySelector('[aria-hidden="true"]'),
    // Mark the container so processGenericSplit skips it
    onDone: container => container.setAttribute(ATTR_EL, 'amazon'),
  },

  // ── Add more sites here ───────────────────────────────────────────────

];

// Build a combined CSS selector to skip adapter-handled elements in Pass 3
const ADAPTER_SELECTORS = SITE_ADAPTERS.map(a => a.selector).join(', ');

// ── Pass 1: text-node prices ───────────────────────────────
// Handles any page where a full "R$ X,XX" appears in a single text node.

function processTextNode(node) {
  const text = node.nodeValue;
  if (!text?.includes('R$')) return;
  const parent = node.parentElement;
  if (!parent) return;
  if (parent.closest(`.${CLS_WRAPPER}`)) return;
  if (parent.closest(`[${ATTR_EL}]`)) return;
  const tag = parent.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || parent.isContentEditable) return;

  PRICE_RE.lastIndex = 0;
  if (!PRICE_RE.test(text)) return;

  const frag = document.createDocumentFragment();
  let last = 0;
  PRICE_RE.lastIndex = 0;
  let m;
  while ((m = PRICE_RE.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const price = parsePriceStr(m[1]);
    frag.appendChild(
      price > 0
        ? (buildInline(m[0], price) ?? document.createTextNode(m[0]))
        : document.createTextNode(m[0]),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  parent.replaceChild(frag, node);
}

function walkTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest(`.${CLS_WRAPPER}`)) return NodeFilter.FILTER_REJECT;
      if (p.closest(`[${ATTR_EL}]`)) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.includes('R$')) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(processTextNode);
}

// ── Pass 2: site adapters ──────────────────────────────────
// Runs every adapter in SITE_ADAPTERS against the given subtree.

function processAdapters(root) {
  for (const adapter of SITE_ADAPTERS) {
    root.querySelectorAll(adapter.selector).forEach(container => {
      // Determine which element's innerHTML will actually be replaced
      const target = adapter.getTarget ? adapter.getTarget(container) : container;
      if (!target) return;

      // Skip if already replaced (either the container or the target)
      if (container.getAttribute(ATTR_EL) || target.getAttribute(ATTR_EL)) return;
      // Skip if Pass 1 already handled content inside
      if (target.querySelector(`.${CLS_WRAPPER}`)) return;

      const price = adapter.getPrice(container);
      if (!price || price <= 0) return;

      replaceElContent(target, price, formatBRL(price));
      adapter.onDone?.(container);
    });
  }
}

// ── Pass 3: generic split-price fallback ───────────────────
// Catches any site not covered by adapters where R$ and the number
// are in separate sibling elements. Uses aria-label or sibling text.

function processGenericSplit(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const val = node.nodeValue?.trim();
      if (val !== 'R$' && val !== 'R $') return NodeFilter.FILTER_SKIP;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest(`.${CLS_WRAPPER}`)) return NodeFilter.FILTER_REJECT;
      if (p.closest(`[${ATTR_EL}]`)) return NodeFilter.FILTER_REJECT;
      // Skip elements already handled by a named adapter
      if (ADAPTER_SELECTORS && p.closest(ADAPTER_SELECTORS)) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const symNodes = [];
  let sn;
  while ((sn = walker.nextNode())) symNodes.push(sn);

  for (const symNode of symNodes) {
    const symEl     = symNode.parentElement;
    const container = symEl?.parentElement;
    if (!container || container === document.body) continue;
    if (container.getAttribute(ATTR_EL)) continue;
    if (container.querySelector(`.${CLS_WRAPPER}`)) continue;

    // Strategy 1: aria-label on container or an ancestor
    let price = priceFromAria(container);

    // Strategy 2: digit-only sibling elements following the R$ element
    if (!price) {
      const parts = [];
      let sib = symEl.nextElementSibling;
      while (sib) {
        const t = sib.textContent.replace(/\s/g, '');
        if (/^\d+$/.test(t)) parts.push(t);
        else break;
        sib = sib.nextElementSibling;
      }
      if (parts.length === 1) {
        price = parseInt(parts[0]);
      } else if (parts.length >= 2) {
        price = parseInt(parts[0]) + parseInt(parts[1]) / Math.pow(10, parts[1].length);
      }
    }

    if (!price || price <= 0 || price > 1_000_000) continue;
    replaceElContent(container, price, formatBRL(price));
  }
}

// ── Full document pass ─────────────────────────────────────

function processDocument(root = document.body) {
  if (!enabled || !hourlyRate || !root) return;
  walkTextNodes(root);    // Pass 1: full price in a single text node (most sites)
  processAdapters(root);  // Pass 2: site-specific adapters (ML, Amazon, …)
  processGenericSplit(root); // Pass 3: generic R$ + sibling-number fallback
}

// ── Update / restore ───────────────────────────────────────

function updateAll() {
  document.querySelectorAll(`.${CLS_TIME}`).forEach(span => {
    const price = parseFloat(span.getAttribute('data-price'));
    if (!price) return;
    const time = priceToTime(price);
    if (time) span.textContent = formatTime(time);
  });
}

function restoreAll() {
  document.querySelectorAll(`.${CLS_WRAPPER}`).forEach(wrapper => {
    const orig = wrapper.querySelector(`.${CLS_ORIGINAL}`);
    if (!orig) return;
    wrapper.replaceWith(document.createTextNode(orig.textContent.replace(/^\(|\)$/g, '')));
  });
  document.querySelectorAll(`[${ATTR_EL}]`).forEach(el => {
    const orig = el.getAttribute(ATTR_ORIG);
    if (orig !== null) el.innerHTML = orig;
    el.removeAttribute(ATTR_EL);
    el.removeAttribute(ATTR_ORIG);
  });
}

// ── MutationObserver ───────────────────────────────────────

function startObserver() {
  if (observer) return;

  const pendingNodes = new Set();

  observer = new MutationObserver(mutations => {
    for (const mut of mutations) {
      for (const added of mut.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE) {
          const el = /** @type {Element} */ (added);
          if (
            el.classList?.contains(CLS_WRAPPER) ||
            el.classList?.contains(CLS_TIME) ||
            el.classList?.contains(CLS_ORIGINAL) ||
            el.id === 'preco-horas-style'
          ) continue;
        }
        pendingNodes.add(added);
      }
    }

    clearTimeout(debounceId);
    debounceId = setTimeout(() => {
      pendingNodes.forEach(node => {
        if (!document.contains(node)) return;
        if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
        else if (node.nodeType === Node.ELEMENT_NODE) processDocument(node);
      });
      pendingNodes.clear();
    }, Math.max(300, processDelay));
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (observer) { observer.disconnect(); observer = null; }
}

// ── Storage ────────────────────────────────────────────────

chrome.storage.onChanged.addListener(changes => {
  const wasEnabled = enabled;

  if ('hourlyRate'   in changes) hourlyRate   = changes.hourlyRate.newValue   || 0;
  if ('processDelay' in changes) processDelay = changes.processDelay.newValue ?? 1000;
  if ('enabled'      in changes) enabled      = changes.enabled.newValue !== false;

  if (!enabled) {
    stopObserver();
    clearTimeout(initTimerId);
    restoreAll();
    return;
  }

  if ('hourlyRate' in changes) {
    const hasReplacements = document.querySelector(`.${CLS_WRAPPER}, [${ATTR_EL}]`);
    if (hasReplacements) updateAll();
    else scheduleProcessDocument();
  }

  if ('enabled' in changes && enabled && !wasEnabled) {
    scheduleProcessDocument();
    startObserver();
  }
});

// ── Bootstrap ──────────────────────────────────────────────

chrome.storage.local.get(['hourlyRate', 'enabled', 'processDelay'], data => {
  hourlyRate   = data.hourlyRate   || 0;
  enabled      = data.enabled !== false;
  processDelay = data.processDelay ?? 1000;

  if (enabled && hourlyRate > 0) {
    scheduleProcessDocument();
    startObserver();
  }
});

function scheduleProcessDocument() {
  clearTimeout(initTimerId);
  if (processDelay > 0) {
    initTimerId = setTimeout(processDocument, processDelay);
  } else {
    processDocument();
  }
}
