/**
 * Gemini Chat Exporter - Content Script
 * Runs on gemini.google.com pages, handles DOM parsing and export logic
 */

// ─── Selectors (multi-strategy, resilient to updates) ────────────────────────

const SELECTORS = {
  // Conversation turn containers
  turns: [
    'message-content',
    '[data-message-author-role]',
    '.conversation-container > *',
    'chat-turn',
    'user-query',
    'model-response',
    '[class*="turn"]',
    '[class*="message"]',
    '[class*="conversation"] > *',
  ],

  // User messages
  userMessage: [
    'user-query .query-text',
    'user-query [class*="text"]',
    '[data-message-author-role="user"]',
    '[class*="user"] [class*="query"]',
    '[class*="user-query"]',
    '.user-message',
    '[class*="humanTurn"]',
    '[class*="user-turn"]',
    'query-text',
  ],

  // Model / AI responses
  modelResponse: [
    'model-response .response-content',
    'model-response [class*="response"]',
    '[data-message-author-role="model"]',
    '[data-message-author-role="assistant"]',
    '[class*="model-response"]',
    '.model-message',
    '[class*="modelTurn"]',
    '[class*="model-turn"]',
    'response-content',
  ],

  // Conversation root wrapper
  chatRoot: [
    'chat-window',
    '[class*="chat-window"]',
    'conversation-container',
    '[class*="conversation-container"]',
    '[class*="chat-container"]',
    'main',
    '[role="main"]',
  ],

  // Page/chat title
  title: [
    '[data-conversation-title]',
    '[class*="conversation-title"]',
    '[class*="chat-title"]',
    'h1',
    'title',
  ],
};

// ─── Helper: try multiple selectors, return first match ──────────────────────

function queryFirst(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

function queryAll(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const els = root.querySelectorAll(sel);
      if (els && els.length > 0) return Array.from(els);
    } catch (_) {}
  }
  return [];
}

// ─── HTML → Markdown converter ───────────────────────────────────────────────

function htmlToMarkdown(element) {
  if (!element) return '';

  // Clone to avoid mutating live DOM
  const clone = element.cloneNode(true);

  // Remove hidden / UI chrome elements
  const toRemove = clone.querySelectorAll(
    'button, [aria-hidden="true"], [class*="actions"], [class*="toolbar"], ' +
    '[class*="copy-btn"], [class*="vote"], [class*="feedback"], svg, ' +
    '.mat-icon, [class*="icon"]'
  );
  toRemove.forEach(el => el.remove());

  return nodeToMarkdown(clone).trim();
}

function nodeToMarkdown(node, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();
  const children = () =>
    Array.from(node.childNodes)
      .map(c => nodeToMarkdown(c, depth + 1))
      .join('');

  switch (tag) {
    case 'h1': return `\n# ${children()}\n\n`;
    case 'h2': return `\n## ${children()}\n\n`;
    case 'h3': return `\n### ${children()}\n\n`;
    case 'h4': return `\n#### ${children()}\n\n`;
    case 'h5': return `\n##### ${children()}\n\n`;
    case 'h6': return `\n###### ${children()}\n\n`;

    case 'p':  return `\n${children()}\n`;
    case 'br': return '\n';
    case 'hr': return '\n---\n';

    case 'strong':
    case 'b':  return `**${children()}**`;

    case 'em':
    case 'i':  return `_${children()}_`;

    case 'del':
    case 's':  return `~~${children()}~~`;

    case 'code': {
      const parent = node.parentElement;
      if (parent && parent.tagName.toLowerCase() === 'pre') {
        return children(); // handled by pre
      }
      return `\`${children()}\``;
    }

    case 'pre': {
      // Try to detect language from class
      const codeEl = node.querySelector('code');
      const langClass = (codeEl?.className || node.className || '');
      const langMatch = langClass.match(/language-(\w+)/);
      const lang = langMatch ? langMatch[1] : '';
      const code = codeEl ? codeEl.textContent : node.textContent;
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    case 'blockquote': return `\n> ${children().replace(/\n/g, '\n> ')}\n`;

    case 'a': {
      const href = node.getAttribute('href') || '';
      const text = children();
      if (!href || href === text) return text;
      return `[${text}](${href})`;
    }

    case 'img': {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || 'image';
      return `![${alt}](${src})`;
    }

    case 'ul': {
      const items = Array.from(node.children)
        .map(li => `- ${nodeToMarkdown(li, depth + 1).trim()}`)
        .join('\n');
      return `\n${items}\n`;
    }

    case 'ol': {
      const items = Array.from(node.children)
        .map((li, i) => `${i + 1}. ${nodeToMarkdown(li, depth + 1).trim()}`)
        .join('\n');
      return `\n${items}\n`;
    }

    case 'li': return children();

    case 'table': return convertTable(node);

    // Skip purely decorative/structural tags, process children
    case 'div':
    case 'span':
    case 'section':
    case 'article':
    case 'main':
    case 'aside':
    case 'header':
    case 'footer':
    case 'nav':
    case 'mark':
    case 'small':
    case 'sup':
    case 'sub':
      return children();

    // Skip non-content tags entirely
    case 'script':
    case 'style':
    case 'noscript':
    case 'svg':
    case 'button':
    case 'input':
    case 'select':
    case 'textarea':
    case 'form':
      return '';

    default:
      return children();
  }
}

function convertTable(tableEl) {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const lines = [];
  rows.forEach((row, rowIdx) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    const cellTexts = cells.map(c => nodeToMarkdown(c).trim().replace(/\|/g, '\\|'));
    lines.push('| ' + cellTexts.join(' | ') + ' |');
    if (rowIdx === 0) {
      lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
    }
  });

  return '\n' + lines.join('\n') + '\n';
}

