import { element } from './dom.js';

// Markdown for agent-written text: chat replies, transcripts, job output and
// the digest. Built from DOM nodes only; agent text is never inserted as HTML.
// Long lines wrap instead of scrolling sideways.

let linkHandler = null;
/** `handler(url)` opens http(s) links outside the app (the system browser). */
export function setLinkHandler(handler) { linkHandler = handler; }

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(label, href) {
  // Only in-app routes (#session=…) and web links; anything else stays plain text.
  if (!/^(#[a-z]+(=|$)|https?:\/\/)/i.test(href)) return document.createTextNode(label);
  const anchor = element('a', 'md-link');
  anchor.href = href;
  // A bare URL is its own label; parsing it again would link it forever.
  anchor.append(label === href ? document.createTextNode(label) : inline(label));
  if (/^https?:/i.test(href)) {
    anchor.rel = 'noreferrer';
    anchor.title = href;
    anchor.addEventListener('click', event => {
      event.preventDefault();
      if (linkHandler) void linkHandler(href);
      else window.open(href, '_blank', 'noopener');
    });
  }
  return anchor;
}

function inline(text) {
  const fragment = document.createDocumentFragment();
  for (const part of String(text).split(INLINE)) {
    if (!part) continue;
    let match;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) fragment.append(element('code', '', part.slice(1, -1)));
    else if (part.length > 4 && (/^\*\*.*\*\*$/.test(part) || /^__.*__$/.test(part))) { const node = element('strong'); node.append(inline(part.slice(2, -2))); fragment.append(node); }
    else if (part.length > 4 && /^~~.*~~$/.test(part)) { const node = element('del'); node.append(inline(part.slice(2, -2))); fragment.append(node); }
    else if (part.length > 2 && /^\*[^*].*\*$/.test(part)) { const node = element('em'); node.append(inline(part.slice(1, -1))); fragment.append(node); }
    else if ((match = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part))) fragment.append(link(match[1], match[2]));
    else if ((match = /^<(https?:\/\/[^>]+)>$/.exec(part))) fragment.append(link(match[1], match[1]));
    else if (/^https?:\/\//.test(part)) fragment.append(link(part, part));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}

// Paragraph lines keep their line breaks, as chat replies expect.
function lines(texts) {
  const fragment = document.createDocumentFragment();
  texts.forEach((text, index) => {
    if (index) fragment.append(element('br'));
    fragment.append(inline(text));
  });
  return fragment;
}

function codeBlock(language, code) {
  const wrapper = element('div', 'code-block');
  const header = element('div', 'code-header');
  header.append(element('span', '', language || 'code'));
  const copy = element('button', 'text-button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    } catch { copy.textContent = 'Select to copy'; }
  });
  header.append(copy);
  const pre = element('pre');
  pre.append(element('code', '', code));
  wrapper.append(header, pre);
  return wrapper;
}

function cells(row) {
  return row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

const isTableDivider = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const startsBlock = (line, next) => /^\s*(#{1,6}\s|```|~~~|>|([-*_])\s*\2\s*\2[\s\2]*$)/.test(line) || LIST.test(line) || (line.includes('|') && isTableDivider(next || ''));

function list(source, start) {
  const first = LIST.exec(source[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const node = element(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) node.start = parseInt(first[2], 10);
  let index = start;
  let item = null;
  while (index < source.length) {
    const line = source[index];
    const match = LIST.exec(line);
    if (match && match[1].length === indent) {
      item = element('li');
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3]);
      if (task) {
        item.className = 'md-task';
        const box = element('span', `md-check${task[1].trim() ? ' is-done' : ''}`, task[1].trim() ? '✓' : '');
        box.setAttribute('aria-label', task[1].trim() ? 'Done' : 'Not done');
        item.append(box, inline(task[2]));
      } else item.append(inline(match[3]));
      node.append(item);
      index += 1;
    } else if (match && match[1].length > indent && item) {
      const [child, next] = list(source, index);
      item.append(child);
      index = next;
    } else if (!match && line.trim() && item && /^\s{2,}/.test(line)) {
      item.append(element('br'), inline(line.trim()));
      index += 1;
    } else break;
  }
  return [node, index];
}

export function renderMarkdown(text, className = '') {
  const root = element('div', `markdown${className ? ` ${className}` : ''}`);
  const source = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < source.length) {
    const line = source[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\s*(```|~~~)\s*([^\s`]*)/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < source.length && !source[index].trim().startsWith(fence[1])) body.push(source[index++]);
      index += 1;
      root.append(codeBlock(fence[2], body.join('\n')));
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const node = element(`h${Math.min(heading[1].length + 2, 6)}`);
      node.append(inline(heading[2]));
      root.append(node);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { root.append(element('hr')); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < source.length && /^\s*>/.test(source[index])) quoted.push(source[index++].replace(/^\s*>\s?/, ''));
      const quote = element('blockquote');
      quote.append(...renderMarkdown(quoted.join('\n')).childNodes);
      root.append(quote);
      continue;
    }
    if (line.includes('|') && isTableDivider(source[index + 1] || '')) {
      const wrap = element('div', 'markdown-table-wrap');
      const table = element('table', 'markdown-table');
      const head = element('thead');
      const headRow = element('tr');
      for (const cell of cells(line)) { const th = element('th'); th.scope = 'col'; th.append(inline(cell)); headRow.append(th); }
      head.append(headRow);
      const body = element('tbody');
      index += 2;
      while (index < source.length && source[index].includes('|') && source[index].trim()) {
        const tr = element('tr');
        for (const cell of cells(source[index])) { const td = element('td'); td.append(inline(cell)); tr.append(td); }
        body.append(tr);
        index += 1;
      }
      table.append(head, body);
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    if (LIST.test(line)) {
      const [node, next] = list(source, index);
      root.append(node);
      index = next;
      continue;
    }
    const paragraph = [];
    while (index < source.length && source[index].trim() && (!paragraph.length || !startsBlock(source[index], source[index + 1]))) {
      paragraph.push(source[index].trim());
      index += 1;
    }
    const p = element('p');
    p.append(lines(paragraph));
    root.append(p);
  }
  return root;
}
