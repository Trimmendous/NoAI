import { element } from './dom.js';
import { agentTile, group, pill, relativeTime, row } from './ui.js';

// Changes: what jobs did on their own git worktrees, waiting for you to merge,
// open a pull request for, or discard. The diff is shown file by file.

const $ = selector => document.querySelector(selector);
const REVIEW = { pending: ['Ready to review', 'accent'], merged: ['Merged', 'good'], published: ['Pull request', 'good'], discarded: ['Discarded', 'muted'], running: ['Working', 'warn'] };
const MAX_LINES = 1500;

/** Splits a unified diff into files: { path, added, removed, lines }. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      file = { path: match ? match[1] : line.slice(11), added: 0, removed: 0, lines: [], status: 'modified' };
      files.push(file);
    } else if (!file) continue;
    else if (line.startsWith('new file')) file.status = 'added';
    else if (line.startsWith('deleted file')) file.status = 'deleted';
    else if (line.startsWith('rename to ')) { file.status = 'renamed'; file.path = line.slice(10); }
    else if (line.startsWith('Binary files')) file.lines.push({ kind: 'note', text: 'Binary file changed' });
    else if (line.startsWith('@@')) file.lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+') && !line.startsWith('+++')) { file.added += 1; file.lines.push({ kind: 'add', text: line.slice(1) }); }
    else if (line.startsWith('-') && !line.startsWith('---')) { file.removed += 1; file.lines.push({ kind: 'del', text: line.slice(1) }); }
    else if (line.startsWith(' ')) file.lines.push({ kind: 'ctx', text: line.slice(1) });
    else if (line.startsWith('…')) file.lines.push({ kind: 'note', text: line });
  }
  return files;
}

function renderFile(file, open) {
  const box = element('details', `diff-file is-${file.status}`);
  box.open = open;
  const summary = element('summary', 'diff-file-head');
  summary.append(element('span', 'diff-path', file.path), element('span', 'diff-counts'));
  summary.lastChild.append(element('span', 'diff-added', `+${file.added}`), element('span', 'diff-removed', `−${file.removed}`));
  if (file.status !== 'modified') summary.append(pill(file.status[0].toUpperCase() + file.status.slice(1), file.status === 'deleted' ? 'bad' : 'muted'));
  const body = element('div', 'diff-lines');
  const draw = limit => {
    body.replaceChildren(...file.lines.slice(0, limit).map(line => {
      const node = element('div', `diff-line is-${line.kind}`);
      node.append(element('span', 'diff-sign', line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''), element('code', '', line.text || ' '));
      return node;
    }));
    if (file.lines.length > limit) {
      const more = element('button', 'text-button diff-more', `Show ${file.lines.length - limit} more lines`);
      more.type = 'button';
      more.addEventListener('click', () => draw(Infinity));
      body.append(more);
    }
  };
  // Drawn when first opened, so a large change doesn't slow the page down.
  let drawn = false;
  const ensure = () => { if (box.open && !drawn) { drawn = true; draw(MAX_LINES); } };
  box.addEventListener('toggle', ensure);
  box.append(summary, body);
  ensure();
  return box;
}

export function initChanges({ native, list, diff, review, openLink, toast, onCount }) {
  let items = [], selected = null, busy = false;
  const view = $('#changes-content');

  async function refresh() {
    if (!native) { items = []; render(); return; }
    try { items = await list(); }
    catch (error) { toast(`Could not load changes: ${String(error)}`, 'error'); }
    onCount(items.filter(item => item.worktree?.review === 'pending').length);
    if (selected) selected = items.find(item => item.runId === selected.runId) || null;
    render();
  }

  function stats(tree) {
    return `${tree.files} file${tree.files === 1 ? '' : 's'} · +${tree.insertions} −${tree.deletions}`;
  }

  function render() {
    if (selected) { void renderDetail(selected); return; }
    const pending = items.filter(item => item.worktree?.review === 'pending');
    const done = items.filter(item => ['merged', 'published', 'discarded'].includes(item.worktree?.review)).slice(0, 20);
    const asRow = item => row({
      leading: agentTile(item.harness || '', item.harness || ''),
      title: item.title || 'Job',
      subtitle: [item.worktree.branch, stats(item.worktree), relativeTime(item.finishedAt || item.startedAt)].join(' · '),
      trailing: [pill(...(REVIEW[item.worktree.review] || [item.worktree.review, 'muted']))],
      onClick: () => { selected = item; render(); $('.main-content').scrollTop = 0; },
    });
    const fragment = document.createDocumentFragment();
    if (!native) fragment.append(element('p', 'ui-list-empty', 'Changes need the Noai desktop app.'));
    else if (!items.length) {
      const empty = element('div', 'scheduled-empty-state');
      empty.append(element('h3', '', 'Nothing to review'), element('p', '', 'Jobs set to "work on a separate copy" make their changes on their own git branch. When a run finishes, its changes show up here for you to merge, open a pull request for, or discard.'));
      fragment.append(empty);
    } else {
      fragment.append(group(`Waiting for review${pending.length ? ` · ${pending.length}` : ''}`, pending.length ? pending.map(asRow) : [element('p', 'ui-list-empty', 'All caught up.')]));
      if (done.length) fragment.append(group('Recently handled', done.map(asRow)));
    }
    view.replaceChildren(fragment);
  }

  async function act(item, action, button) {
    if (busy) return;
    busy = true;
    const label = button.textContent;
    button.textContent = action === 'publish' ? 'Pushing…' : action === 'merge' ? 'Merging…' : 'Discarding…';
    view.querySelectorAll('.changes-actions button').forEach(node => { node.disabled = true; });
    try {
      const result = await review(item.runId, action);
      if (result?.url) await openLink(result.url);
      toast(action === 'merge' ? `Merged into ${item.worktree.target || 'your branch'}.` : action === 'publish' ? 'Branch pushed. The pull request page is open.' : 'Changes discarded.');
      await refresh();
    } catch (error) {
      toast(String(error).replace(/^Error: /, ''), 'error');
      button.textContent = label;
      view.querySelectorAll('.changes-actions button').forEach(node => { node.disabled = false; });
    } finally { busy = false; }
  }

  async function renderDetail(item) {
    const tree = item.worktree;
    const back = element('button', 'secondary-button', '← All changes');
    back.type = 'button';
    back.addEventListener('click', () => { selected = null; render(); });
    const head = element('div', 'changes-head');
    const copy = element('div');
    copy.append(element('h3', '', item.title || 'Job'), element('p', '', [`Branch ${tree.branch}`, tree.target ? `from ${tree.target}` : '', stats(tree), relativeTime(item.finishedAt || item.startedAt)].filter(Boolean).join(' · ')));
    head.append(copy, pill(...(REVIEW[tree.review] || [tree.review, 'muted'])));
    const actions = element('div', 'changes-actions');
    if (tree.review === 'pending') {
      const merge = element('button', 'primary-button', `Merge into ${tree.target || 'current branch'}`);
      const publish = element('button', 'secondary-button', 'Open pull request');
      const discard = element('button', 'secondary-button is-destructive', 'Discard');
      for (const node of [merge, publish, discard]) node.type = 'button';
      merge.addEventListener('click', () => void act(item, 'merge', merge));
      publish.addEventListener('click', () => void act(item, 'publish', publish));
      discard.addEventListener('click', () => {
        if (!discard.classList.contains('is-confirming')) {
          discard.classList.add('is-confirming'); discard.textContent = 'Confirm discard';
          setTimeout(() => { if (discard.isConnected) { discard.classList.remove('is-confirming'); discard.textContent = 'Discard'; } }, 4000);
          return;
        }
        void act(item, 'discard', discard);
      });
      actions.append(merge, publish, discard);
    } else if (tree.url) {
      const open = element('button', 'secondary-button', 'Open pull request page');
      open.type = 'button';
      open.addEventListener('click', () => void openLink(tree.url));
      actions.append(open);
    }
    const diffBox = element('div', 'diff-view');
    diffBox.append(element('p', 'ui-list-empty', tree.review === 'pending' || tree.review === 'published' ? 'Loading the changes…' : 'These changes are no longer on a branch here.'));
    view.replaceChildren(back, head, actions, diffBox);
    if (tree.review !== 'pending' && tree.review !== 'published') return;
    try {
      const files = parseDiff(await diff(item.runId));
      if (selected?.runId !== item.runId) return;
      const list = element('div', 'diff-files');
      list.append(...files.map((file, index) => renderFile(file, index < 8)));
      diffBox.replaceChildren(files.length ? list : element('p', 'ui-list-empty', 'No differences.'));
    } catch (error) { diffBox.replaceChildren(element('p', 'ui-list-empty', `Could not read the changes: ${String(error)}`)); }
  }

  return { refresh, show: () => { selected = null; return refresh(); } };
}