// ─── Main extraction logic ────────────────────────────────────────────────────

function extractChatTitle() {
  const BAD = /^gemini$/i; // reject if it's just the app name

  function clean(t) {
    return (t || '').trim().replace(/\s+/g, ' ');
  }

  function good(t) {
    const s = clean(t);
    return s && s.length > 1 && s.length < 250 && !BAD.test(s) ? s : null;
  }

  // ── Strategy 1: document.title (most reliable, Gemini puts chat name here) ──
  // Possible formats:
  //   "Название чата - Gemini"
  //   "Gemini - Название чата"
  //   "Название чата | Gemini"
  //   "Название чата"
  const rawTitle = document.title;
  const stripped = rawTitle
    .replace(/\s*[-|—]\s*Gemini\s*$/i, '')
    .replace(/^Gemini\s*[-|—]\s*/i, '')
    .replace(/\s*\|\s*Gemini\s*$/i, '')
    .replace(/^Gemini\s*\|\s*/i, '')
    .trim();
  if (good(stripped)) return stripped;

  // ── Strategy 2: active / selected item in sidebar ────────────────────────
  const activeSelectors = [
    '[aria-selected="true"]',
    '[aria-current="page"]',
    '[aria-current="true"]',
    'a[href*="/app/"][class*="active"]',
    'a[href*="/app/"][class*="selected"]',
    '[class*="conversation-item"][class*="active"]',
    '[class*="chat-item"][class*="active"]',
    '[class*="history-item"][class*="active"]',
  ];
  for (const sel of activeSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      // Try aria-label first (clean), then textContent
      const t = good(el.getAttribute('aria-label')) ||
                good(el.getAttribute('title'))       ||
                good(el.textContent);
      if (t) return t;
    } catch (_) {}
  }

  // ── Strategy 3: heading tags in the conversation area ────────────────────
  for (const tag of ['h1', 'h2', 'h3']) {
    const el = document.querySelector(`main ${tag}, [class*="conversation"] ${tag}, ${tag}`);
    const t = good(el?.textContent);
    if (t) return t;
  }

  // ── Strategy 4: data-* attributes ────────────────────────────────────────
  for (const attr of ['data-conversation-title', 'data-chat-title', 'data-title']) {
    const el = document.querySelector(`[${attr}]`);
    const t = good(el?.getAttribute(attr));
    if (t) return t;
  }

  // ── Strategy 5: <title> tag raw (last resort before URL) ─────────────────
  if (good(rawTitle)) return rawTitle;

  // ── Strategy 6: URL-based fallback ───────────────────────────────────────
  const urlMatch = window.location.href.match(/\/(app|chat)\/([a-zA-Z0-9_-]{6,})/);
  if (urlMatch) return `Gemini Chat ${urlMatch[2].slice(0, 8)}`;

  return 'Gemini Chat';
}

