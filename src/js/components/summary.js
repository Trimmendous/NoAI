import { element } from './dom.js';
import { renderMarkdown } from './markdown.js';

// A rendered SUMMARY.md / README.md card for a job run or session. It fills in
// when the file has been read, and stays hidden when the folder has neither.

let reader = null;
/** `read(dirs)` resolves to { name, path, text, modified } or null. */
export function setSummaryReader(read) { reader = read; }

const cache = new Map();

/** The folders to look in for a run: its own worktree first, then its project. */
export function runFolders(task, run) {
  return [run?.worktree?.workdir, run?.projectPath, task?.projectPath].filter(Boolean);
}

export function summaryCard(dirs, { refresh = false } = {}) {
  const card = element('details', 'run-summary');
  card.hidden = true;
  card.open = true;
  const key = JSON.stringify(dirs);
  if (!reader || !dirs.length) return card;
  if (refresh || !cache.has(key)) cache.set(key, reader(dirs).catch(() => null));
  void cache.get(key).then(summary => {
    if (!summary?.text?.trim()) return;
    const head = element('summary', 'run-summary-head');
    const when = summary.modified ? new Date(summary.modified * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    head.append(element('strong', '', summary.name), element('span', '', [summary.path.replace(/[\\/][^\\/]+$/, ''), when && `edited ${when}`].filter(Boolean).join(' · ')));
    card.title = summary.path;
    card.append(head, renderMarkdown(summary.text, 'run-summary-body'));
    card.hidden = false;
  });
  return card;
}
