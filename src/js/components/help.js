import { element } from './dom.js';
import { renderMarkdown } from './markdown.js';

// Help: articles in src/help/*.md, shown with the app's Markdown renderer.
// It opens on the article for the page you came from, and searches them all.

export const HELP_SECTIONS = [
  { id: 'getting-started', title: 'Getting started', subtitle: 'What Noai is and where things are', tile: 'var(--tile-home)', icon: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z' },
  { id: 'chat', title: 'Chat', subtitle: 'Folders, tabs, split panes, windows', tile: 'var(--tile-chat)', icon: 'M5 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3v-14a2 2 0 0 1 2-2z' },
  { id: 'jobs', title: 'Jobs', subtitle: 'Scheduling, editing, retrying', tile: 'var(--tile-jobs)', icon: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16' },
  { id: 'changes', title: 'Changes', subtitle: 'Reviewing what jobs changed', tile: '#34aadc', icon: 'M6 4v16M18 8a3 3 0 1 0 0-.1M6 14q8 0 12-4' },
  { id: 'plans', title: 'Plans and notifications', subtitle: 'Limits, budget, sleep', tile: 'var(--tile-accounts)', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2' },
  { id: 'plugins', title: 'Plugins', subtitle: 'Using and writing plugins', tile: 'var(--tile-models)', icon: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4' },
  { id: 'shortcuts', title: 'Keyboard shortcuts', subtitle: 'Faster ways to get around', tile: 'var(--tile-settings)', icon: 'M3 7h18v11H3zM7 11h1M11 11h1M15 11h1M7 15h10' },
  { id: 'troubleshooting', title: 'Troubleshooting', subtitle: 'When something isn’t right', tile: 'var(--tile-alert)', icon: 'M12 8v5M12 16.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
];

/** The article that matches a page of the app. */
export function sectionForView(view) {
  return { chat: 'chat', jobs: 'jobs', job: 'jobs', 'job-conversation': 'jobs', changes: 'changes', home: 'plans', accounts: 'plans', settings: 'plugins', plugin: 'plugins' }[view] || 'getting-started';
}

/** Matches `query` against articles; returns [{ id, title, snippet }] with the best first. */
export function searchHelp(texts, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return HELP_SECTIONS.map(section => {
    const text = (texts[section.id] || '').replace(/[#*`|>-]+/g, ' ').replace(/\s+/g, ' ');
    const lower = text.toLowerCase();
    if (!words.every(word => lower.includes(word) || section.title.toLowerCase().includes(word))) return null;
    const score = words.reduce((sum, word) => sum + (section.title.toLowerCase().includes(word) ? 10 : 0) + lower.split(word).length - 1, 0);
    let at = Math.max(0, lower.indexOf(words[0]) - 60);
    if (at) at = text.indexOf(' ', at) + 1 || at; // start on a whole word
    const snippet = `${at ? '…' : ''}${text.slice(at, at + 170).trim()}…`;
    return { id: section.id, title: section.title, snippet, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

function svgIcon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export function initHelp({ nav, article, search, results }) {
  const texts = {};
  let current = 'getting-started';

  async function text(id) {
    if (texts[id] === undefined) {
      try { texts[id] = await (await fetch(`help/${id}.md`)).text(); }
      catch { texts[id] = '# Help unavailable\n\nThis article could not be loaded.'; }
    }
    return texts[id];
  }

  nav.replaceChildren(...HELP_SECTIONS.map(section => {
    const button = element('button', 'settings-nav-item');
    button.type = 'button';
    button.dataset.help = section.id;
    const tile = element('span', 'ui-tile');
    tile.style.setProperty('--tile', section.tile);
    tile.setAttribute('aria-hidden', 'true');
    tile.append(svgIcon(section.icon));
    const copy = element('span', 'settings-nav-copy');
    copy.append(element('strong', '', section.title), element('small', '', section.subtitle));
    button.append(tile, copy);
    button.addEventListener('click', () => { search.value = ''; void open(section.id); });
    return button;
  }));

  async function open(id) {
    current = HELP_SECTIONS.some(section => section.id === id) ? id : 'getting-started';
    nav.querySelectorAll('[data-help]').forEach(button => {
      const selected = button.dataset.help === current && !search.value.trim();
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    });
    results.hidden = true;
    article.hidden = false;
    const body = await text(current);
    if (current !== id && HELP_SECTIONS.some(section => section.id === id)) return;
    article.replaceChildren(renderMarkdown(body, 'help-article'));
  }

  // Search loads every article once, then matches as you type.
  search.addEventListener('input', async () => {
    const query = search.value.trim();
    if (!query) { void open(current); return; }
    await Promise.all(HELP_SECTIONS.map(section => text(section.id)));
    if (search.value.trim() !== query) return;
    const found = searchHelp(texts, query);
    nav.querySelectorAll('[data-help]').forEach(button => button.classList.remove('is-active'));
    article.hidden = true;
    results.hidden = false;
    results.replaceChildren(...(found.length ? found.map(item => {
      const row = element('button', 'help-result');
      row.type = 'button';
      row.append(element('strong', '', item.title), element('span', '', item.snippet));
      row.addEventListener('click', () => { search.value = ''; void open(item.id); });
      return row;
    }) : [element('p', 'ui-list-empty', `Nothing in Help matches “${query}”.`)]));
  });

  return { open, current: () => current };
}
