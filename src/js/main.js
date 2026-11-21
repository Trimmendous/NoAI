import { initSessions } from './components/sessions.js';
import { listLocalSessions, getLocalSession, editScheduledTask, retryScheduledTask } from './services/bridge.js';
import { initActivityMetrics } from './components/activity-metrics.js';
import { createStore, createInitialWorkspace, createConversation, createMessage } from './core/state.js';
import { HARNESSES, getHarness, preferredHarness, harnessOptionLabel, setHarnesses } from './core/catalog.js';
import { initTheme } from './core/theme.js';
import { isNative, runtimeStatus, chooseProject, startRun, cancelRun, listenRunEvents, providerUsage, resumeJobs, cancelResumeJob, setBackgroundMode, harnessModels, ensureProject, listScheduledTasks, createScheduledTask, cancelScheduledTask, getScheduledTaskRuns, listenScheduledTasks, connectEvents, activeRuns, activityMetrics } from './services/bridge.js';
import { loadInitialWorkspace, createWorkspacePersistence } from './services/workspace.js';
import { basename, toast } from './components/dom.js';
import { renderConversations } from './components/navigation.js';
import { createMessageRenderer } from './components/messages.js';
import { renderAccounts, renderActivity, renderDetails } from './components/panels.js';
import { renderJobs, countdown } from './components/jobs.js';
import { initScheduledTasks } from './components/scheduled-tasks.js';
import { initDigest } from './components/digest.js';
import { initModels } from './components/models.js';
import { getDigest, setDigest, runDigestNow, openWebLink, pauseScheduledTask, resumeScheduledTask } from './services/bridge.js';
import { setLinkHandler } from './components/markdown.js';
setLinkHandler(url => openWebLink(url).catch(error => toast(String(error.message || error), 'error')));
import { recoverJobMessage } from './core/recovery.js';

const $ = (selector) => document.querySelector(selector);
const native = isNative();
const renderMessages = createMessageRenderer($('#messages'));
const runs = new Map();
const activity = [];
let runtime = { harnesses: [], platform: native ? 'desktop' : 'browser' };
let view = 'home';
const viewScroll = new Map();
let search = '';
let draft = '';
let defaultHarness = '';
let defaultModel = '';
let defaultBypassPermissions = false;
let renderedConversation;
let sidebarSignature = '';
let modelSignature = '';
let editAction;
let persistenceAvailable = true;
let usage = [];
let jobs = [];
let checkingUsage = false;
let checkingJobs = false;
let preparingRun = false;
let lastUsageCheck = 0;
const modelCatalog = new Map();
const loadingModels = new Set();
let initial;
try { initial = await loadInitialWorkspace(); }
catch (error) {
  initial = createInitialWorkspace();
  persistenceAvailable = false;
  toast(`Saved data could not be opened. It will not be overwritten. ${error.message}`, 'error');
}
const store = createStore(initial);
const theme = initTheme(initial.preferences);
const persistence = createWorkspacePersistence({ onError: () => toast('Changes could not be saved. Keep Noai open and try again.', 'error') });
const scheduledTasks = initScheduledTasks({
  navigate: setView, list: listScheduledTasks, create: createScheduledTask, edit: editScheduledTask, retry: retryScheduledTask, cancel: cancelScheduledTask, pause: pauseScheduledTask, resume: resumeScheduledTask,
  getRuns: getScheduledTaskRuns, getResumeJobs: resumeJobs, fetchMetrics: activityMetrics, getModels: harnessModels, ensureProject, native, toast,
  getProjectPath: () => store.getState().projectPath,
  getAutoResume: () => store.getState().preferences.autoResume,
  getCustomModels: () => store.getState().preferences.customModels || {},
  getRuntime: () => runtime,
});

const modelsPanel = initModels({ getRuntime: () => runtime, getModels: harnessModels, getCustomModels: () => store.getState().preferences.customModels || {}, fetchMetrics: activityMetrics, native });
const digestPanel = initDigest({
  get: getDigest, set: setDigest, runNow: runDigestNow, getModels: harnessModels, native, toast,
  getRuntime: () => runtime,
  getCustomModels: () => store.getState().preferences.customModels || {},
});

