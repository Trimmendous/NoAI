import { element } from './dom.js';

// Minimal Markdown for agent-written reports: headings, lists, tables, **bold**,
// `code` and paragraphs. Built from DOM nodes only; never inserts HTML.
function inline(text) {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) fragment.append(element('strong', '', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) fragment.append(element('code', '', part.slice(1, -1)));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}

function cells(row) {
  return row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

const isTableDivider = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function renderMarkdown(text) {
  const root = element('div', 'markdown');
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^```/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      const pre = element('pre');
      pre.append(element('code', '', body.join('\n')));
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const node = element(`h${Math.min(heading[1].length + 2, 6)}`);
      node.append(inline(heading[2]));
      root.append(node);
      index += 1;
      continue;
    }
    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const wrap = element('div', 'markdown-table-wrap');
      const table = element('table', 'markdown-table');
      const head = element('thead');
      const headRow = element('tr');
      for (const cell of cells(line)) { const th = element('th'); th.scope = 'col'; th.append(inline(cell)); headRow.append(th); }
      head.append(headRow);
      const body = element('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const tr = element('tr');
        for (const cell of cells(lines[index])) { const td = element('td'); td.append(inline(cell)); tr.append(td); }
        body.append(tr);
        index += 1;
      }
      table.append(head, body);
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = element(ordered ? 'ol' : 'ul');
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        const item = element('li');
        item.append(inline(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, '')));
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[index])
      && !(lines[index].includes('|') && isTableDivider(lines[index + 1] || ''))) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const p = element('p');
    p.append(inline(paragraph.join(' ')));
    root.append(p);
  }
  return root;
}