function detectMessageRole(element) {
  // Check explicit attributes
  const role = element.getAttribute('data-message-author-role') ||
                element.getAttribute('data-role') ||
                element.getAttribute('role');

  if (role === 'user' || role === 'human') return 'user';
  if (role === 'model' || role === 'assistant') return 'model';

  // Check tag name
  const tag = element.tagName.toLowerCase();
  if (tag === 'user-query' || tag.includes('user')) return 'user';
  if (tag === 'model-response' || tag.includes('model')) return 'model';

  // Check class names
  const cls = (element.className || '').toLowerCase();
  if (cls.includes('user') || cls.includes('human') || cls.includes('query')) return 'user';
  if (cls.includes('model') || cls.includes('assistant') || cls.includes('response')) return 'model';

  return 'unknown';
}

function extractMessages() {
  const messages = [];

  // Strategy 1: Try known Gemini custom elements
  const userTurns = Array.from(document.querySelectorAll('user-query'));
  const modelTurns = Array.from(document.querySelectorAll('model-response'));

  if (userTurns.length > 0 || modelTurns.length > 0) {
    // Build interleaved list sorted by DOM position
    const allTurns = [
      ...userTurns.map(el => ({ el, role: 'user' })),
      ...modelTurns.map(el => ({ el, role: 'model' })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    for (const { el, role } of allTurns) {
      const text = htmlToMarkdown(el);
      if (text.trim()) {
        messages.push({ role, content: text.trim() });
      }
    }

    if (messages.length > 0) return messages;
  }

  // Strategy 2: Look for attribute-based selectors
  const attrTurns = document.querySelectorAll('[data-message-author-role]');
  if (attrTurns.length > 0) {
    for (const el of attrTurns) {
      const role = el.getAttribute('data-message-author-role');
      const text = htmlToMarkdown(el);
      if (text.trim()) {
        messages.push({ role, content: text.trim() });
      }
    }
    if (messages.length > 0) return messages;
  }

  // Strategy 3: Heuristic scan – look for repeating sibling groups
  const chatRoot = queryFirst(SELECTORS.chatRoot);
  if (chatRoot) {
    const children = Array.from(chatRoot.children);
    for (const child of children) {
      const role = detectMessageRole(child);
      if (role !== 'unknown') {
        const text = htmlToMarkdown(child);
        if (text.trim()) {
          messages.push({ role, content: text.trim() });
        }
      }
    }
    if (messages.length > 0) return messages;
  }

  // Strategy 4: Broad sweep – find elements with substantial text that look like chat bubbles
  const candidates = document.querySelectorAll('[class*="message"], [class*="turn"], [class*="bubble"], [class*="response"], [class*="query"]');
  const seen = new Set();
  for (const el of candidates) {
    if (seen.has(el)) continue;
    // Avoid nested matches
    if (Array.from(seen).some(s => s.contains(el))) continue;
    seen.add(el);

    const role = detectMessageRole(el);
    const text = htmlToMarkdown(el);
    if (text.trim().length > 10) {
      messages.push({ role, content: text.trim() });
    }
  }

  return messages;
}

// ─── Markdown document builder ────────────────────────────────────────────────

function buildMarkdown(title, messages) {
  const date = new Date().toLocaleDateString('ru-RU', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const lines = [
    `# ${title}`,
    '',
    `> Экспортировано из Gemini · ${date}`,
    `> URL: ${window.location.href}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? '👤 Вы' : '✨ Gemini';
    lines.push(`## ${roleLabel}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Message handler (from popup / background) ───────────────────────────────
// Guard: only register the listener once per page lifetime
if (!window.__geminiExporterListenerRegistered) {
  window.__geminiExporterListenerRegistered = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract') {
      try {
        const title = extractChatTitle();
        const messages = extractMessages();

        if (messages.length === 0) {
          sendResponse({ success: false, error: 'Не удалось найти сообщения на странице. Убедитесь, что вы открыли конкретный чат в Gemini.' });
          return;
        }

        const markdown = buildMarkdown(title, messages);
        sendResponse({
          success: true,
          title,
          markdown,
          count: messages.length,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }

      return true; // keep message channel open for async response
    }

    if (request.action === 'ping') {
      sendResponse({ alive: true });
      return true;
    }
  });
}

