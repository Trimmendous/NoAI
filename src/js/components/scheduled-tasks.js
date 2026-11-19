import { parseLocalTime } from '../core/schedule-time.js';
import { HARNESSES, getHarness, preferredHarness, harnessOptionLabel } from '../core/catalog.js';
import { basename, element } from './dom.js';
import { normalizeMetrics } from '../core/metrics.js';
import { renderSessionStats } from './session-stats.js';

const $ = selector => document.querySelector(selector);
const STATUS = { scheduled: 'Scheduled', running: 'Running', waiting: 'Waiting for reset', completed: 'Succeeded', cancelled: 'Cancelled', needs_attention: 'Paused', paused: 'Paused', failed: 'Failed' };
const PAGE_SIZE = 10;

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
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} day${seconds === 86400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return `Every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
}

export function initScheduledTasks({ list, create, edit, retry, cancel, getRuns, getResumeJobs, fetchMetrics, ensureProject, getModels, native, getProjectPath, getAutoResume, getCustomModels, getRuntime = () => null, toast, navigate }) {
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
  let editLocked = false;
  let renderedSignature = '';
  let completedPage = 0;
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
  let selectedJob = null;
  let selectedRun = null;
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
    const later = form.elements['scheduled-start'].value === 'later';
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
    editing = null; editLocked = false;
    form.querySelectorAll('input, select, textarea').forEach(node => { node.disabled = false; });
    form.reset(); harnessTouched = false; harnessNode.value = preferredHarness(detected());
    customModelNode.hidden = true;
    $('#scheduled-custom-model-label').hidden = true;
    customModelNode.required = false;
    $('#scheduled-auto-resume').checked = !!getAutoResume();
    $('#scheduled-form-title').textContent = 'New job';
    $('#scheduled-edit-cancel').hidden = true;
    submit.textContent = 'Create job'; submit.disabled = !native;
    permissionControls(true); updateControls(); void updateModels();
  }
  function lockEditor() {
    if (!editing) return;
    const latest = tasks.find(task => task.id === editing.id);
    editLocked = !latest || latest.status !== 'scheduled' || (latest.lastRunId || null) !== editing.lastRunId;
    submit.disabled = busy || editLocked || !native;
    form.querySelectorAll('input, select, textarea').forEach(node => { node.disabled = editLocked; });
    permissionControls();
    if (editLocked) $('#scheduled-form-status').textContent = 'This job has started or changed. Editing is closed; cancel editing to return to the list.';
  }
  async function beginEdit(task) {
    if (busy || task.status !== 'scheduled') return;
    resetForm(); editing = {id:task.id, lastRunId:task.lastRunId || null};
    $('#scheduled-form-title').textContent = 'Edit job';
    $('#scheduled-edit-cancel').hidden = false;
    submit.textContent = 'Save changes';
    $('#scheduled-title-input').value = task.title;
    $('#scheduled-prompt').value = task.prompt;
    $('#scheduled-project').value = task.projectPath || '';
    harnessNode.value = task.harness;
    $('#scheduled-auto-resume').checked = task.autoResume;
    $('#scheduled-bypass-permissions').checked = !!task.dangerouslyBypassPermissions;
    permissionControls(true);
    $('#scheduled-permissions').value = task.permissions || 'provider-default';
    form.elements['scheduled-start'].value = 'later';
    const date = new Date((task.nextRunAt || Date.now()/1000) * 1000);
    $('#scheduled-time').value = new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,19);
    form.elements['scheduled-repeat'].value = task.intervalSeconds ? 'interval' : 'once';
    if (task.intervalSeconds) {
      const unit = [86400, 3600, 60, 1].find(unit => task.intervalSeconds % unit === 0);
      $('#scheduled-interval-unit').value = String(unit);
      $('#scheduled-interval').value = task.intervalSeconds / unit;
    }
    modelNode.value = ''; updateControls();
    await updateModels();
    if (editing?.id !== task.id) return;
    const known = [...modelNode.options].some(option => option.value === task.model);
    modelNode.value = task.model ? known ? task.model : '__custom__' : '';
    customModelNode.value = task.model || ''; updateCustomModel();
    $('#scheduled-form-status').textContent = 'Changes apply to the next run. Saving closes once it starts.';
    lockEditor();
    form.scrollIntoView({block:'start', behavior:'smooth'});
    $('#scheduled-title-input').focus({preventScroll:true});
  }
  $('#scheduled-edit-cancel').addEventListener('click', () => {
    if (busy) return;
    resetForm(); $('#scheduled-form-status').textContent = '';
    listNode.scrollIntoView({block:'start'});
  });

  function button(label, action, className = 'secondary-button') {
    const node = element('button', className, label);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
  }

  function retryButton(task) {
    if (!retry || !['needs_attention', 'paused', 'failed', 'cancelled'].includes(task.status)) return null;
    return button('Retry job', async event => {
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
    selectedJob = task.id; selectedRun = run?.runId || null; conversationOpen = false;
    renderDetail(); navigate('job'); $('#view-job').parentElement.scrollTop=0;
    $('#job-heading').focus();
  }

  function renderDetail() {
    const task = tasks.find(task => task.id === selectedJob);
    if (!task) return;
    const runs = [...(runCache.get(task.id) || [])].sort((a, b) => b.startedAt - a.startedAt);
    // An explicitly selected occurrence must never become a different run.
    const run = selectedRun ? runs.find(run => run.runId === selectedRun) : runs.find(run => run.runId === task.lastRunId) || runs[0];
    if (run) selectedRun = run.runId;
    const signature = JSON.stringify([task, runs, selectedRun]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    const promptOpen = $('#job-content .job-prompt')?.open || false;
    $('#job-heading').textContent = task.title;
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
    actions.append(conversation);
    const retryAction = (!selectedRun || selectedRun === task.lastRunId) ? retryButton(task) : null;
    if (retryAction) actions.append(retryAction);
    content.insertBefore(actions,prompt);
    if (task.status === 'scheduled' && task.pendingResumeId) content.insertBefore(element('p', 'scheduled-card-subtitle', `Retry scheduled: ${formatScheduledTime(task.nextRunAt)} · will continue the saved conversation.`), prompt);
    if (runs.length > 1 || selectedRun && !run) {
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
      const body = element('pre', 'job-message-text', text);
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
      const role = event.type === 'text' ? 'Assistant' : event.type === 'reasoning' || event.type === 'thinking' ? 'Thinking' : event.type === 'activity' ? 'Tool activity' : event.type;
      message(role, event.text, !['text', 'error'].includes(event.type));
    }
    if (!(run?.events || []).some(event => event.text)) fragment.append(element('p', 'scheduled-empty', runErrors.has(task.id) ? 'Could not load saved history. Return to the job and refresh to retry.' : run && ['running', 'waiting'].includes(run.status) ? 'No conversation output recorded yet.' : 'No conversation history was saved for this occurrence. A transcript cannot be displayed.'));
    stream.replaceChildren(fragment);
  }

  $('#job-back').addEventListener('click', () => { conversationOpen = false; navigate('jobs'); $('#view-jobs').parentElement.scrollTop = listScroll; });
  $('#job-conversation-back').addEventListener('click', () => { conversationOpen = false; navigate('job'); $('#job-open-conversation')?.focus({ preventScroll: true }); });
  $('#job-refresh').addEventListener('click', () => void refresh());

  function renderCard(task, completedRun = null) {
    const runs = [...(runCache.get(task.id) || [])].sort((a, b) => b.startedAt - a.startedAt);
    const latest = completedRun || runs.find(run => run.runId === task.lastRunId) || runs[0];
    const status = completedRun || task.status === 'running' && latest ? runStatus(latest) : task.status;
    const card = element('article', 'scheduled-card');
    const header = element('div', 'scheduled-card-header');
    const title = element('h4');
    title.append(button(task.title, () => openJob(task, completedRun), 'job-title-button'));
    header.append(title, badge(status));
    card.addEventListener('click', event => { if (!event.target.closest('button, a, input')) openJob(task, completedRun); });
    card.append(header, element('p', 'scheduled-agent', agentLabel(task, completedRun)), element('p', 'scheduled-card-subtitle', task.projectPath ? basename(task.projectPath) : ''));
    const meta = element('div', 'scheduled-card-meta');
    meta.append(element('span', '', formatScheduledInterval(task.intervalSeconds)));
    if (task.nextRunAt && task.status === 'scheduled') meta.append(element('span', '', `Next run: ${formatScheduledTime(task.nextRunAt)}`));
    if (task.dangerouslyBypassPermissions) meta.append(element('span', 'permission-badge', 'Permission bypass enabled'));
    card.append(meta);
    if (status === 'needs_attention') card.append(element('p', 'scheduled-card-subtitle', 'Paused · needs attention before work can continue.'));
    if (status === 'waiting') {
      const retry = latest?.retryAt || [...(latest?.events || [])].reverse().find(event => event.retryAt)?.retryAt;
      card.append(element('p', 'scheduled-waiting', retry ? `Token reset: ${formatScheduledTime(retry)}` : 'Waiting for token reset'));
    }
    if (completedRun) card.append(element('p', 'scheduled-card-subtitle', `Finished: ${formatScheduledTime(completedRun.finishedAt || completedRun.startedAt)}`));
    const actions = element('div', 'scheduled-card-actions');
    actions.append(button('Open job', () => openJob(task, completedRun)));
    const retryAction = (!completedRun || completedRun.runId === task.lastRunId) ? retryButton(task) : null;
    if (retryAction) actions.append(retryAction);
    if (!completedRun && task.status === 'scheduled' && edit) {
      const editButton = element('button', 'secondary-button', 'Edit job');
      editButton.type = 'button';
      editButton.addEventListener('click', () => void beginEdit(task));
      actions.append(editButton);
    }
    if (!completedRun && ['scheduled', 'running', 'waiting', 'needs_attention', 'paused', 'failed'].includes(task.status)) {
      const stop = element('button', 'secondary-button', 'Cancel job');
      stop.type = 'button';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try { await cancel(task.id); toast('Job cancelled.'); await refresh(); }
        catch (error) { toast(`Could not cancel job: ${String(error)}`, 'error'); stop.disabled = false; }
      });
      actions.append(stop);
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  function renderList() {
    const signature = JSON.stringify([tasks, completedPage, [...runCache], [...runErrors]]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const fragment = document.createDocumentFragment();
    const groups = groupJobs(tasks);
    const completed = groups[2].map(task => ({task, run: null}));
    for (const task of tasks.filter(task => task.intervalSeconds)) {
      for (const run of runCache.get(task.id) || []) {
        if (['completed', 'failed', 'cancelled'].includes(runStatus(run))) completed.push({task, run});
      }
    }
    completed.sort((a, b) => (b.run?.finishedAt || b.task.createdAt || 0) - (a.run?.finishedAt || a.task.createdAt || 0));
    groups[2] = completed;
    const headings = ['Recurring jobs', 'One-time jobs', 'Completed jobs'];
    const descriptions = ['The work that comes around again.', 'One thing at a time.', 'A record of what’s finished.'];
    groups.forEach((group, index) => {
      const section = element('section', 'scheduled-group');
      section.setAttribute('aria-label', headings[index]);
      section.append(element('h3', '', `${headings[index]} · ${group.length}`), element('p', 'scheduled-group-description', descriptions[index]));
      const pages = Math.max(1, Math.ceil(group.length / PAGE_SIZE));
      if (index === 2) completedPage = Math.min(completedPage, pages - 1);
      const visible = index === 2 ? group.slice(completedPage * PAGE_SIZE, (completedPage + 1) * PAGE_SIZE) : group;
      if (!group.length) section.append(element('p', 'scheduled-empty', 'No jobs in this section.'));
      visible.forEach(item => section.append(index === 2 ? renderCard(item.task, item.run) : renderCard(item)));
      if (index === 2 && group.length) {
        const pagination = element('nav', 'scheduled-pagination');
        pagination.setAttribute('aria-label', 'Completed jobs pages');
        for (const [label, delta] of [['Previous', -1], ['Next', 1]]) {
          const button = element('button', 'secondary-button', label);
          button.type = 'button';
          button.disabled = delta < 0 ? completedPage === 0 : completedPage === pages - 1;
          button.addEventListener('click', () => { completedPage += delta; renderList(); listNode.querySelector('.scheduled-pagination')?.scrollIntoView({ block: 'nearest' }); });
          if (delta === 1) pagination.append(element('span', '', `Page ${completedPage + 1} of ${pages} · ${group.length} jobs`));
          pagination.append(button);
        }
        section.append(pagination);
      }
      fragment.append(section);
    });
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
    const later = form.elements['scheduled-start'].value === 'later';
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
    const editTarget = editing;
    $('#scheduled-edit-cancel').disabled = true;
    $('#scheduled-form-status').textContent = editTarget ? 'Saving changes…' : 'Creating job…';
    try {
      const enteredPath = $('#scheduled-project').value.trim();
      const projectPath = enteredPath || await ensureProject();
      if (!projectPath) throw new Error('Could not create a job folder.');
      const input = { permissions: $('#scheduled-permissions').value, title, prompt, harness: harnessNode.value, model: (modelNode.value === '__custom__' ? customModelNode.value.trim() : modelNode.value) || null, projectPath, startAt, intervalSeconds, autoResume: $('#scheduled-auto-resume').checked, dangerouslyBypassPermissions: $('#scheduled-bypass-permissions').checked };
      if (editTarget) await edit(editTarget.id, input, editTarget.lastRunId);
      else await create(input);
      resetForm();
      $('#scheduled-form-status').textContent = editTarget ? 'Changes saved.' : 'Job created.';
      toast(editTarget ? 'Job updated.' : 'Job created.');
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
