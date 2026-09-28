/**
 * Gemini Chat Exporter — Background Service Worker
 *
 * Orchestrates "Export All Chats":
 *   1. Scans the Gemini sidebar for conversation links
 *   2. Opens each chat in a hidden background tab
 *   3. Injects content.js, extracts Markdown
 *   4. Closes the tab, repeats
 *   5. Bundles everything into a ZIP archive
 *   6. Triggers download via chrome.downloads
 *
 * Progress updates are stored in chrome.storage.session so they
 * survive popup close/reopen, and also broadcast via runtime messages
 * for live display when the popup is open.
 */

// Service Worker — no 'use strict' needed; importScripts works in global scope

importScripts('zip_writer.js');

// ─── State ────────────────────────────────────────────────────────────────────

let exportRunning = false;
let cancelRequested = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return (name || 'Gemini Chat')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Windows-illegal chars
    .replace(/\.{2,}/g, '.')               // no double-dots
    .replace(/\s+/g, ' ')                  // normalize whitespace (keep spaces)
    .trim()
    .replace(/[. ]+$/, '')                 // no trailing dots/spaces (Windows)
    .slice(0, 100) || 'Gemini Chat';
}

/**
 * Broadcast a progress/status update.
 * Saves to session storage (popup can read on open) AND
 * tries to send a live runtime message (received only if popup is open).
 */
async function broadcast(payload) {
  await chrome.storage.session.set({ exportStatus: payload });
  try {
    await chrome.runtime.sendMessage({ ...payload, _type: 'exportStatus' });
  } catch (_) { /* popup may be closed */ }
}

/** Wait for a tab to reach "complete" status, with a timeout. */
function waitForTabLoad(tabId, timeoutMs = 18000) {
  return new Promise((resolve) => {
    let done = false;

    function finish() {
      if (!done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    const timer = setTimeout(finish, timeoutMs);

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };

    // Register listener FIRST, then check current state to avoid race condition
    chrome.tabs.onUpdated.addListener(listener);

    // If tab already completed before listener was added, resolve immediately
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { finish(); return; }
      if (tab && tab.status === 'complete') finish();
    });
  });
}

/** Pause for ms milliseconds. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Sidebar scanner ──────────────────────────────────────────────────────────

/**
 * Runs inside the Gemini tab (via executeScript) to collect all
 * conversation links visible in the sidebar.
 */
function scanSidebarLinks() {
  const seen = new Map();

  // Selector strategies, broadest to narrowest
  const selectors = [
    'a[href*="/app/"]',
    'nav a[href]',
    '[class*="conversation"] a[href]',
    '[class*="chat-list"] a[href]',
    '[class*="history"] a[href]',
    '[class*="sidebar"] a[href]',
    'aside a[href]',
  ];

  const CHAT_URL_RE = /gemini\.google\.com\/(app|chat)\/([a-zA-Z0-9_-]{6,})/;

  for (const sel of selectors) {
    let els;
    try { els = document.querySelectorAll(sel); } catch (_) { continue; }

    for (const el of els) {
      const href = el.href || el.getAttribute('href') || '';
      if (!CHAT_URL_RE.test(href)) continue;
      if (seen.has(href)) continue;

      // Collect title from the element or its ancestors
      let title = '';
      const candidates = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.textContent,
      ];
      for (const c of candidates) {
        const t = (c || '').trim();
        if (t && t.length > 1 && t.length < 250) { title = t; break; }
      }

      if (!title) {
        // Walk up the DOM tree
        let node = el.parentElement;
        for (let i = 0; i < 6 && node; i++) {
          const t = (node.textContent || '').trim();
          if (t && t.length > 1 && t.length < 250) { title = t; break; }
          node = node.parentElement;
        }
      }

      seen.set(href, {
        url: href,
        title: (title || 'Untitled Chat').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }

  return Array.from(seen.values());
}

// ─── Per-chat extraction ──────────────────────────────────────────────────────

async function extractChatFromTab(tabId) {
  // Inject content script (idempotent – duplicate injection is harmless)
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) { /* may already be injected */ }

  // Give the SPA time to hydrate
  await sleep(3000);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    chrome.tabs.sendMessage(tabId, { action: 'extract' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response || null);
    });
  });
}

// ─── ZIP builder ──────────────────────────────────────────────────────────────