const metricsPanel = initActivityMetrics({fetchMetrics:activityMetrics, native, fetchJobRuns:async()=>{
  const tasks=await listScheduledTasks(), results=[];
  // Bound IPC concurrency and retain only metadata, not private transcripts.
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,tasks.length)},async()=>{
    while(cursor<tasks.length){const task=tasks[cursor++];for(const run of await getScheduledTaskRuns(task.id)) {
      results.push({runId:run.runId,taskId:task.id,startedAt:run.startedAt,harness:run.harness || task.harness,
        model:[...(run.events || [])].reverse().find(event=>event.model)?.model || run.model || task.model,
        status:run.status==='needs_attention' && run.events?.at(-1)?.type==='error'?'failed':run.status});
    }}
  }));
  return results;
}});
let metricsTimer;
const sessionsPanel = initSessions({list:listLocalSessions, detail:getLocalSession, fetchMetrics:activityMetrics, getConversations:() => store.getState().conversations, navigate:setView, native});

function active() {
  const state = store.getState();
  return state.conversations.find(item => item.id === state.activeConversationId);
}
function running(conversationId = active()?.id) {
  return [...runs.values()].find(run => run.conversationId === conversationId);
}
function updateConversation(id, transform) {
  store.setState(state => ({ ...state, conversations: state.conversations.map(item => item.id === id ? transform(item) : item) }));
}
function savePreferences(changes) {
  store.setState(state => ({ ...state, preferences: { ...state.preferences, ...changes } }));
}
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  document.querySelectorAll('[aria-controls="sidebar"]').forEach(node => node.setAttribute('aria-expanded', String(open)));
}
function setView(next) {
  if (next !== 'session' && location.hash.startsWith('#session=')) history.replaceState({}, '', next === 'sessions' ? '#sessions' : `#${next}`);
  viewScroll.set(view, $('.main-content').scrollTop);
  view = next;
  setSidebar(false);
  render();
  $('.main-content').scrollTop = viewScroll.get(next) || 0;
  if (next === 'accounts' && Date.now() - lastUsageCheck > 60000) void refreshUsage();
  if (next === 'activity') void refreshJobs();
  if (next === 'home') void metricsPanel.refresh();
  if (next === 'sessions') void sessionsPanel.refresh();
  if (next === 'jobs') void scheduledTasks.onShow();
  if (next === 'digest') void digestPanel.refresh();
  if (next === 'models') void modelsPanel.refresh();
}
function selectConversation(id) {
  store.setState(state => ({ ...state, activeConversationId: id }));
  setView('chat');
}
function newChat() {
  defaultBypassPermissions = false;
  const previous = active();
  if (previous) { defaultHarness = previous.harness; defaultModel = previous.model; }
  draft = '';
  store.setState(state => ({ ...state, activeConversationId: null }));
  // A second click on New chat must also clear the empty-chat draft.
  $('#prompt-input').value = '';
  setView('chat');
  $('#prompt-input').focus();
}
function setDraft(value) {
  const conversation = active();
  if (conversation) updateConversation(conversation.id, item => ({ ...item, draft: value }));
  else draft = value;
  updateComposer();
}
function updateComposer() {
  const conversation = active();
  const run = running();
  const harness = conversation?.harness || defaultHarness;
  const detected = runtime.harnesses.find(item => item.id === harness);
  const project = conversation?.projectPath || store.getState().projectPath;
  $('#send-button').disabled = !$('#prompt-input').value.trim() || !!run || !native || !detected?.installed || preparingRun || !persistenceAvailable;
  $('#stop-button').hidden = !run;
  $('#stop-button').textContent = run?.waiting ? 'Cancel resume' : 'Stop';
  $('#harness-select').disabled = !!run || preparingRun;
  $('#model-select').disabled = !!run || preparingRun;
  $('#choose-project').disabled = !!run || preparingRun;
  $('#chat-bypass-permissions').disabled = !!run || preparingRun;
  $('#chat-bypass-permissions').checked = conversation?.dangerouslyBypassPermissions ?? defaultBypassPermissions;
  $('#chat-bypass-label').textContent = `Dangerously bypass permissions for ${getHarness(harness)?.label || harness}`;
  $('#chat-bypass-description').textContent = getHarness(harness)?.bypassDescription || '';
  $('#composer-status').textContent = run?.waiting ? `Waiting for quota · ${countdown(run.retryAt)} · Cancel to send a different instruction.`
    : run ? 'Working in your project · You can stop at any time.'
    : !persistenceAvailable ? 'Saved data is unavailable. Restart after resolving the storage error.'
    : !native ? 'Browser preview · Open the desktop app to chat with your local agents.'
    : preparingRun ? 'Preparing workspace…'
    : !detected?.installed ? `Install ${getHarness(harness)?.label} and sign in through its CLI, then refresh Accounts.`
    : !project ? 'A new workspace in ~/.noai will be created when you send.'
    : 'Enter to send · Shift + Enter for a new line · CLI permissions apply';
}
function renderModelOptions() {
  const conversation = active();
  const harness = conversation?.harness || defaultHarness;
  const model = conversation?.model ?? defaultModel;
  const models = [...new Set([...(store.getState().preferences.customModels?.[harness] || []), ...(model ? [model] : [])])];
  const discovered = modelCatalog.get(harness) || [];
  const choices = [...discovered, ...models.filter(id => !discovered.some(item => item.id === id)).map(id => ({ id, label: id }))];
  const signature = JSON.stringify([harness, model, choices]);
  if (signature !== modelSignature) {
    $('#model-select').replaceChildren(new Option('Harness default', ''), ...choices.map(item => new Option(item.label, item.id)), new Option('Custom model…', '__custom__'));
    $('#model-select').value = model;
    modelSignature = signature;
  }
  $('#harness-select').value = harness;
  if (native && !modelCatalog.has(harness) && !loadingModels.has(harness)) void loadModels(harness);
}

