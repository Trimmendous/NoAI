import { parseLocalTime } from '../core/schedule-time.js';
import { summaryCard, runFolders } from './summary.js';
import { HARNESSES, getHarness, preferredHarness, harnessOptionLabel } from '../core/catalog.js';
import { basename, element } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { normalizeMetrics } from '../core/metrics.js';
import { renderSessionStats } from './session-stats.js';
import { renderItemAnalytics } from './item-analytics.js';
import { group as uiGroup, icon as uiIcon, pill, row as uiRow } from './ui.js';

const $ = selector => document.querySelector(selector);
const STATUS = { scheduled: 'Scheduled', running: 'Running', waiting: 'Waiting for reset', completed: 'Succeeded', cancelled: 'Cancelled', needs_attention: 'Needs attention', paused: 'Paused', failed: 'Failed' };

function permissionLabel(harness, id = 'provider-default') {
  return getHarness(harness)?.permissions.find(mode => mode.id === id)?.label || id || 'Unknown';
}

export function runStatus(run) {
  if (run.status === 'needs_attention' && run.events?.at(-1)?.type === 'error') return 'failed';
  return run.status;
}

export function groupJobs(tasks) {
  return [
    tasks.filter(task => task.intervalSeconds),
    tasks.filter(task => !task.intervalSeconds && !['completed', 'cancelled', 'failed'].includes(task.status)),
    tasks.filter(task => !task.intervalSeconds && ['completed', 'cancelled', 'failed'].includes(task.status)),
  ];
}

function badge(status) {
  return element('span', `scheduled-status is-${status}`, STATUS[status] || status);
}

function agentLabel(task, run) {
  const harness = run?.harness || task.harness;
  const events = [...(run?.events || [])].reverse();
  const observedModel = events.find(event => event.type === 'usage' && event.model)?.model || events.find(event => event.model)?.model;
  return `${getHarness(harness)?.label || harness} · ${observedModel || (run?.harness ? run.model : task.model) || 'Default model'}`;
}

