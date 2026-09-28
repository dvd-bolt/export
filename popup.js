/**
 * Gemini Chat Exporter — Popup Script (v1.1)
 *
 * Handles:
 *  - Single chat export (current tab)
 *  - Export All Chats (delegates to background service worker)
 *  - Progress display from background messages
 *  - Preview, copy to clipboard, re-download
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const statusIcon      = $('statusIcon');
const statusText      = $('statusText');
const statusHint      = $('statusHint');

const progressBlock   = $('progressBlock');
const progressLabel   = $('progressLabel');
const progressCounter = $('progressCounter');
const progressFill    = $('progressFill');
const progressGlow    = $('progressGlow');
const progressHint    = $('progressHint');

const previewArea     = $('previewArea');
const previewStats    = $('previewStats');
const previewContent  = $('previewContent');

const exportBtn       = $('exportBtn');
const exportBtnText   = $('exportBtnText');
const exportAllBtn    = $('exportAllBtn');
const exportAllBtnText= $('exportAllBtnText');
const cancelBtn       = $('cancelBtn');
const secondaryActions= $('secondaryActions');
const copyBtn         = $('copyBtn');
const downloadBtn     = $('downloadBtn');
const toast           = $('toast');

// ─── State ────────────────────────────────────────────────────────────────────

let lastMarkdown = '';
let lastTitle    = 'Gemini Chat';
let exportAllRunning = false;

// ─── Status helper ────────────────────────────────────────────────────────────

const STATUS_ICONS = {
  idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  loading: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  all: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
};

function setStatus(state, text, hint = '') {
  statusIcon.className = `status-icon ${state}`;
  statusIcon.innerHTML = STATUS_ICONS[state] || STATUS_ICONS.idle;
  statusText.textContent = text;
  statusHint.textContent = hint;
}

// ─── Progress helpers ─────────────────────────────────────────────────────────

function showProgress(label, current, total, hint = '') {
  progressBlock.classList.remove('hidden');
  progressLabel.textContent   = label;
  progressHint.textContent    = hint;

  if (total > 0) {
    const pct = Math.round((current / total) * 100);
    progressFill.style.width = `${pct}%`;
    progressGlow.style.width = `${pct}%`;
    progressCounter.textContent = `${current} / ${total}`;
  } else {
    progressFill.style.width = '0%';
    progressGlow.style.width = '0%';
    progressCounter.textContent = '';
  }
}

function hideProgress() {
  progressBlock.classList.add('hidden');
}

// ─── Preview helper ───────────────────────────────────────────────────────────

function showPreview(markdown, count) {
  previewStats.innerHTML = `
    <span class="stat-chip">${count} сообщ.</span>
    <span class="stat-chip">${(markdown.length / 1024).toFixed(1)} KB</span>
  `;
  const preview = markdown.slice(0, 500) + (markdown.length > 500 ? '\n…' : '');
  previewContent.textContent = preview;
  previewArea.classList.remove('hidden');
  secondaryActions.classList.remove('hidden');
}

function hidePreview() {
  previewArea.classList.add('hidden');
  secondaryActions.classList.add('hidden');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  });
}

// ─── Filename sanitizer ───────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return (name || 'Gemini Chat')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Windows-illegal chars
    .replace(/\.{2,}/g, '.')               // no double-dots
    .replace(/\s+/g, ' ')                  // normalize whitespace (keep spaces)
    .trim()
    .replace(/[. ]+$/, '')                 // no trailing dots/spaces (Windows)
    .slice(0, 100) || 'Gemini Chat';
}

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadMarkdown(markdown, title) {
  const filename = sanitizeFilename(title) + '.md';
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
    if (chrome.runtime.lastError) {
      showToast('Ошибка при скачивании', 'error');
    } else {
      showToast(`Сохранено: ${filename}`);
    }
  });
}

// ─── Export All — progress receiver ──────────────────────────────────────────

function applyExportAllStatus(status) {
  if (!status) return;

  const { phase, text, current = 0, total = 0, filename, count } = status;

  switch (phase) {
    case 'scanning':
      setStatus('all', 'Сканируем чаты…', text);
      showProgress('Поиск в сайдбаре…', 0, 0, 'Определяем количество чатов');
      break;

    case 'extracting':
      setStatus('all', `Экспорт ${current}/${total}`, text);
      showProgress(text, current, total, 'Фоновые вкладки открываются и закрываются автоматически');
      break;

    case 'building':
      setStatus('all', 'Создаём архив…', text);
      showProgress(text, current, total, 'Упаковываем в ZIP…');
      break;

    case 'done':
      exportAllRunning = false;
      setStatus('success', `Готово! Скачано ${count} чатов`, `Файл: ${filename}`);
      showProgress('Завершено', total, total, `ZIP-архив с ${count} файлами скачан`);
      cancelBtn.classList.add('hidden');
      exportAllBtn.disabled = false;
      exportBtn.disabled = false;
      exportAllBtnText.textContent = 'Все чаты → ZIP';
      showToast(`Скачано ${count} чатов!`);
      break;

    case 'error':
      exportAllRunning = false;
      setStatus('error', 'Ошибка экспорта', text);
      hideProgress();
      cancelBtn.classList.add('hidden');
      exportAllBtn.disabled = false;
      exportBtn.disabled = false;
      exportAllBtnText.textContent = 'Все чаты → ZIP';
      break;
  }
}

// ─── Listen for live progress messages from background ────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg._type === 'exportStatus') {
    applyExportAllStatus(msg);
  }
});

// ─── Single chat export ───────────────────────────────────────────────────────

async function runSingleExport() {
  exportBtn.disabled    = true;
  exportAllBtn.disabled = true;
  exportBtnText.textContent = 'Извлечение…';
  hidePreview();
  hideProgress();

  setStatus('loading', 'Анализируем страницу…', 'Читаем DOM чата Gemini');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) throw new Error('Не удалось получить активную вкладку.');

    if (!tab.url?.includes('gemini.google.com')) {
      setStatus('warning', 'Не та страница', 'Перейдите на gemini.google.com и откройте нужный чат.');
      exportBtnText.textContent = 'Текущий чат → .md';
      exportBtn.disabled = false;
      exportAllBtn.disabled = false;
      return;
    }

    // Ensure content script is injected
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) {}

    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: 'extract' }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });

    if (!response?.success) throw new Error(response?.error || 'Неизвестная ошибка');

    lastMarkdown = response.markdown;
    lastTitle    = response.title;

    setStatus('success', 'Чат успешно извлечён!', `${response.count} сообщений`);
    showPreview(response.markdown, response.count);
    downloadMarkdown(response.markdown, response.title);

  } catch (err) {
    setStatus('error', 'Ошибка', err.message || 'Попробуйте обновить страницу Gemini.');
    exportBtnText.textContent = 'Попробовать снова';
  } finally {
    exportBtn.disabled    = false;
    exportAllBtn.disabled = false;
    exportBtnText.textContent = exportBtnText.textContent === 'Извлечение…'
      ? 'Текущий чат → .md'
      : exportBtnText.textContent;
  }
}

// ─── Export All chats ─────────────────────────────────────────────────────────

async function runExportAll() {
  if (exportAllRunning) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('gemini.google.com')) {
    setStatus('warning', 'Откройте Gemini', 'Перейдите на gemini.google.com, убедитесь, что сайдбар с чатами виден.');
    return;
  }

  exportAllRunning = true;
  exportAllBtn.disabled = true;
  exportBtn.disabled    = true;
  exportAllBtnText.textContent = 'Экспорт запущен…';
  cancelBtn.classList.remove('hidden');

  hidePreview();

  // Show initial progress
  setStatus('all', 'Запуск экспорта всех чатов', 'Сканируем боковую панель…');
  showProgress('Инициализация…', 0, 0, 'Фоновые вкладки открываются и закрываются автоматически');

  // Delegate to background
  chrome.runtime.sendMessage({ action: 'exportAll', tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError || !res?.started) {
      exportAllRunning = false;
      exportAllBtn.disabled = false;
      exportBtn.disabled    = false;
      exportAllBtnText.textContent = 'Все чаты → ZIP';
      cancelBtn.classList.add('hidden');
      setStatus('error', 'Не удалось запустить', 'Перезагрузите расширение и попробуйте снова.');
      hideProgress();
    }
  });
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancelExport' }, () => {
    setStatus('warning', 'Отмена…', 'Дожидаемся завершения текущей вкладки');
    cancelBtn.disabled = true;
    showToast('Отмена запущена', 'error');
  });
});

// ─── Secondary actions ────────────────────────────────────────────────────────

copyBtn.addEventListener('click', async () => {
  if (!lastMarkdown) return;
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    showToast('Скопировано в буфер обмена!');
  } catch {
    showToast('Ошибка копирования', 'error');
  }
});

downloadBtn.addEventListener('click', () => {
  if (lastMarkdown) downloadMarkdown(lastMarkdown, lastTitle);
});

// ─── Wire up main buttons ─────────────────────────────────────────────────────

exportBtn.addEventListener('click', runSingleExport);
exportAllBtn.addEventListener('click', runExportAll);

// ─── Init: restore background export status if running ───────────────────────

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isGemini = tab?.url?.includes('gemini.google.com');

    // Check if a background export is in progress
    chrome.runtime.sendMessage({ action: 'getExportStatus' }, (status) => {
      if (status && ['scanning', 'extracting', 'building'].includes(status.phase)) {
        // Restore running state
        exportAllRunning = true;
        exportAllBtn.disabled = true;
        exportBtn.disabled    = true;
        cancelBtn.classList.remove('hidden');
        exportAllBtnText.textContent = 'Экспорт запущен…';
        applyExportAllStatus(status);
      } else if (status?.phase === 'done') {
        applyExportAllStatus(status);
      } else if (status?.phase === 'error') {
        applyExportAllStatus(status);
      } else {
        // Idle default
        if (isGemini) {
          const inChat = tab.url.match(/gemini\.google\.com\/(app|chat)\//);
          setStatus('idle',
            inChat ? 'Готов к экспорту' : 'Gemini обнаружен',
            inChat
              ? 'Нажмите кнопку для экспорта текущего чата или всех сразу'
              : 'Откройте конкретный чат для экспорта одного, или жмите «Все чаты»'
          );
        } else {
          setStatus('warning', 'Откройте Gemini', 'Перейдите на gemini.google.com');
          exportBtn.disabled    = true;
          exportAllBtn.disabled = true;
        }
      }
    });
  } catch (_) {}
})();