function buildIndexMd(chats, date) {
  return [
    '# Gemini Chats — Export Index',
    '',
    `> **Дата экспорта:** ${date}`,
    `> **Всего чатов:** ${chats.length}`,
    '',
    '---',
    '',
    '## Содержание',
    '',
    ...chats.map((c, i) => `${i + 1}. [${c.title}](./${sanitizeFilename(c.title)}.md)`),
    '',
  ].join('\n');
}

function buildZip(chats) {
  const date = new Date().toLocaleDateString('ru-RU', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const files = [
    { name: 'INDEX.md', content: buildIndexMd(chats, date) },
    ...chats.map(c => ({ name: sanitizeFilename(c.title) + '.md', content: c.markdown })),
  ];

  return ZIP_WRITER.createZip(files);
}

// ─── Download helper ──────────────────────────────────────────────────────────

function uint8ToBase64(data) {
  // Chunked to avoid call stack overflow on large buffers
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function downloadZip(zipData, filename) {
  const base64 = uint8ToBase64(zipData);
  const dataUrl = `data:application/zip;base64,${base64}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function runExportAll(sourceTabId) {
  if (exportRunning) {
    await broadcast({ phase: 'error', text: 'Экспорт уже запущен.' });
    return;
  }

  exportRunning = true;
  cancelRequested = false;

  try {
    // ── Step 1: Scan sidebar ─────────────────────────────────────────────────
    await broadcast({ phase: 'scanning', text: 'Сканируем сайдбар Gemini…', current: 0, total: 0 });

    let links = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
        func: scanSidebarLinks,
      });
      links = results?.[0]?.result || [];
    } catch (err) {
      throw new Error(`Не удалось сканировать страницу: ${err.message}`);
    }

    if (links.length === 0) {
      throw new Error(
        'Чаты не найдены. Убедитесь, что вы находитесь на gemini.google.com ' +
        'и боковая панель содержит историю чатов (прокрутите её вниз, чтобы загрузить больше).'
      );
    }

    await broadcast({
      phase: 'extracting',
      text: `Найдено ${links.length} чатов. Начинаем…`,
      current: 0,
      total: links.length,
    });

    // ── Step 2: Extract each chat ────────────────────────────────────────────
    const collected = [];

    for (let i = 0; i < links.length; i++) {
      if (cancelRequested) break;

      const link = links[i];

      await broadcast({
        phase: 'extracting',
        text: link.title,
        current: i + 1,
        total: links.length,
      });

      let newTab;
      try {
        newTab = await chrome.tabs.create({ url: link.url, active: false });
        await waitForTabLoad(newTab.id);

        const result = await extractChatFromTab(newTab.id);

        if (result?.success && result.markdown?.trim()) {
          collected.push({
            title: result.title || link.title,
            markdown: result.markdown,
          });
        } else {
          console.warn('[GeminiExporter] Empty or failed extract for:', link.url);
        }
      } catch (err) {
        console.warn('[GeminiExporter] Error on tab for', link.url, err);
      } finally {
        if (newTab?.id) {
          try { await chrome.tabs.remove(newTab.id); } catch (_) {}
        }
      }

      // Brief pause between tabs
      await sleep(400);
    }

    if (collected.length === 0) {
      throw new Error('Не удалось извлечь содержимое ни одного чата. Попробуйте обновить страницу Gemini.');
    }

    // ── Step 3: Build & download ZIP ─────────────────────────────────────────
    await broadcast({
      phase: 'building',
      text: `Создаём ZIP-архив (${collected.length} чатов)…`,
      current: collected.length,
      total: collected.length,
    });

    const zipData = buildZip(collected);
    const filename = `gemini-chats-${new Date().toISOString().slice(0, 10)}.zip`;

    await downloadZip(zipData, filename);

    await broadcast({
      phase: 'done',
      text: `Готово! Скачано ${collected.length} чатов`,
      filename,
      count: collected.length,
      current: collected.length,
      total: collected.length,
    });

  } catch (err) {
    console.error('[GeminiExporter] Export all failed:', err);
    await broadcast({ phase: 'error', text: err.message || 'Неизвестная ошибка' });
  } finally {
    exportRunning = false;
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'exportAll') {
    runExportAll(request.tabId);
    sendResponse({ started: true });
    return true;
  }

  if (request.action === 'cancelExport') {
    cancelRequested = true;
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'getExportStatus') {
    chrome.storage.session.get('exportStatus', (data) => {
      sendResponse(data.exportStatus || null);
    });
    return true;
  }
});