async function loadModels(harness) {
  loadingModels.add(harness);
  try { modelCatalog.set(harness, await harnessModels(harness)); }
  catch { modelCatalog.set(harness, []); }
  finally { loadingModels.delete(harness); renderModelOptions(); }
}
function render() {
  const state = store.getState();
  const conversation = active();
  for (const name of ['home', 'chat', 'models', 'accounts', 'activity', 'jobs', 'digest', 'sessions', 'session', 'job', 'job-conversation']) $(`#view-${name}`).hidden = name !== view;
  document.querySelectorAll('.nav-item[data-view]').forEach(button => {
    const selected = button.dataset.view === view || view === 'session' && button.dataset.view === 'sessions' || ['job', 'job-conversation'].includes(view) && button.dataset.view === 'jobs';
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#main-title').textContent = view === 'home' ? 'Dashboard' : view === 'models' ? 'Models' : view === 'chat' ? conversation?.title || 'New chat' : view === 'accounts' ? 'Accounts' : ['jobs', 'job', 'job-conversation'].includes(view) ? 'Jobs' : view === 'digest' ? 'Daily digest' : view === 'sessions' ? 'Sessions' : view === 'session' ? 'Session' : 'Activity';
  const project = conversation?.projectPath || state.projectPath;
  $('#project-label').textContent = state.projectPath ? basename(state.projectPath) : 'Automatic workspace';
  $('#project-label').title = state.projectPath || 'Create a UUID folder in ~/.noai when a chat starts';
  $('#header-project').textContent = project ? basename(project) : 'No project';
  $('#header-project').title = project || '';
  $('#rename-chat').hidden = !conversation || view !== 'chat';
  $('#delete-chat').hidden = !conversation || view !== 'chat';
  $('#delete-chat').disabled = !!running();
  const signature = JSON.stringify([state.activeConversationId, search, state.conversations.map(({ id, title, updatedAt, harness, projectPath }) => ({ id, title, updatedAt, harness, projectPath }))]);
  if (signature !== sidebarSignature) {
    renderConversations($('#conversation-list'), state, search, selectConversation);
    sidebarSignature = signature;
  }
  const selectedId = conversation?.id ?? null;
  if (selectedId !== renderedConversation) {
    $('#prompt-input').value = conversation?.draft || (conversation ? '' : draft);
    renderedConversation = selectedId;
  }
  $('#chat-welcome').hidden = !!conversation?.messages.length;
  renderMessages(conversation);
  renderModelOptions();
  updateComposer();
  if (!$('#details-panel').hidden) renderDetails($('#details-content'), conversation, state, !!running());
  if (view === 'accounts') renderAccounts($('#account-list'), runtime, native, usage, state.preferences.manualPlans, openPlanLabel);
  if (view === 'activity') {
    renderActivity($('#activity-list'), state, activity);
    renderJobs($('#resume-list'), jobs, stopJob);
  }
  theme.update(state.preferences);
  document.querySelectorAll('input[name="theme"], input[name="palette"]').forEach(input => { input.checked = input.value === state.preferences[input.name]; });
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} theme`);
  $('#auto-resume-setting').checked = state.preferences.autoResume;
  $('#background-mode-setting').checked = state.preferences.backgroundMode;
}

store.subscribe(state => {
  render();
  if (persistenceAvailable) persistence.schedule(state);
});

function renderHarnessOptions() {
  const selected = $('#harness-select').value;
  $('#harness-select').replaceChildren(...HARNESSES.map(harness => {
    const option = new Option(harnessOptionLabel(harness, runtime.harnesses), harness.id);
    option.disabled = !harness.available;
    return option;
  }));
  if (selected) $('#harness-select').value = selected;
}
renderHarnessOptions();

async function refreshRuntime() {
  $('#refresh-accounts').disabled = true;
  try {
    runtime = await runtimeStatus();
    setHarnesses(runtime.harnesses);
    const installed = runtime.harnesses.filter(item => item.installed && getHarness(item.id)?.available);
    $('#runtime-label').textContent = native ? `${installed.length} local agent${installed.length === 1 ? '' : 's'} available` : 'Desktop preview';
    $('.runtime-row').classList.toggle('is-ready', native && installed.length > 0);
    $('.runtime-row').classList.remove('is-error');
    if (!active()) {
      const preferred = preferredHarness(runtime.harnesses, defaultHarness);
      if (preferred !== defaultHarness) { defaultHarness = preferred; defaultModel = ''; }
    }
    renderHarnessOptions();
    scheduledTasks.onRuntime();
    digestPanel.onRuntime();
    if (view === 'models') void modelsPanel.refresh();
  } catch (error) {
    $('#runtime-label').textContent = 'Runtime unavailable';
    $('.runtime-row').classList.add('is-error');
    toast(`Could not check local agents: ${String(error)}`, 'error');
  } finally { $('#refresh-accounts').disabled = false; render(); }
}

async function refreshUsage() {
  if (checkingUsage || !native) return;
  checkingUsage = true;
  $('#refresh-accounts').disabled = true;
  try { usage = await providerUsage(); lastUsageCheck = Date.now(); }
  catch (error) { toast(`Could not refresh usage: ${String(error)}`, 'error'); }
  finally { checkingUsage = false; $('#refresh-accounts').disabled = false; render(); }
}

async function stopJob(jobId) {
  try { await cancelResumeJob(jobId); await refreshJobs(); }
  catch (error) { toast(`Could not cancel scheduled work: ${String(error)}`, 'error'); }
}

async function refreshJobs() {
  if (checkingJobs || !native) return;
  checkingJobs = true;
  try {
    jobs = await resumeJobs();
    let changed = false;
    const state = store.getState();
    const conversations = state.conversations.map(conversation => {
      let next = conversation;
      for (const job of jobs.filter(item => item.conversationId === conversation.id)) {
        const message = next.messages.find(item => item.runId === job.runId && item.role === 'assistant');
        if (!message) continue;
        const snapshotEventId = Math.max(0, ...(job.events || []).map(event => event.eventId || 0));
        if ((message.lastEventId || 0) > snapshotEventId) continue;
        const recovered = recoverJobMessage(message, job);
        const nativeSession = [...(job.events || [])].reverse().find(event => event.resumeId)?.resumeId;
        if (JSON.stringify(recovered) !== JSON.stringify(message) || nativeSession && nativeSession !== next.resumeId) {
          next = { ...next, resumeId: nativeSession || next.resumeId, messages: next.messages.map(item => item.id === message.id ? recovered : item) };
          changed = true;
        }
        if (['waiting', 'running'].includes(job.status)) {
          runs.set(job.runId, { runId: job.runId, conversationId: job.conversationId, messageId: message.id, harness: job.harness, waiting: job.status === 'waiting', retryAt: job.retryAt, scheduled: true });
        } else runs.delete(job.runId);
      }
      return next;
    });
    if (changed) store.setState({ ...state, conversations });
    else render();
  } catch (error) { console.error('Cannot read scheduled work:', String(error)); }
  finally { checkingJobs = false; }
}

function finishRun(runId, error, interrupted = false) {
  const run = runs.get(runId);
  if (!run) return;
  runs.delete(runId);
  updateConversation(run.conversationId, conversation => ({
    ...conversation,
    updatedAt: new Date().toISOString(),
    messages: [
      ...conversation.messages.map(message => message.id === run.messageId ? { ...message, status: error ? 'error' : interrupted ? 'interrupted' : 'complete', content: message.content || (error ? 'No response received.' : interrupted ? 'Stopped.' : 'The agent finished without a text response.') } : message),
      ...(error ? [createMessage('system', error)] : []),
    ],
  }));
  void persistence.flush().catch(() => {});
}

function onRunEvent(event) {
  if (view === 'home' && !metricsTimer) metricsTimer = setTimeout(() => { metricsTimer = null; void metricsPanel.refresh(); }, 500);
  let run = runs.get(event.runId);
  const conversation = store.getState().conversations.find(item => item.id === event.conversationId);
  const message = conversation?.messages.find(item => item.runId === event.runId && item.role === 'assistant');
  if (event.eventId && event.eventId <= (message?.lastEventId || 0)) return;
  if (!run && message) {
    run = {runId:event.runId, conversationId:conversation.id, messageId:message.id, harness:conversation.harness};
    runs.set(event.runId, run);
  }
  if (!run || run.conversationId !== event.conversationId) { void refreshJobs(); return; }
  if (event.eventId) updateConversation(run.conversationId, item => ({ ...item, messages: item.messages.map(message => message.id === run.messageId ? { ...message, lastEventId: event.eventId } : message) }));
  if (event.type === 'waiting') {
    run.waiting = true;
    run.scheduled = true;
    run.retryAt = event.retryAt;
    updateConversation(run.conversationId, item => ({ ...item, messages: item.messages.map(message => message.id === run.messageId ? { ...message, status: 'waiting' } : message) }));
    void refreshJobs();
  } else if (event.type === 'resumed') {
    run.waiting = false;
    updateConversation(run.conversationId, item => ({ ...item, messages: item.messages.map(message => message.id === run.messageId ? { ...message, status: 'streaming' } : message) }));
    void refreshJobs();
  } else if (event.type === 'session' && event.resumeId) {
    updateConversation(run.conversationId, item => ({ ...item, resumeId: event.resumeId }));
  } else if (event.type === 'text' && event.text) {
    updateConversation(run.conversationId, item => ({ ...item, messages: item.messages.map(message => message.id === run.messageId ? { ...message, content: message.content + (message.content ? '\n\n' : '') + event.text } : message) }));
  } else if (event.type === 'activity') {
    activity.unshift({ id: crypto.randomUUID(), text: event.text || 'Agent working', title: getHarness(run.harness)?.label, at: new Date().toISOString() });
    if (activity.length > 100) activity.length = 100;
    if (view === 'activity') renderActivity($('#activity-list'), store.getState(), activity);
  } else if (event.type === 'error') {
    finishRun(event.runId, event.text || 'The agent could not finish this request.');
    void refreshJobs();
  } else if (event.type === 'done') {
    finishRun(event.runId, null, run.stopping || event.text === 'Cancelled');
    void refreshJobs();
  }
}

$('#composer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('#send-button').disabled) return;
  const prompt = $('#prompt-input').value.trim();
  let conversation = active();
  const selectedHarness = conversation?.harness || defaultHarness;
  const selectedModel = conversation?.model ?? defaultModel;
  const dangerouslyBypassPermissions = conversation?.dangerouslyBypassPermissions ?? defaultBypassPermissions;
  preparingRun = true;
  updateComposer();
  try {
    const projectPath = await ensureProject(conversation?.projectPath || store.getState().projectPath || null);
    if (!conversation) {
      conversation = createConversation({ title: prompt.slice(0, 54), harness: selectedHarness, model: selectedModel, projectPath, dangerouslyBypassPermissions });
      store.setState(state => ({ ...state, activeConversationId: conversation.id, conversations: [...state.conversations, conversation] }));
    } else if (conversation.projectPath !== projectPath) {
      conversation = { ...conversation, projectPath };
      updateConversation(conversation.id, item => ({ ...item, projectPath }));
    }
  } catch (error) {
    toast(`Cannot prepare workspace: ${String(error)}`, 'error');
    return;
  } finally {
    preparingRun = false;
    updateComposer();
  }
  const runId = crypto.randomUUID();
  const message = createMessage('assistant', '', { status: 'streaming', runId });
  runs.set(runId, { runId, conversationId: conversation.id, messageId: message.id, harness: conversation.harness });
  $('#prompt-input').value = '';
  draft = '';
  updateConversation(conversation.id, item => ({ ...item, draft: '', updatedAt: new Date().toISOString(), messages: [...item.messages, createMessage('user', prompt), message] }));
  try {
    await persistence.flush();
    await startRun({ runId, conversationId: conversation.id, harness: conversation.harness, model: conversation.model || null, projectPath: conversation.projectPath, prompt, resumeId: conversation.resumeId, dangerouslyBypassPermissions: conversation.dangerouslyBypassPermissions, autoResume: store.getState().preferences.autoResume });
  } catch (error) { finishRun(runId, String(error)); }
});

$('#stop-button').addEventListener('click', async () => {
  const run = running();
  if (!run) return;
  run.stopping = true;
  try {
    if (run.scheduled) await cancelResumeJob(run.runId);
    else await cancelRun(run.runId);
  }
  catch (error) { run.stopping = false; toast(`Could not stop this run: ${String(error)}`, 'error'); }
});
$('#prompt-input').addEventListener('input', event => setDraft(event.target.value));
$('#prompt-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer-form').requestSubmit();
  }
});
$('#new-chat').addEventListener('click', newChat);
$('#conversation-search').addEventListener('input', event => { search = event.target.value; render(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); setView(button.dataset.view); }));
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  $('#prompt-input').value = `${button.dataset.prompt}. `;
  setDraft($('#prompt-input').value);
  $('#prompt-input').focus();
}));
$('#choose-project').addEventListener('click', async () => {
  if (!native) { toast('Choose project folders in the Noai desktop app.'); return; }
  try {
    const projectPath = await chooseProject();
    if (!projectPath) return;
    store.setState(state => ({ ...state, projectPath, activeConversationId: null }));
    draft = '';
    $('#prompt-input').value = '';
    setView('chat');
  } catch (error) { toast(String(error), 'error'); }
});
$('#chat-bypass-permissions').addEventListener('change', event => {
  const enabled = event.target.checked;
  const conversation = active();
  if (conversation) updateConversation(conversation.id, item => ({ ...item, dangerouslyBypassPermissions: enabled }));
  else { defaultBypassPermissions = enabled; updateComposer(); }
});
$('#harness-select').addEventListener('change', event => {
  defaultBypassPermissions = false;
  const harness = event.target.value;
  const conversation = active();
  if (conversation?.messages.length) {
    defaultHarness = harness;
    defaultModel = '';
    draft = '';
    store.setState(state => ({ ...state, projectPath: conversation.projectPath, activeConversationId: null }));
    toast('Started a fresh chat for this agent. Your previous conversation is saved.');
  } else if (conversation) updateConversation(conversation.id, item => ({ ...item, harness, model: '', resumeId: null, dangerouslyBypassPermissions: false }));
  else { defaultHarness = harness; defaultModel = ''; render(); }
});
function setModel(model) {
  const conversation = active();
  if (conversation) updateConversation(conversation.id, item => ({ ...item, model }));
  else { defaultModel = model; render(); }
}
$('#model-select').addEventListener('change', event => {
  if (event.target.value === '__custom__') {
    $('#custom-model-input').value = active()?.model || defaultModel;
    $('#model-dialog').showModal();
    $('#custom-model-input').focus();
    event.target.value = active()?.model || defaultModel;
  } else setModel(event.target.value);
});
$('#custom-model-form').addEventListener('submit', event => {
  event.preventDefault();
  const model = $('#custom-model-input').value.trim();
  if (!model) return;
  const harness = active()?.harness || defaultHarness;
  const current = store.getState().preferences.customModels || {};
  savePreferences({ customModels: { ...current, [harness]: [...new Set([...(current[harness] || []), model])] } });
  setModel(model);
  $('#model-dialog').close();
});
$('#model-cancel').addEventListener('click', () => $('#model-dialog').close());
$('#open-settings').addEventListener('click', () => { setSidebar(false); $('#settings-dialog').showModal(); });
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('change', event => {
  if (['theme', 'palette'].includes(event.target.name)) savePreferences({ [event.target.name]: event.target.value });
});
$('#auto-resume-setting').addEventListener('change', event => savePreferences({ autoResume: event.target.checked }));
$('#background-mode-setting').addEventListener('change', async event => {
  const enabled = event.target.checked;
  try { await setBackgroundMode(enabled); savePreferences({ backgroundMode: enabled }); }
  catch (error) { render(); toast(`Could not change background behavior: ${String(error)}`, 'error'); }
});
$('#theme-toggle').addEventListener('click', () => savePreferences({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }));
function showDetails(show) {
  $('#details-panel').hidden = !show;
  $('#details-toggle').setAttribute('aria-expanded', String(show));
  $('#details-toggle').setAttribute('aria-label', show ? 'Hide details' : 'Show details');
  render();
}
$('#details-toggle').addEventListener('click', () => showDetails($('#details-panel').hidden));
$('[data-action="close-details"]').addEventListener('click', () => showDetails(false));
$('[data-action="toggle-sidebar"]').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
$('#sidebar-toggle').addEventListener('click', () => setSidebar(false));
$('#refresh-accounts').addEventListener('click', async () => { await refreshRuntime(); await refreshUsage(); void loadModels(active()?.harness || defaultHarness); });

function openPlanLabel(id, label) {
  editAction = { action: 'plan', id };
  $('#edit-title').textContent = `${label} plan label`;
  $('#edit-description').textContent = 'A label you supply when the provider does not report your plan. It does not change billing or determine remaining quota. Leave empty to remove it.';
  $('#edit-label').hidden = false;
  $('#edit-input').required = false;
  $('#edit-input').value = store.getState().preferences.manualPlans[id] || '';
  $('#edit-confirm').textContent = 'Save label';
  $('#edit-dialog').showModal();
}

function openEdit(action) {
  const conversation = active();
  if (!conversation || running() && action === 'delete') return;
  editAction = { action, id: conversation.id };
  $('#edit-title').textContent = action === 'rename' ? 'Rename conversation' : 'Delete conversation?';
  $('#edit-description').textContent = action === 'rename' ? 'Give this conversation a useful name.' : 'This removes the saved chat from Noai. Project files and the agent’s own history stay in place.';
  $('#edit-label').hidden = action === 'delete';
  $('#edit-input').required = action === 'rename';
  $('#edit-input').value = conversation.title;
  $('#edit-confirm').textContent = action === 'rename' ? 'Save name' : 'Delete conversation';
  $('#edit-dialog').showModal();
}
$('#rename-chat').addEventListener('click', () => openEdit('rename'));
$('#delete-chat').addEventListener('click', () => openEdit('delete'));
$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!editAction) return;
  if (editAction.action === 'plan') {
    savePreferences({ manualPlans: { ...store.getState().preferences.manualPlans, [editAction.id]: $('#edit-input').value.trim().slice(0, 80) } });
  } else if (editAction.action === 'rename') {
    const title = $('#edit-input').value.trim();
    if (!title) return;
    updateConversation(editAction.id, item => ({ ...item, title }));
  } else if (!running(editAction.id)) {
    store.setState(state => ({ ...state, conversations: state.conversations.filter(item => item.id !== editAction.id), activeConversationId: state.activeConversationId === editAction.id ? null : state.activeConversationId }));
  }
  $('#edit-dialog').close();
  editAction = null;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setSidebar(false);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); newChat(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) void persistence.flush().catch(() => {}); });

render();
try { await listenRunEvents(onRunEvent); }
catch (error) { persistenceAvailable = false; toast(`Cannot receive agent responses: ${String(error)}`, 'error'); }
await refreshRuntime();
try { await setBackgroundMode(store.getState().preferences.backgroundMode); }
catch (error) { toast(`Background mode is unavailable: ${String(error)}`, 'error'); }
await refreshJobs();
try { await listenScheduledTasks(() => { if (['jobs', 'job', 'job-conversation'].includes(view)) void scheduledTasks.refresh(); if (view === 'digest') void digestPanel.refresh(); }); }
catch (error) { toast(`Job updates are unavailable: ${String(error)}`, 'error'); }
try {
  for (const item of await activeRuns()) {
    const conversation = store.getState().conversations.find(chat => chat.id === item.conversationId);
    const message = conversation?.messages.find(message => message.runId === item.runId && message.role === 'assistant');
    if (message && !runs.has(item.runId)) {
      runs.set(item.runId, { ...item, messageId:message.id, harness:conversation.harness });
      updateConversation(conversation.id, chat => ({...chat, messages:chat.messages.map(saved => saved.id === message.id ? {...saved,status:'streaming'} : saved)}));
    }
  }
  await connectEvents();
} catch (error) { toast(`Cannot reconnect to agent output: ${String(error)}`, 'error'); }
void refreshUsage();
setInterval(() => {
  if (!document.hidden && ['jobs', 'job', 'job-conversation'].includes(view)) void scheduledTasks.refresh();
  if (!document.hidden && view === 'home') void metricsPanel.refresh();
  if (!document.hidden && (view === 'activity' || jobs.some(job => ['waiting', 'running'].includes(job.status)))) void refreshJobs();
}, 30000);
setInterval(() => {
  if (document.hidden) return;
  if (running()?.waiting) updateComposer();
  if (view === 'activity') renderJobs($('#resume-list'), jobs, stopJob);
}, 1000);
setInterval(() => { if (view === 'accounts' && !document.hidden) void refreshUsage(); }, 120000);

// Native close waits for the final workspace write instead of losing debounced edits.
if (native && window.__TAURI__.window?.getCurrentWindow) {
  let closing = false;
  const currentWindow = window.__TAURI__.window.getCurrentWindow();
  await currentWindow.onCloseRequested(async event => {
    if (closing) return;
    event.preventDefault();
    try {
      await persistence.flush();
      if (store.getState().preferences.backgroundMode) await currentWindow.hide();
      else { closing = true; await currentWindow.close(); }
    }
    catch { toast('Could not save before closing. Please try again.', 'error'); }
  });
}

void sessionsPanel.route();

if (view === 'home') void metricsPanel.refresh();
