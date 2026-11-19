import { element } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { HARNESSES, getHarness, preferredHarness, harnessOptionLabel } from '../core/catalog.js';

const $ = selector => document.querySelector(selector);

/** Next epoch second at local `HH:MM`, strictly in the future. */
export function nextLocalOccurrence(time, now = new Date()) {
  const [hours, minutes] = String(time).split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return 0;
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.floor(next.getTime() / 1000);
}

export function localTimeOf(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The digest is the agent's final message; earlier blocks are preamble. */
export function digestText(run) {
  const texts = (run?.events || []).filter(event => event.type === 'text' && event.text?.trim());
  return texts.at(-1)?.text || '';
}

export function isEnabled(task) {
  return !!task && !['disabled', 'cancelled'].includes(task.status);
}

const when = seconds => new Date(seconds * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function initDigest({ get, set, runNow, getModels, getCustomModels, getRuntime, native, toast }) {
  const form = $('#digest-form');
  const enabledNode = $('#digest-enabled');
  const harnessNode = $('#digest-harness');
  const modelNode = $('#digest-model');
  const customNode = $('#digest-custom-model');
  const status = $('#digest-form-status');
  const output = $('#digest-output');
  const history = $('#digest-history');
  const modelCache = new Map();
  let state = { task: null, runs: [] };
  let selectedRunId = null;
  let dirty = false;
  let busy = false;

  function renderHarnesses() {
    const previous = harnessNode.value;
    const detected = getRuntime()?.harnesses || [];
    harnessNode.replaceChildren(...HARNESSES.filter(item => item.available).map(item => new Option(harnessOptionLabel(item, detected), item.id)));
    harnessNode.value = state.task?.harness || (dirty && previous) || preferredHarness(detected, previous);
  }

  function updateCustom() {
    customNode.hidden = modelNode.value !== '__custom__';
    $('#digest-custom-model-label').hidden = customNode.hidden;
    customNode.required = !customNode.hidden;
  }

  async function renderModels(selected = modelNode.value) {
    const harness = harnessNode.value;
    const discovered = modelCache.get(harness) || [];
    const custom = (getCustomModels()?.[harness] || []).filter(id => !discovered.some(item => item.id === id)).map(id => ({ id, label: id }));
    const choices = [...discovered, ...custom];
    const known = !selected || choices.some(item => item.id === selected) || selected === '__custom__';
    modelNode.replaceChildren(new Option('Agent default', ''), ...choices.map(item => new Option(item.label || item.id, item.id)), new Option('Custom model…', '__custom__'));
    if (known) modelNode.value = selected;
    else { modelNode.value = '__custom__'; customNode.value = selected; }
    updateCustom();
    if (modelCache.has(harness) || !native) return;
    modelCache.set(harness, []);
    try {
      const found = await getModels(harness);
      modelCache.set(harness, (Array.isArray(found) ? found : []).map(item => typeof item === 'string' ? { id: item, label: item } : item));
      if (harnessNode.value === harness) void renderModels(modelNode.value === '__custom__' ? customNode.value : modelNode.value);
    } catch { /* Keep defaults and custom IDs. */ }
  }

  function scheduleLabel(task) {
    if (!native) return 'Open the desktop app to schedule a digest.';
    if (!isEnabled(task)) return 'Off';
    const agent = `${getHarness(task.harness)?.label || task.harness}${task.model ? ` · ${task.model}` : ''}`;
    if (task.status === 'running') return `Writing now · ${agent}`;
    return task.nextRunAt ? `Next digest ${when(task.nextRunAt)} · ${agent}` : `On · ${agent}`;
  }

  function renderSettings() {
    const task = state.task;
    $('#digest-schedule-status').textContent = scheduleLabel(task);
    if (dirty) return;
    enabledNode.checked = isEnabled(task);
    if (task?.anchorAt) $('#digest-time').value = localTimeOf(task.anchorAt);
    renderHarnesses();
    if (task?.harness) harnessNode.value = task.harness;
    void renderModels(task?.model || '');
  }

  function renderOutput() {
    const runs = state.runs || [];
    const run = runs.find(item => item.runId === selectedRunId) || runs.find(item => digestText(item)) || runs[0];
    output.replaceChildren();
    if (!run) {
      const empty = element('div', 'content-placeholder');
      empty.append(element('h3', '', 'No digest yet'), element('p', '', 'Turn on the daily digest, or write one now.'));
      output.append(empty);
    } else {
      const meta = element('p', 'digest-meta', `${when(run.startedAt)} · ${getHarness(run.harness)?.label || run.harness || ''}${run.model ? ` · ${run.model}` : ''}`);
      output.append(meta);
      const text = digestText(run);
      if (run.status === 'running') output.append(element('p', 'digest-pending', text ? 'Still writing…' : 'Writing your digest…'));
      if (text) output.append(renderMarkdown(text));
      else if (run.status !== 'running') output.append(element('p', 'digest-error', run.result || 'This digest did not produce a report.'));
    }
    history.replaceChildren();
    const earlier = runs.filter(item => item !== run).slice(0, 14);
    if (!earlier.length) history.append(element('p', 'metrics-empty', 'Earlier digests will be listed here.'));
    for (const item of earlier) {
      const button = element('button', `digest-history-item status-${item.status}`);
      button.type = 'button';
      button.append(element('span', '', when(item.startedAt)), element('small', '', item.status === 'completed' ? 'Ready' : item.status.replace('_', ' ')));
      button.addEventListener('click', () => { selectedRunId = item.runId; renderOutput(); output.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      history.append(button);
    }
  }

  async function refresh() {
    try {
      state = await get();
      renderSettings();
      renderOutput();
    } catch (error) {
      status.textContent = `Could not load the digest: ${error.message || error}`;
    }
  }

  function model() {
    if (modelNode.value === '__custom__') return customNode.value.trim() || null;
    return modelNode.value || null;
  }

  async function save(event) {
    event?.preventDefault();
    if (busy || !native) return;
    const startAt = nextLocalOccurrence($('#digest-time').value);
    if (enabledNode.checked && !startAt) { status.textContent = 'Choose a time.'; return; }
    if (!enabledNode.checked && !state.task) { status.textContent = 'The daily digest is off.'; dirty = false; return; }
    busy = true;
    status.textContent = 'Saving…';
    try {
      const task = await set({ enabled: enabledNode.checked, harness: harnessNode.value, model: model(), startAt, autoResume: true });
      dirty = false;
      state = { ...state, task };
      status.textContent = enabledNode.checked ? 'Saved.' : 'Daily digest turned off.';
      renderSettings();
    } catch (error) {
      status.textContent = String(error.message || error);
    } finally { busy = false; }
  }

  async function writeNow() {
    if (busy || !native) return;
    if (!isEnabled(state.task) || dirty) {
      enabledNode.checked = true;
      await save();
      if (!isEnabled(state.task)) return;
    }
    busy = true;
    try {
      await runNow();
      selectedRunId = null;
      status.textContent = 'Writing a digest now. It will appear below when ready.';
      toast('Digest started');
      setTimeout(() => void refresh(), 1500);
    } catch (error) {
      status.textContent = String(error.message || error);
    } finally { busy = false; }
  }

  form.addEventListener('submit', save);
  form.addEventListener('input', () => { dirty = true; status.textContent = ''; });
  enabledNode.addEventListener('change', () => void save());
  harnessNode.addEventListener('change', () => { dirty = true; modelNode.value = ''; void renderModels(''); });
  modelNode.addEventListener('change', () => { updateCustom(); if (!customNode.hidden) customNode.focus(); });
  $('#digest-run-now').addEventListener('click', () => void writeNow());
  $('#digest-refresh').addEventListener('click', () => void refresh());
  $('#digest-run-now').disabled = !native;
  $('#digest-save').disabled = !native;
  enabledNode.disabled = !native;
  renderHarnesses();
  void renderModels('');

  function onRuntime() {
    if (dirty) return;
    const before = harnessNode.value;
    renderHarnesses();
    if (harnessNode.value !== before) void renderModels(state.task?.model || '');
  }

  return { refresh, onRuntime };
}
