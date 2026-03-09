'use strict';

const MODE_MONTHLY = 'monthly';
const MODE_HOURLY  = 'hourly';

let currentMode = MODE_MONTHLY;

// ── DOM refs ──────────────────────────────────────────────
const enabledToggle = document.getElementById('enabledToggle');
const toggleLabel   = document.getElementById('toggleLabel');
const tabMonthly    = document.getElementById('tabMonthly');
const tabHourly     = document.getElementById('tabHourly');
const salaryLabel   = document.getElementById('salaryLabel');
const salaryInput   = document.getElementById('salaryInput');
const hoursGroup    = document.getElementById('hoursGroup');
const hoursInput    = document.getElementById('hoursInput');
const delaySelect   = document.getElementById('delaySelect');
const rateDisplay   = document.getElementById('rateDisplay');
const saveBtn       = document.getElementById('saveBtn');
const statusMsg     = document.getElementById('statusMsg');

// ── Load saved settings ───────────────────────────────────
chrome.storage.local.get(
  ['enabled', 'mode', 'salary', 'hoursPerMonth', 'processDelay'],
  (data) => {
    const enabled = data.enabled !== false;
    enabledToggle.checked = enabled;
    updateToggleLabel(enabled);

    currentMode = data.mode || MODE_MONTHLY;
    applyModeUI(currentMode);

    if (data.salary)        salaryInput.value = formatInputValue(data.salary);
    if (data.hoursPerMonth) hoursInput.value  = data.hoursPerMonth;

    // Default delay: 1000ms
    const savedDelay = data.processDelay ?? 1000;
    // Select the closest option
    const opt = [...delaySelect.options].find(o => parseInt(o.value) === savedDelay);
    if (opt) opt.selected = true;

    refreshRateDisplay();
  }
);

// ── Enable / disable toggle ───────────────────────────────
enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  updateToggleLabel(enabled);
  chrome.storage.local.set({ enabled });
});

function updateToggleLabel(enabled) {
  toggleLabel.textContent = enabled ? 'Ativo' : 'Inativo';
}

// ── Mode tabs ─────────────────────────────────────────────
tabMonthly.addEventListener('click', () => switchMode(MODE_MONTHLY));
tabHourly.addEventListener('click',  () => switchMode(MODE_HOURLY));

function switchMode(mode) {
  currentMode = mode;
  applyModeUI(mode);
  refreshRateDisplay();
}

function applyModeUI(mode) {
  const isMonthly = mode === MODE_MONTHLY;
  tabMonthly.classList.toggle('active', isMonthly);
  tabHourly.classList.toggle('active', !isMonthly);
  hoursGroup.style.display = isMonthly ? 'block' : 'none';
  salaryLabel.textContent  = isMonthly ? 'Salário Mensal' : 'Valor por Hora';
  salaryInput.placeholder  = isMonthly ? '5.000,00' : '28,41';
}

// ── Live rate display ─────────────────────────────────────
salaryInput.addEventListener('input', refreshRateDisplay);
hoursInput.addEventListener('input',  refreshRateDisplay);

function refreshRateDisplay() {
  const salary = parseBRL(salaryInput.value);
  const hours  = parseInt(hoursInput.value) || 176;

  if (!salary || salary <= 0) {
    setRateDisplay('Informe seu salário acima', true);
    return;
  }

  if (currentMode === MODE_HOURLY) {
    setRateDisplay(`Você ganha ${formatBRL(salary)} por hora`, false);
    return;
  }

  const hourly = salary / hours;
  setRateDisplay(
    `Você ganha aprox. ${formatBRL(hourly)}/h  (${formatBRL(salary)}/mês ÷ ${hours}h)`,
    false
  );
}

function setRateDisplay(text, isEmpty) {
  rateDisplay.textContent = text;
  rateDisplay.classList.toggle('empty', isEmpty);
}

// ── Save ──────────────────────────────────────────────────
saveBtn.addEventListener('click', save);

function save() {
  const salary = parseBRL(salaryInput.value);
  const hours  = parseInt(hoursInput.value) || 176;

  if (!salary || salary <= 0) {
    showStatus('Por favor, informe um valor maior que zero.', 'error');
    return;
  }

  const hourlyRate  = currentMode === MODE_HOURLY ? salary : salary / hours;
  const processDelay = parseInt(delaySelect.value) || 0;

  chrome.storage.local.set(
    {
      mode:          currentMode,
      salary:        salary,
      hoursPerMonth: hours,
      hourlyRate:    hourlyRate,
      processDelay:  processDelay,
    },
    () => {
      showStatus('✔ Configurações salvas! Recarregue a página para ver as mudanças.', 'success');
    }
  );
}

// ── Helpers ───────────────────────────────────────────────

/**
 * Parse a BRL-formatted string (e.g. "1.234,56" or "1234.56" or "1234,56")
 * Returns a float or 0.
 */
function parseBRL(raw) {
  if (!raw) return 0;
  let s = raw.trim().replace(/\s/g, '');
  // If it has a comma, treat as BR format: dot = thousands, comma = decimal
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Remove any non-digit / non-dot chars
    s = s.replace(/[^\d.]/g, '');
  }
  return parseFloat(s) || 0;
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format a float as a BRL-style input string, e.g. "1.234,56" */
function formatInputValue(value) {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

let statusTimer = null;
function showStatus(msg, type) {
  clearTimeout(statusTimer);
  statusMsg.textContent  = msg;
  statusMsg.className    = `status ${type}`;
  statusTimer = setTimeout(() => {
    statusMsg.textContent = '';
    statusMsg.className   = 'status';
  }, 5000);
}