export function formatScheduledTime(seconds) {
  if (!Number.isFinite(seconds)) return 'Time unavailable';
  return new Date(seconds * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export function formatScheduledInterval(seconds) {
  if (!seconds) return 'One time';
  const every = (count, unit) => count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
  if (seconds % 86400 === 0) return every(seconds / 86400, 'day');
  if (seconds % 3600 === 0) return every(seconds / 3600, 'hour');
  return every(Math.round(seconds / 60), 'minute');
}

/** Short, friendly time: "Today 9:00 AM", "Tomorrow 9:00 AM", "Fri 9:00 AM", "Nov 30". */
export function formatShortTime(seconds, now = new Date()) {
  if (!Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - day) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

const LIST_STEP = 25;
// Smart filters, like Reminders' smart lists.
const FILTERS = [
  { id: 'scheduled', label: 'Scheduled', icon: 'clock' },
  { id: 'attention', label: 'Needs you', icon: 'alert' },
  { id: 'running', label: 'Running', icon: 'play' },
  { id: 'completed', label: 'Completed', icon: 'done' },
];
const NEEDS_YOU = new Set(['needs_attention', 'failed']);

// Small icon tile for a job card: a loop for recurring work, a clock for one-off.
const ICONS = {
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  done: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 8v5', 'M12 16.5v.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  play: ['M8 5.5v13l10.5-6.5z'],
  chevron: ['M9 6l6 6-6 6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
};
function icon(kind, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const d of ICONS[kind]) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function jobTile(kind, status) {
  const tile = element('span', `scheduled-tile is-${kind} is-${status}`);
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(kind));
  return tile;
}

export function initScheduledTasks({ list, create, edit, retry, cancel, pause, resume, getRuns, getResumeJobs, fetchMetrics, ensureProject, getModels, native, getProjectPath, getAutoResume, getCustomModels, getRuntime = () => null, toast, navigate }) {
  const form = $('#scheduled-form');
  const listNode = $('#scheduled-list');
  const harnessNode = $('#scheduled-harness');
  const modelNode = $('#scheduled-model');
  const customModelNode = $('#scheduled-custom-model');
  const submit = $('#scheduled-submit');
  let tasks = [];
  let refreshing = null;
  let busy = false;
  let editing = null;
  const ENDED = new Set(['cancelled', 'completed']);
  const canEdit = task => !!edit && !ENDED.has(task.status) && !task.kind;
  let editLocked = false;
  let renderedSignature = '';
  let filter = 'scheduled';
  let query = '';
  let limit = LIST_STEP;
  let metricsCache = [], metricsAt = 0, metricsRequest = null;
  async function sessionMetrics() {
    if (!fetchMetrics) return metricsCache;
    if (Date.now() - metricsAt < 15000) return metricsCache;
    if (!metricsRequest) metricsRequest = fetchMetrics().then(data => {
      metricsCache = normalizeMetrics(data.records || []);
      metricsAt = Date.now();
      return metricsCache;
    }).finally(() => { metricsRequest = null; });
    return metricsRequest;
  }
  /**
   * Every metric record that belongs to a job: its runs, and the agent
   * sessions those runs created. Without recorded metrics, the runs' own
   * saved events stand in.
   */
  function jobRows(task, runs, metrics) {
    const runIds = new Set(runs.map(run => run.runId));
    const sessions = new Set(runs.flatMap(run => (run.events || []).map(event => event.resumeId).filter(Boolean)));
    const matched = metrics.filter(row => runIds.has(row.runId) || (row.sessionId && sessions.has(row.sessionId)));
    if (matched.length) return matched;
    return normalizeMetrics(runs.flatMap(run => (run.events || []).map((event, index) => ({
      ...event, id: `${run.runId}:${event.eventId ?? index}`, runId: run.runId,
      harness: run.harness || task.harness, model: event.model || run.model || task.model || '',
      sessionId: event.resumeId, at: event.at || run.startedAt, tool: event.type === 'activity' ? event.text : undefined,
    }))));
  }
  const analytics = element('section', 'item-analytics job-analytics');
  analytics.setAttribute('aria-label', 'Job usage charts');

  let selectedJob = null;
  let selectedRun = null;
  // Recurring jobs open on an overview with their runs; a run opens on its own.
  let runView = false;
  let copying = null;
  // A job's runs are shown in pages, newest first, each led by its run number.
  const RUNS_PER_PAGE = 20;
  let runPage = 0;
  let conversationOpen = false;
  let detailSignature = '';
  let listScroll = 0;
  const runErrors = new Map();
  const runCache = new Map();
  const modelCache = new Map();

  let harnessTouched = false;
  const detected = () => getRuntime()?.harnesses || [];
  function renderHarnessOptions() {
    const selected = harnessNode.value;
    harnessNode.replaceChildren(...HARNESSES.map(harness => {
      const option = new Option(harnessOptionLabel(harness, detected()), harness.id);
      option.disabled = !harness.available;
      return option;
    }));
    if (selected) harnessNode.value = selected;
  }
  renderHarnessOptions();
  harnessNode.value = preferredHarness(detected());
  $('#scheduled-auto-resume').checked = !!getAutoResume();
  if (!native) {
    submit.disabled = true;
    $('#scheduled-form-status').textContent = 'Open the desktop app to create jobs.';
  }

  function permissionControls(reset = false) {
    const select = $('#scheduled-permissions');
    const modes = getHarness(harnessNode.value)?.permissions || [];
    const values = modes.map(mode => mode.id);
    const previous = select.value;
    select.replaceChildren(...modes.map(mode => new Option(mode.label, mode.id)));
    select.value = !reset && values.includes(previous) ? previous : values[0];
    select.disabled = editLocked || $('#scheduled-bypass-permissions').checked;
    $('#scheduled-permissions-description').textContent = $('#scheduled-bypass-permissions').checked ? 'Explicit permission bypass overrides the selected mode.' : modes.find(mode => mode.id === select.value)?.description || '';
  }
  $('#scheduled-permissions').addEventListener('change', () => permissionControls());
  $('#scheduled-bypass-permissions').addEventListener('change', () => permissionControls());

  function updateControls() {
    permissionControls();
    $('#scheduled-bypass-label').textContent = `Dangerously bypass permissions for ${getHarness(harnessNode.value)?.label || harnessNode.value}`;
    $('#scheduled-bypass-description').textContent = getHarness(harnessNode.value)?.bypassDescription || '';
    const untimed = !!editing && !editing.timed;
    $('#scheduled-start-choice').hidden = untimed;
    const later = !untimed && form.elements['scheduled-start'].value === 'later';
    const repeating = form.elements['scheduled-repeat'].value === 'interval';
    $('#scheduled-time-wrap').hidden = !later;
    $('#scheduled-time').required = later;
    $('#scheduled-interval-wrap').hidden = !repeating;
    $('#scheduled-interval').required = repeating;
  }
  form.addEventListener('change', event => {
    if (event.target.name === 'scheduled-start' || event.target.name === 'scheduled-repeat') updateControls();
  });
  updateControls();

  function updateCustomModel() {
    customModelNode.hidden = modelNode.value !== '__custom__';
    $('#scheduled-custom-model-label').hidden = customModelNode.hidden;
    customModelNode.required = !customModelNode.hidden;
  }

  async function updateModels() {
    const harness = harnessNode.value;
    const previous = modelNode.value;
    const custom = getCustomModels()?.[harness] || [];
    const discovered = modelCache.get(harness) || [];
    const models = [...discovered, ...custom.filter(id => !discovered.some(item => item.id === id)).map(id => ({ id, label: id }))];
    modelNode.replaceChildren(new Option('Agent default', ''), ...models.map(item => new Option(item.label || item.id, item.id)), new Option('Custom model…', '__custom__'));
    modelNode.value = previous === '__custom__' || models.some(item => item.id === previous) ? previous : '';
    updateCustomModel();
    if (modelCache.has(harness) || !native || !getModels) return;
    try {
      const found = await getModels(harness);
      modelCache.set(harness, Array.isArray(found) ? found.map(item => typeof item === 'string' ? { id: item, label: item } : item) : []);
      if (harnessNode.value === harness) void updateModels();
    } catch { modelCache.set(harness, []); }
  }
  harnessNode.addEventListener('change', () => { harnessTouched = true; $('#scheduled-bypass-permissions').checked = false; updateControls(); modelNode.value = ''; updateCustomModel(); void updateModels(); });
  modelNode.addEventListener('change', () => {
    updateCustomModel();
    if (!customModelNode.hidden) customModelNode.focus();
  });
  void updateModels();

  $('#scheduled-current-project').addEventListener('click', () => {
    const project = getProjectPath();
    if (project) $('#scheduled-project').value = project;
    else toast('Choose a project folder in Chat first, or leave this blank for a new job folder.');
  });

  function resetForm() {
    editing = null; editLocked = false; copying = null;
    form.querySelectorAll('input, select, textarea').forEach(node => { node.disabled = false; });
    form.reset(); harnessTouched = false; harnessNode.value = preferredHarness(detected());
    customModelNode.hidden = true;
    $('#scheduled-custom-model-label').hidden = true;
    customModelNode.required = false;
    $('#scheduled-auto-resume').checked = !!getAutoResume();
    $('#scheduled-worktree').checked = true;
    $('#scheduled-form-title').textContent = 'New job';
    $('#scheduled-form-title').nextElementSibling.textContent = 'Each run starts a fresh conversation and saves the result.';
    submit.textContent = 'Create job'; submit.disabled = !native;
    permissionControls(true); updateControls(); void updateModels();
  }
  function lockEditor() {
    if (!editing) return;
    const latest = tasks.find(task => task.id === editing.id);
    editLocked = !latest || ENDED.has(latest.status);
    submit.disabled = busy || editLocked || !native;
    form.querySelectorAll('input, select, textarea').forEach(node => { node.disabled = editLocked; });
    permissionControls();
    if (editLocked) $('#scheduled-form-status').textContent = 'This job has ended, so it can’t be edited. Use Run again to start a new one.';
  }
  // Copies a job's settings into the sheet. Returns false if the sheet moved on.
  async function fillForm(task, isCurrent) {
    $('#scheduled-title-input').value = task.title;
    $('#scheduled-prompt').value = task.prompt;
    $('#scheduled-project').value = task.projectPath || '';
    harnessNode.value = task.harness;
    $('#scheduled-auto-resume').checked = task.autoResume;
    $('#scheduled-worktree').checked = !!task.worktree;
    $('#scheduled-bypass-permissions').checked = !!task.dangerouslyBypassPermissions;
    permissionControls(true);
    $('#scheduled-permissions').value = task.permissions || 'provider-default';
    form.elements['scheduled-repeat'].value = task.intervalSeconds ? 'interval' : 'once';
    if (task.intervalSeconds) {
      const unit = [86400, 3600, 60, 1].find(unit => task.intervalSeconds % unit === 0);
      $('#scheduled-interval-unit').value = String(unit);
      $('#scheduled-interval').value = task.intervalSeconds / unit;
    }
    modelNode.value = ''; updateControls();
    await updateModels();
    if (!isCurrent()) return false;
    const known = [...modelNode.options].some(option => option.value === task.model);
    modelNode.value = task.model ? known ? task.model : '__custom__' : '';
    customModelNode.value = task.model || ''; updateCustomModel();
    return true;
  }

  // "Run again": a new job with the same settings, starting now unless the
  // user picks a time. A recurring job that stopped is replaced by its copy.
  async function beginCopy(task) {
    if (busy || !native) return;
    resetForm();
    const replace = !!task.intervalSeconds && !['cancelled', 'completed'].includes(task.status);
    copying = { id: task.id, replace };
    $('#scheduled-form-title').textContent = 'Run again';
    $('#scheduled-form-title').nextElementSibling.textContent = replace ? `Saving replaces “${task.title}” with this copy. Its past runs stay in the history.` : 'Same settings as before. Change anything you like, then run it.';
    submit.textContent = 'Run';
    openSheet();
    const token = copying;
    if (!await fillForm(task, () => copying === token)) return;
    form.elements['scheduled-start'].value = 'now';
    updateControls();
  }

  // Editing keeps the job, its runs and its state. A running job finishes
  // with its old settings; the changes apply from the next run.
  async function beginEdit(task) {
    if (busy || !canEdit(task)) return;
    resetForm();
    const timed = ['scheduled', 'paused'].includes(task.status);
    editing = { id: task.id, lastRunId: task.lastRunId || null, timed };
    $('#scheduled-form-title').textContent = 'Edit job';
    $('#scheduled-form-title').nextElementSibling.textContent = timed
      ? `Past runs keep the settings they ran with.${task.status === 'paused' ? ' The job stays paused until you resume it.' : ''}`
      : task.status === 'running' || task.status === 'waiting'
        ? 'A run is in progress and finishes with the old settings. Your changes apply from the next run.'
        : 'Your changes apply when you retry the job or when its next run starts.';
    submit.textContent = 'Save changes';
    openSheet();
    const token = editing;
    if (!await fillForm(task, () => editing === token)) return;
    const due = task.nextRunAt || 0;
    if (timed && due > Date.now() / 1000 + 60) {
      form.elements['scheduled-start'].value = 'later';
      const date = new Date(due * 1000);
      $('#scheduled-time').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    } else form.elements['scheduled-start'].value = 'now';
    updateControls();
    lockEditor();
  }
  $('#scheduled-edit-cancel').addEventListener('click', () => {
    if (busy) return;
    resetForm(); $('#scheduled-form-status').textContent = '';
    closeSheet();
  });

  const dialog = $('#scheduled-dialog');
  function openSheet() {
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.job-sheet-body').scrollTop = 0;
    $('#scheduled-title-input').focus({preventScroll:true});
  }
  function closeSheet() { if (dialog.open) dialog.close(); }
  function showForm() {
    if (busy) return;
    if (editing || copying) resetForm();
    $('#scheduled-form-status').textContent = native ? '' : 'Open the desktop app to create jobs.';
    openSheet();
  }
  $('#scheduled-new-job').addEventListener('click', showForm);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if ((editing || copying) && !busy) resetForm(); });
  $('#job-search').addEventListener('input', event => { query = event.target.value.trim().toLowerCase(); limit = LIST_STEP; renderList(); });

  function button(label, action, className = 'secondary-button') {
    const node = element('button', className, label);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
  }

  function retryButton(task) {
    if (!retry || !['needs_attention', 'failed', 'cancelled'].includes(task.status)) return null;
    return button(task.status === 'cancelled' ? 'Restart' : 'Retry', async event => {
      const retryNode = event.currentTarget;
      retryNode.disabled = true;
      try {
        const updated = await retry(task.id, Math.floor(Date.now()/1000) + 60, task.lastRunId || null);
        toast(`Retry scheduled for ${formatScheduledTime(updated.nextRunAt)}${updated.pendingResumeId ? ' · continuing the saved conversation' : ''}.`);
        await refresh();
      } catch (error) { toast(`Could not retry job: ${String(error)}`, 'error'); await refresh(); }
      finally { if (retryNode.isConnected) retryNode.disabled = false; }
    });
  }

  function openJob(task, run = null) {
    listScroll = $('#view-jobs').parentElement.scrollTop;
    detailSignature = '';
    if (selectedJob !== task.id) runPage = 0;
    selectedJob = task.id; selectedRun = run?.runId || null; conversationOpen = false;
    runView = !!run || !task.intervalSeconds;
    renderDetail(); navigate('job'); $('#view-job').parentElement.scrollTop=0;
    $('#job-heading').focus();
  }

  async function act(label, action, done) {
    try { await action(); toast(done); await refresh(); }
    catch (error) { toast(`Could not ${label}: ${String(error)}`, 'error'); await refresh(); }
  }

  // Every control a job offers, in the order people reach for them.
  function jobActions(task, { compact = false, run = null } = {}) {
    const nodes = [];
    const small = compact ? ' is-compact' : '';
    if (task.status === 'paused' && resume) nodes.push(button('Resume', () => act('resume the job', () => resume(task.id), 'Job resumed.'), `secondary-button${small}`));
    const retryNode = (!run || run.runId === task.lastRunId) ? retryButton(task) : null;
    if (retryNode) { if (compact) retryNode.classList.add('is-compact'); nodes.push(retryNode); }
    if (!compact && canEdit(task)) nodes.push(button('Edit', () => void beginEdit(task)));
    if (!compact && (ENDED.has(task.status) || (!task.intervalSeconds && ['failed', 'needs_attention'].includes(task.status)))) nodes.push(button('Run again…', () => void beginCopy(task)));
    if (task.status === 'scheduled' && pause) nodes.push(button('Pause', () => act('pause the job', () => pause(task.id), 'Job paused. It won’t start again until you resume it.'), `secondary-button${small}`));
    if (['scheduled', 'running', 'waiting', 'needs_attention', 'paused', 'failed'].includes(task.status) && !(task.status === 'failed' && !task.intervalSeconds)) {
      // Two taps: the first asks, the second cancels. Nothing else to undo it.
      const stop = button('Cancel job', async () => {
        if (!stop.classList.contains('is-confirming')) {
          stop.classList.add('is-confirming'); stop.textContent = 'Confirm cancel';
          setTimeout(() => { if (stop.isConnected) { stop.classList.remove('is-confirming'); stop.textContent = 'Cancel job'; } }, 4000);
          return;
        }
        stop.disabled = true;
        await act('cancel the job', () => cancel(task.id), 'Job cancelled.');
      }, `secondary-button is-destructive${small}`);
      nodes.push(stop);
    }
    return nodes;
  }

  function runTokens(run) {
    return (run.events || []).filter(event => event.type === 'usage' && event.usage).reduce((sum, event) => sum + (event.usage.inputTokens || 0) + (event.usage.outputTokens || 0), 0);
  }
  function duration(run) {
    if (!run.finishedAt) return '';
    const seconds = Math.max(0, run.finishedAt - run.startedAt);
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`;
  }
  const compactNumber = value => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const TONE = { completed: 'good', running: 'good', waiting: 'warn', failed: 'bad', needs_attention: 'bad', cancelled: 'muted', paused: 'muted', scheduled: 'accent' };

  // A recurring job: what it does, when it runs next, and every run so far.
  function renderOverview(task, runs, content) {
    const status = task.status === 'running' && runs[0] ? runStatus(runs[0]) : task.status;
    const summary = element('div', 'job-summary');
    summary.append(jobTile('repeat', status));
    const copy = element('div', 'job-summary-copy');
    copy.append(element('strong', '', formatScheduledInterval(task.intervalSeconds)), element('span', '', [agentLabel(task, runs[0]), task.projectPath ? basename(task.projectPath) : ''].filter(Boolean).join(' · ')));
    copy.append(element('small', '', task.status === 'scheduled' && task.nextRunAt ? `Next run ${formatShortTime(task.nextRunAt)}` : task.status === 'paused' ? 'Paused · resume to put it back on schedule' : STATUS[status] || status));
    summary.append(copy, pill(STATUS[status] || status, TONE[status] || 'muted'));
    const actions = element('div', 'job-detail-actions');
    actions.append(...jobActions(task));
    const done = runs.filter(run => runStatus(run) === 'completed').length;
    const failed = runs.filter(run => ['failed', 'needs_attention'].includes(runStatus(run))).length;
    const tokens = runs.reduce((sum, run) => sum + runTokens(run), 0);
    const stats = element('div', 'ui-tiles job-run-stats');
    for (const [label, value, kind, color] of [['Runs', runs.length, 'repeat', 'var(--tile-jobs)'], ['Succeeded', done, 'done', 'var(--tile-chat)'], ['Failed', failed, 'alert', 'var(--tile-alert)'], ['Tokens', tokens ? compactNumber(tokens) : '—', 'bolt', 'var(--tile-home)']]) {
      const tile = element('div', 'ui-filter ui-stat');
      tile.style.setProperty('--filter', color);
      const top = element('span', 'ui-filter-top'), mark = element('span', 'ui-filter-icon');
      mark.append(uiIcon(kind));
      top.append(mark, element('strong', '', String(value)));
      tile.append(top, element('span', 'ui-filter-label', label));
      stats.append(tile);
    }
    const prompt = element('details', 'job-prompt');
    prompt.append(element('summary', '', 'What it does'), element('p', 'scheduled-card-instructions', task.prompt));
    const pages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
    runPage = Math.min(runPage, pages - 1);
    const first = runPage * RUNS_PER_PAGE;
    const rows = runs.slice(first, first + RUNS_PER_PAGE).map((run, offset) => {
      const state = runStatus(run);
      const number = runs.length - first - offset;
      const tokensUsed = runTokens(run);
      const badge = element('span', `run-number is-${state === 'completed' ? 'good' : ['failed', 'needs_attention'].includes(state) ? 'bad' : ['running', 'waiting'].includes(state) ? 'busy' : 'muted'}`, `#${number}`);
      badge.setAttribute('aria-hidden', 'true');
      return uiRow({
        leading: badge,
        title: `Run ${number}`,
        subtitle: [formatShortTime(run.startedAt), duration(run), tokensUsed ? `${compactNumber(tokensUsed)} tokens` : '', run.result && state !== 'completed' ? run.result : ''].filter(Boolean).join(' · '),
        trailing: [pill(STATUS[state] || state, TONE[state] || 'muted')],
        onClick: () => { selectedRun = run.runId; runView = true; detailSignature = ''; renderDetail(); $('#view-job').parentElement.scrollTop = 0; },
        className: 'job-run-row',
      });
    });
    content.replaceChildren(summary, actions, stats, prompt, analytics);
    // The same charts as the Dashboard, for this job only.
    renderItemAnalytics(analytics, jobRows(task, runs, metricsCache), { what: 'this job' });
    void sessionMetrics().then(metrics => { if (analytics.isConnected) renderItemAnalytics(analytics, jobRows(task, runs, metrics), { what: 'this job' }); }).catch(() => {});
    if (runErrors.has(task.id)) content.append(element('p', 'ui-footnote', runErrors.get(task.id)));
    if (rows.length) content.append(uiGroup(`Runs · ${runs.length}`, rows, 'Runs'));
    else content.append(uiGroup('Runs', [element('p', 'ui-list-empty', task.nextRunAt ? `No runs yet. The first one starts ${formatShortTime(task.nextRunAt)}.` : 'No runs yet.')], 'Runs'));
    if (pages > 1) {
      const turn = delta => { runPage = Math.min(pages - 1, Math.max(0, runPage + delta)); detailSignature = ''; renderDetail(); content.querySelector('.run-pager')?.scrollIntoView({ block: 'nearest' }); };
      const pager = element('nav', 'run-pager');
      pager.setAttribute('aria-label', 'Run pages');
      const previous = button('‹ Newer', () => turn(-1), 'secondary-button is-compact');
      const next = button('Older ›', () => turn(1), 'secondary-button is-compact');
      previous.disabled = runPage === 0;
      next.disabled = runPage >= pages - 1;
      const where = element('span', 'run-pager-label', `Runs ${runs.length - first - Math.min(RUNS_PER_PAGE, runs.length - first) + 1}–${runs.length - first} of ${runs.length} · Page ${runPage + 1} of ${pages}`);
      where.setAttribute('aria-live', 'polite');
      pager.append(previous, where, next);
      content.append(pager);
    }
  }

  function renderDetail() {
    const task = tasks.find(task => task.id === selectedJob);
    if (!task) return;
    const runs = [...(runCache.get(task.id) || [])].sort((a, b) => b.startedAt - a.startedAt);
    const overview = !!task.intervalSeconds && !runView;
    $('#job-back').textContent = task.intervalSeconds && runView ? `← ${task.title}` : '← Back to Jobs';
    if (overview) {
      const signature = JSON.stringify(['overview', task, runs, runPage]);
      if (signature === detailSignature) return;
      detailSignature = signature;
      $('#job-heading').textContent = task.title;
      renderOverview(task, runs, $('#job-content'));
      return;
    }
    // An explicitly selected occurrence must never become a different run.
    const run = selectedRun ? runs.find(run => run.runId === selectedRun) : runs.find(run => run.runId === task.lastRunId) || runs[0];
    if (run) selectedRun = run.runId;
    const signature = JSON.stringify(['run', task, runs, selectedRun]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    const promptOpen = $('#job-content .job-prompt')?.open || false;
    $('#job-heading').textContent = task.intervalSeconds && run ? `${task.title} · ${formatShortTime(run.startedAt)}` : task.title;
    const content = $('#job-content');
    const meta = element('dl', 'session-stats-grid job-overview');
    const technical=element('details','job-technical');technical.append(element('summary','','Schedule & technical details'));
    const extra=element('dl','session-stats-grid');technical.append(extra);
    for (const [key, value] of [
      ['Agent / model', agentLabel(task, run)], ['Status', task.status === 'scheduled' && task.pendingResumeId ? 'Retry scheduled' : STATUS[run ? runStatus(run) : task.status] || task.status],
      ['Permissions', (run ? run.dangerouslyBypassPermissions : task.dangerouslyBypassPermissions) ? 'Permission bypass enabled' : permissionLabel(run?.harness || task.harness, (run ? run.permissions : task.permissions) || 'provider-default')], ['Schedule', formatScheduledInterval(task.intervalSeconds)], ['Project', run?.projectPath || task.projectPath || 'Not reported'],
      ['Job ID', task.id], ['Run ID', run?.runId || 'No runs yet'],
      ['Started', run ? formatScheduledTime(run.startedAt) : 'Not started'],
      ['Finished', run?.finishedAt ? formatScheduledTime(run.finishedAt) : '—'],
      ['Next run', task.nextRunAt ? formatScheduledTime(task.nextRunAt) : '—'],
    ]) { const cell = element('div'); cell.append(element('dt', '', key), element('dd', '', value)); (['Agent / model','Status','Project'].includes(key)?meta:extra).append(cell); }
    const prompt = element('details', 'job-prompt');
    prompt.open = promptOpen;
    prompt.append(element('summary', '', run?.prompt != null ? 'Original prompt' : 'Current job prompt'), element('p', 'scheduled-card-instructions', run?.prompt ?? task.prompt));
    content.replaceChildren(meta, prompt);
    if (runErrors.has(task.id)) content.append(element('p', '', runErrors.get(task.id)));
    if (run) {
      const stats = element('section', 'session-stats'); stats.setAttribute('aria-label', 'Session stats');
      renderSessionStats(stats, task, run, metricsCache);
      content.append(stats);
      void sessionMetrics().then(metrics => {
        if (stats.isConnected) renderSessionStats(stats, task, run, metrics);
      }).catch(() => { if (stats.isConnected) renderSessionStats(stats, task, run, [], 'Metrics unavailable; showing saved run data.'); });
      if (run.result) content.append(element('p', 'scheduled-run-result', run.result));
      // Re-read once the run is over, in case it wrote its summary at the end.
      content.append(summaryCard(runFolders(task, run), { refresh: !['running', 'waiting'].includes(run.status) && run.finishedAt > Date.now() / 1000 - 60 }));
      if (run.retryAt) content.append(element('p', 'scheduled-waiting', `Retry: ${formatScheduledTime(run.retryAt)}`));
    }
    const conversation = button('Open conversation', () => {
      conversationOpen = true;
      $('#job-conversation-stream').replaceChildren();
      renderConversation(task, run); navigate('job-conversation');
      $('#view-job-conversation').parentElement.scrollTop = 0;
      $('#job-conversation-heading').focus({ preventScroll: true });
    }, 'primary-button');
    conversation.id = 'job-open-conversation';
    const actions = element('div', 'job-detail-actions');
    // Inside one run of a recurring job, only run-level actions; the rest are on its overview.
    const retryNode = task.intervalSeconds && (!run || run.runId === task.lastRunId) ? retryButton(task) : null;
    actions.append(conversation, ...(task.intervalSeconds ? [retryNode].filter(Boolean) : jobActions(task, { run })));
    content.insertBefore(actions,prompt);
    if (task.status === 'scheduled' && task.pendingResumeId) content.insertBefore(element('p', 'scheduled-card-subtitle', `Retry scheduled: ${formatScheduledTime(task.nextRunAt)} · will continue the saved conversation.`), prompt);
    if (!task.intervalSeconds && (runs.length > 1 || selectedRun && !run)) {
      const label = element('label', 'job-run-picker', 'Run');
      const select = element('select', 'text-field');
      for (const item of runs) select.append(new Option(`${formatScheduledTime(item.startedAt)} · ${STATUS[runStatus(item)] || item.status}`, item.runId));
      if (!run) select.append(new Option('Selected run unavailable', selectedRun));
      select.value = selectedRun;
      select.addEventListener('change', () => { selectedRun = select.value; renderDetail(); });
      label.append(select); content.prepend(label);
    }
    content.append(technical);
    if (conversationOpen) renderConversation(task, run);
  }

  function renderConversation(task, run) {
    $('#job-conversation-heading').textContent = task.title;
    const stream = $('#job-conversation-stream');
    const expanded = [...stream.querySelectorAll('.job-message details')].map(node => node.open);
    let collapseIndex = 0;
    const fragment = document.createDocumentFragment();
    function message(role, text, collapsible = false) {
      const bubble = element('article', `job-message is-${role === 'You' ? 'user' : 'agent'}`);
      const header = element('div', 'job-message-header');
      header.append(element('span', '', role), button('Copy', async event => {
        try { await navigator.clipboard.writeText(text); event.target.textContent = 'Copied'; }
        catch { toast('Could not copy this message.', 'error'); }
      }, 'job-copy'));
      const body = role === 'You' ? element('pre', 'job-message-text', text) : renderMarkdown(text, 'job-message-text');
      bubble.append(header);
      if (collapsible) { const details = element('details'); details.open = expanded[collapseIndex++] || false; details.append(element('summary', '', role), body); bubble.append(details); }
      else bubble.append(body);
      fragment.append(bubble);
    }
    const context = element('p', 'conversation-context', run ? `${formatScheduledTime(run.startedAt)} · ${STATUS[runStatus(run)] || run.status}` : 'Saved conversation unavailable');
    fragment.append(context);
    if (run?.prompt != null) message('You', run.prompt);
    else fragment.append(element('p', 'scheduled-empty', 'The original prompt was not saved with this occurrence. The job’s current prompt is available on its detail page.'));
    for (const event of run?.events || []) {
      if (!event.text) continue;
      const role = event.type === 'text' ? 'Assistant' : event.type === 'reasoning' || event.type === 'thinking' ? 'Thinking' : event.type === 'activity' ? 'Tool activity' : event.type === 'notice' ? 'Warning' : event.type;
      message(role, event.text, !['text', 'error', 'notice'].includes(event.type));
    }
    if (!(run?.events || []).some(event => event.text)) fragment.append(element('p', 'scheduled-empty', runErrors.has(task.id) ? 'Could not load saved history. Return to the job and refresh to retry.' : run && ['running', 'waiting'].includes(run.status) ? 'No conversation output recorded yet.' : 'No conversation history was saved for this occurrence. A transcript cannot be displayed.'));
    stream.replaceChildren(fragment);
  }

  $('#job-back').addEventListener('click', () => {
    conversationOpen = false;
    const task = tasks.find(item => item.id === selectedJob);
    if (task?.intervalSeconds && runView) { runView = false; selectedRun = null; detailSignature = ''; renderDetail(); $('#view-job').parentElement.scrollTop = 0; return; }
    navigate('jobs'); $('#view-jobs').parentElement.scrollTop = listScroll;
  });
  $('#job-conversation-back').addEventListener('click', () => { conversationOpen = false; navigate('job'); $('#job-open-conversation')?.focus({ preventScroll: true }); });
  $('#job-refresh').addEventListener('click', () => void refresh());

  // One compact row per job, in a single grouped list. Actions live on the job page.
  function renderRow(task, completedRun = null) {
    const runs = [...(runCache.get(task.id) || [])].sort((a, b) => b.startedAt - a.startedAt);
    const latest = completedRun || runs.find(run => run.runId === task.lastRunId) || runs[0];
    const status = completedRun || task.status === 'running' && latest ? runStatus(latest) : task.status;
    const finished = !!completedRun || !task.intervalSeconds && ['completed', 'cancelled', 'failed'].includes(task.status);
    const row = element('button', `job-row is-${status}`);
    row.type = 'button';
    row.addEventListener('click', () => openJob(task, completedRun));
    const copy = element('span', 'job-row-copy');
    copy.append(element('span', 'job-row-title', task.title));
    const agent = getHarness(task.harness)?.label || task.harness;
    const where = task.projectPath ? basename(task.projectPath) : '';
    const when = completedRun ? `Ran ${formatShortTime(completedRun.finishedAt || completedRun.startedAt)}` : formatScheduledInterval(task.intervalSeconds);
    // Recurring jobs show how many times they've run; a past run shows which one it was.
    const ordinal = completedRun ? runs.length - runs.findIndex(item => item.runId === completedRun.runId) : 0;
    const count = completedRun ? `Run ${ordinal} of ${runs.length} · ${formatScheduledInterval(task.intervalSeconds)}` : task.intervalSeconds ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : '';
    copy.append(element('span', 'job-row-subtitle', [when, count, agent, where].filter(Boolean).join(' · ')));
    const trailing = element('span', 'job-row-trailing');
    if (['running', 'waiting', 'failed', 'needs_attention', 'paused', 'cancelled'].includes(status) || finished) trailing.append(badge(status));
    else if (task.nextRunAt && task.status === 'scheduled') trailing.append(element('span', 'job-row-when', formatShortTime(task.nextRunAt)));
    if (task.dangerouslyBypassPermissions && !finished) trailing.prepend(element('span', 'job-row-flag', 'Bypass'));
    trailing.append(icon('chevron', 'job-row-chevron'));
    row.append(jobTile(finished ? 'done' : task.intervalSeconds ? 'repeat' : 'clock', status), copy, trailing);
    const wrap = element('div', 'job-row-wrap');
    wrap.append(row);
    const quick = completedRun ? [] : jobActions(task, { compact: true });
    if (quick.length && native) {
      const actions = element('div', 'job-row-actions');
      actions.append(...quick);
      wrap.append(actions);
    }
    return wrap;
  }

  function filtered() {
    const active = tasks.filter(task => !(!task.intervalSeconds && ['completed', 'cancelled', 'failed'].includes(task.status)));
    const completed = tasks.filter(task => !task.intervalSeconds && ['completed', 'cancelled', 'failed'].includes(task.status)).map(task => ({ task, run: null }));
    for (const task of tasks.filter(task => task.intervalSeconds)) {
      for (const run of runCache.get(task.id) || []) {
        if (['completed', 'failed', 'cancelled'].includes(runStatus(run))) completed.push({ task, run });
      }
    }
    completed.sort((a, b) => (b.run?.finishedAt || b.task.createdAt || 0) - (a.run?.finishedAt || a.task.createdAt || 0));
    return {
      scheduled: active.map(task => ({ task })),
      attention: tasks.filter(task => NEEDS_YOU.has(task.status)).map(task => ({ task })),
      running: active.filter(task => ['running', 'waiting'].includes(task.status)).map(task => ({ task })),
      completed,
    };
  }

  function matches(item) {
    if (!query) return true;
    const { task } = item;
    return [task.title, task.prompt, task.projectPath, getHarness(task.harness)?.label, task.model].some(text => String(text || '').toLowerCase().includes(query));
  }

  function renderList() {
    const signature = JSON.stringify([tasks, filter, query, limit, [...runCache], [...runErrors]]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const lists = filtered();
    $('#job-search-wrap').hidden = !tasks.length;
    const tiles = $('#job-filters');
    tiles.hidden = !tasks.length;
    tiles.replaceChildren(...FILTERS.map(item => {
      const tile = element('button', `job-filter is-${item.id}${filter === item.id ? ' is-selected' : ''}`);
      tile.type = 'button';
      tile.setAttribute('aria-pressed', String(filter === item.id));
      const top = element('span', 'job-filter-top');
      const dot = element('span', 'job-filter-icon'); dot.append(icon(item.icon));
      top.append(dot, element('strong', '', String(lists[item.id].length)));
      tile.append(top, element('span', 'job-filter-label', item.label));
      tile.addEventListener('click', () => { filter = item.id; limit = LIST_STEP; renderList(); });
      return tile;
    }));
    const fragment = document.createDocumentFragment();
    if (!tasks.length) {
      const empty = element('div', 'scheduled-empty-state');
      empty.append(jobTile('repeat', 'scheduled'), element('h3', '', 'No jobs yet'), element('p', '', 'Hand an agent something to do now, later, or every day. It keeps going even when Noai is closed.'));
      empty.append(button('Create a job', () => showForm(), 'primary-button'));
      listNode.replaceChildren(empty);
      return;
    }
    const items = lists[filter].filter(matches);
    const shown = items.slice(0, limit);
    // In Scheduled, recurring and one-time jobs get their own headed groups.
    const groups = filter === 'scheduled'
      ? [['Recurring', shown.filter(item => item.task.intervalSeconds)], ['One-time', shown.filter(item => !item.task.intervalSeconds)]]
      : [[FILTERS.find(item => item.id === filter).label, shown]];
    for (const [label, group] of groups) {
      if (!group.length) continue;
      const section = element('section', 'job-group');
      section.setAttribute('aria-label', `${label} jobs`);
      section.append(element('h3', 'job-group-title', label));
      const list = element('div', 'job-list');
      for (const item of group) list.append(renderRow(item.task, item.run || null));
      section.append(list);
      fragment.append(section);
    }
    if (!items.length) {
      const none = element('div', 'job-list job-list-empty');
      none.append(element('p', '', query ? `No jobs match “${query}”.` : filter === 'attention' ? 'Nothing needs you. Nice.' : filter === 'running' ? 'Nothing is running right now.' : filter === 'completed' ? 'Finished jobs will show up here.' : 'No upcoming jobs.'));
      fragment.append(none);
    }
    if (items.length > shown.length) {
      const more = button(`Show ${Math.min(LIST_STEP, items.length - shown.length)} more · ${items.length - shown.length} hidden`, () => { limit += LIST_STEP; renderList(); }, 'job-show-more');
      fragment.append(more);
    }
    listNode.replaceChildren(fragment);
  }

  async function refresh() {
    if (!native) { tasks = []; renderList(); return; }
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const found = await list();
        // The built-in daily digest is managed in its own tab.
        tasks = Array.isArray(found) ? found.filter(task => task.kind !== 'digest') : [];
        tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const resumes = getResumeJobs ? await getResumeJobs() : [];
        if (getRuns) await Promise.all(tasks.map(async task => {
          try {
            const foundRuns = await getRuns(task.id);
            runCache.set(task.id, foundRuns.map(run => {
              const resume = resumes.find(job => job.runId === run.runId);
              if (!resume) return run;
              if (!['running', 'waiting'].includes(run.status)) return { ...run, resumeAttempts: resume.attempts };
              return { ...run, status: resume.status, retryAt: resume.retryAt, resumeAttempts: resume.attempts, result: resume.status === 'needs_attention' ? resume.reason : run.result,
                events: resume.status === 'needs_attention' ? resume.events || run.events : run.events };
            }));
            runErrors.delete(task.id);
          }
          catch { runErrors.set(task.id, 'Could not load runs. Refresh to retry.'); }
        }));
        // A failed occurrence is terminal; interrupted work remains visible as paused.
        tasks = tasks.map(task => {
          const latest = runCache.get(task.id)?.find(run => run.runId === task.lastRunId);
          if (task.status === 'running' && latest) return { ...task, status: runStatus(latest) };
          return task.status === 'needs_attention' && latest && runStatus(latest) === 'failed' ? { ...task, status: 'failed' } : task;
        });
        lockEditor();
        renderList();
        renderDetail();
      } catch (error) { toast(`Could not load jobs: ${String(error)}`, 'error'); }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !native || editLocked) return;
    const title = $('#scheduled-title-input').value.trim();
    const prompt = $('#scheduled-prompt').value.trim();
    if (!title || !prompt) { form.reportValidity(); return; }
    const later = !(editing && !editing.timed) && form.elements['scheduled-start'].value === 'later';
    let startAt;
    try {
      startAt = later ? parseLocalTime($('#scheduled-time').value) : Math.floor(Date.now() / 1000);
      if (later && startAt <= Date.now() / 1000) throw new Error('Choose a future start time.');
    } catch (error) {
      $('#scheduled-form-status').textContent = error.message;
      $('#scheduled-time').focus();
      return;
    }
    const repeating = form.elements['scheduled-repeat'].value === 'interval';
    const intervalSeconds = repeating ? Number($('#scheduled-interval').value) * Number($('#scheduled-interval-unit').value) : null;
    if (repeating && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60)) {
      $('#scheduled-form-status').textContent = 'The interval must be at least one minute.';
      $('#scheduled-interval').focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    const editTarget = editing, copyTarget = copying;
    $('#scheduled-edit-cancel').disabled = true;
    $('#scheduled-form-status').textContent = editTarget ? 'Saving changes…' : 'Creating job…';
    try {
      const enteredPath = $('#scheduled-project').value.trim();
      const projectPath = enteredPath || await ensureProject();
      if (!projectPath) throw new Error('Could not create a job folder.');
      const input = { permissions: $('#scheduled-permissions').value, title, prompt, harness: harnessNode.value, model: (modelNode.value === '__custom__' ? customModelNode.value.trim() : modelNode.value) || null, projectPath, startAt, intervalSeconds, autoResume: $('#scheduled-auto-resume').checked, worktree: $('#scheduled-worktree').checked, dangerouslyBypassPermissions: $('#scheduled-bypass-permissions').checked };
      if (editTarget) await edit(editTarget.id, input, editTarget.lastRunId);
      else await create(input);
      // Run again on a stopped recurring job replaces it, so it doesn't run twice.
      if (copyTarget?.replace) { try { await cancel(copyTarget.id); } catch { /* the copy still exists */ } }
      resetForm();
      closeSheet();
      $('#scheduled-form-status').textContent = editTarget ? 'Changes saved.' : 'Job created.';
      toast(editTarget ? 'Job updated.' : copyTarget ? 'Running it again.' : 'Job created.');
      await refresh();
    } catch (error) { $('#scheduled-form-status').textContent = String(error); toast(`Could not ${editTarget ? 'update' : 'create'} job: ${String(error)}`, 'error'); if (editTarget) await refresh(); }
    finally { busy = false; $('#scheduled-edit-cancel').disabled = false; submit.disabled = editLocked || !native; }
  });
  $('#scheduled-refresh').addEventListener('click', () => void refresh());
  function onRuntime() {
    renderHarnessOptions();
    if (!harnessNode.value || editing) updateControls();
    if (editing || harnessTouched) return;
    const preferred = preferredHarness(detected(), harnessNode.value);
    if (preferred === harnessNode.value) return;
    harnessNode.value = preferred;
    modelNode.value = '';
    updateControls();
    updateCustomModel();
    void updateModels();
  }

  return { refresh, onShow: refresh, onRuntime };
}
