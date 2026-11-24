import { initSessions } from './components/sessions.js';
import { listLocalSessions, getLocalSession, editScheduledTask, retryScheduledTask } from './services/bridge.js';
import { initActivityMetrics } from './components/activity-metrics.js';
import { createStore, createInitialWorkspace, createConversation, createMessage } from './core/state.js';
import { HARNESSES, getHarness, preferredHarness, harnessOptionLabel, setHarnesses } from './core/catalog.js';
import { initTheme } from './core/theme.js';
import { isNative, runtimeStatus, chooseProject, startRun, cancelRun, listenRunEvents, providerUsage, resumeJobs, cancelResumeJob, setBackgroundMode, harnessModels, ensureProject, listScheduledTasks, createScheduledTask, cancelScheduledTask, getScheduledTaskRuns, listenScheduledTasks, connectEvents, activeRuns, activityMetrics } from './services/bridge.js';
import { loadInitialWorkspace, createWorkspacePersistence } from './services/workspace.js';
import { basename, element, toast } from './components/dom.js';
import { createMessageRenderer } from './components/messages.js';
import { renderAccounts, renderActivity } from './components/panels.js';
import { renderJobs, countdown } from './components/jobs.js';
import { initScheduledTasks } from './components/scheduled-tasks.js';
import { initDigest } from './components/digest.js';
import { initModels } from './components/models.js';
import { getDigest, setDigest, runDigestNow, openWebLink, pauseScheduledTask, resumeScheduledTask, getJobInstructions, setJobInstructions, getWakeStatus, setWakeForJobs } from './services/bridge.js';
import { initMatrixRain } from './components/matrix-rain.js';
import { initWorkspace } from './components/workspace.js';
import { initPluginHost } from './plugins/host.js';
import { initPalette } from './components/palette.js';
import { initPlans } from './components/plans.js';
import { relativeTime } from './components/ui.js';
import { initChanges } from './components/changes.js';
import { setSummaryReader } from './components/summary.js';
import { initHelp, sectionForView, HELP_SECTIONS } from './components/help.js';
import { getAutomation, setAutomation, listChanges, changeDiff, reviewChange, readSummary } from './services/bridge.js';
setSummaryReader(readSummary);
import { setPluginThemes } from './core/theme.js';
import { normalizeMetrics, summarizeMetrics, outcomeTotals } from './core/metrics.js';
import { listPlugins, setPluginEnabled, createExamplePlugin, openPluginsFolder, deletePlugin } from './services/bridge.js';
import { openChatWindow, focusChatWindow, closeChatWindow, listenChatWindows, sendToChatWindow } from './services/bridge.js';
import { CHANGELOG, VERSION } from './core/changelog.js';
import { applyAccessibility, readAccessibility, ACCESSIBILITY_DEFAULTS } from './core/accessibility.js';
import { setLinkHandler } from './components/markdown.js';
setLinkHandler(url => openWebLink(url).catch(error => toast(String(error.message || error), 'error')));
import { recoverJobMessage } from './core/recovery.js';

const $ = (selector) => document.querySelector(selector);
const native = isNative();
const renderMessages = createMessageRenderer($('#messages'));
let workspace = null; // chat tabs and split panes; set up once the app has loaded
let plans = null; // Dashboard › Your plans (live limit countdowns)
let changesPanel = null; // Changes: jobs' worktree branches waiting for review
let pluginHost = null; // plugins (pages, commands, themes, agents); set up once the app has loaded
// Chats torn off into their own windows, and what each was last sent.
const detachedChats = new Map();
const runs = new Map();
const activity = [];
let runtime = { harnesses: [], platform: native ? 'desktop' : 'browser' };
let view = 'home';
const viewScroll = new Map();
let draft = '';
let defaultHarness = '';
let defaultModel = '';
let defaultBypassPermissions = false;
let renderedConversation;
let lastLook = '';
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
initMatrixRain($('#matrix-rain'));
const persistence = createWorkspacePersistence({ onError: () => toast('Changes could not be saved. Keep Noai open and try again.', 'error') });
const scheduledTasks = initScheduledTasks({
  navigate: setView, list: listScheduledTasks, create: createScheduledTask, edit: editScheduledTask, retry: retryScheduledTask, cancel: cancelScheduledTask, pause: pauseScheduledTask, resume: resumeScheduledTask,
  getRuns: getScheduledTaskRuns, getResumeJobs: resumeJobs, fetchMetrics: activityMetrics, getModels: harnessModels, ensureProject, native, toast,
  getProjectPath: () => store.getState().projectPath,
  getAutoResume: () => store.getState().preferences.autoResume,
  getCustomModels: () => store.getState().preferences.customModels || {},
  getRuntime: () => runtime,
});

// "Chat with this model" from the Models page: a new chat preset to that agent and model.
function chatWithModel(harness, model) {
  newChat();
  defaultHarness = harness;
  defaultModel = model;
  modelSignature = '';
  render();
  $('#prompt-input').focus();
}
const modelsPanel = initModels({ getRuntime: () => runtime, getModels: harnessModels, getCustomModels: () => store.getState().preferences.customModels || {}, fetchMetrics: activityMetrics, native, onChat: (harness, model) => chatWithModel(harness, model) });
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
/** A folder's display name; Noai's own automatic workspaces (random IDs in ~/.noai) say so. */
function folderName(path) {
  return !path || /[\\/]\.noai[\\/]/.test(path) ? 'Automatic workspace' : basename(path);
}
function savePreferences(changes) {
  store.setState(state => ({ ...state, preferences: { ...state.preferences, ...changes } }));
}
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  document.querySelectorAll('[aria-controls="sidebar"]').forEach(node => node.setAttribute('aria-expanded', String(open)));
}
// Where Settings was opened from, so its Back button returns to that exact
// page: the same view, the same open job or session, and the same scroll.
let settingsReturn = null;
let helpReturn = null;
let helpPanel = null;
function setView(next) {
  // Help remembers where it was opened from, like Settings, and opens on that page's article.
  if (next === 'help' && view !== 'help') {
    const heading = view === 'chat' ? '' : document.querySelector(`#view-${view} h2`)?.textContent.trim();
    helpReturn = { view, hash: location.hash, title: heading || $('#main-title').textContent };
    void helpPanel?.open(sectionForView(view));
  }
  if (next === 'settings' && view !== 'settings') {
    // Name the page as it looks: an open job or session by its own heading.
    const heading = view === 'chat' ? '' : document.querySelector(`#view-${view} h2`)?.textContent.trim();
    settingsReturn = { view, hash: location.hash, title: heading || $('#main-title').textContent };
  }
  if (next !== 'session' && location.hash.startsWith('#session=')) history.replaceState({}, '', next === 'sessions' ? '#sessions' : `#${next}`);
  viewScroll.set(view, $('.main-content').scrollTop);
  view = next;
  setSidebar(false);
  render();
  $('.main-content').scrollTop = viewScroll.get(next) || 0;
  if (next === 'accounts' && Date.now() - lastUsageCheck > 60000) void refreshUsage();
  if (next === 'activity') void refreshJobs();
  if (next === 'home') { void metricsPanel.refresh(); if (Date.now() - lastUsageCheck > 60000) void refreshUsage(); }
  if (next === 'sessions') void sessionsPanel.refresh();
  if (next === 'jobs') void scheduledTasks.onShow();
  if (next === 'digest') void digestPanel.refresh();
  if (next === 'models') void modelsPanel.refresh();
  if (next === 'settings') { void loadJobInstructions(); void loadWakeStatus(); void loadAutomation(); renderPluginSettings(); }
  if (next === 'changes') void changesPanel?.show();
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
  for (const name of ['home', 'chat', 'help', 'changes', 'plugin', 'models', 'settings', 'accounts', 'activity', 'jobs', 'digest', 'sessions', 'session', 'job', 'job-conversation']) $(`#view-${name}`).hidden = name !== view;
  document.querySelectorAll('.nav-item[data-view]').forEach(button => {
    const selected = button.dataset.view === view || view === 'session' && button.dataset.view === 'sessions' || ['job', 'job-conversation'].includes(view) && button.dataset.view === 'jobs';
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#main-title').textContent = view === 'help' ? 'Help' : view === 'changes' ? 'Changes' : view === 'plugin' ? pluginHost?.title() || 'Plugin' : view === 'home' ? 'Dashboard' : view === 'models' ? 'Models' : view === 'settings' ? 'Settings' : view === 'chat' ? conversation?.title || 'New chat' : view === 'accounts' ? 'Accounts' : ['jobs', 'job', 'job-conversation'].includes(view) ? 'Jobs' : view === 'digest' ? 'Daily digest' : view === 'sessions' ? 'Sessions' : view === 'session' ? 'Session' : 'Activity';
  // The chat box shows the folder this chat works in (or new chats will).
  const chatFolder = conversation ? conversation.projectPath : state.projectPath;
  $('#project-label').textContent = folderName(chatFolder);
  $('#choose-project').title = conversation
    ? `This chat works in ${chatFolder || 'its own folder'}. Pick another folder to start a new chat there.`
    : chatFolder ? `New chats work in ${chatFolder}` : 'Each new chat gets its own fresh folder in ~/.noai';
  // The header names the chat's folder only on Chat; other pages show just their title.
  $('#header-project').textContent = folderName(chatFolder);
  $('#header-project').title = chatFolder || '';
  $('#header-project').hidden = view !== 'chat';
  document.querySelector('.breadcrumb-divider').hidden = view !== 'chat';
  $('#rename-chat').hidden = !conversation || view !== 'chat';
  $('#delete-chat').hidden = !conversation || view !== 'chat';
  $('#delete-chat').disabled = !!running();
  const selectedId = conversation?.id ?? null;
  if (selectedId !== renderedConversation) {
    $('#prompt-input').value = conversation?.draft || (conversation ? '' : draft);
    renderedConversation = selectedId;
  }
  workspace?.sync();
  syncChatWindows();
  pluginHost?.renderNav();
  $('#chat-welcome').hidden = !!conversation?.messages.length;
  renderMessages(conversation);
  renderModelOptions();
  updateComposer();
  if (view === 'accounts') renderAccounts($('#account-list'), runtime, native, usage, state.preferences.manualPlans, openPlanLabel);
  if (view === 'activity') {
    renderActivity($('#activity-list'), state, activity);
    renderJobs($('#resume-list'), jobs, stopJob);
  }
  $('#help-back').hidden = !helpReturn;
  if (helpReturn) $('#help-back').textContent = `← Back to ${helpReturn.title || 'previous page'}`;
  $('#settings-back').hidden = !settingsReturn;
  if (settingsReturn) $('#settings-back').textContent = `← Back to ${settingsReturn.title || 'previous page'}`;
  theme.update(state.preferences);
  // Plugin pages follow the app's colours.
  const look = `${document.documentElement.dataset.theme}|${state.preferences.theme}|${state.preferences.palette}`;
  if (look !== lastLook) { lastLook = look; pluginHost?.retheme(); }
  document.querySelectorAll('input[name="theme"], input[name="palette"]').forEach(input => { input.checked = input.value === state.preferences[input.name]; });
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
  try { usage = await providerUsage(); lastUsageCheck = Date.now(); plans?.render(usage); }
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
  pluginHost?.emit('chat.finished', { chatId: run.conversationId, error: error || null, stopped: !!interrupted }, 'chats:read');
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
    // Plugin agents print plain text line by line; built-in agents send whole paragraphs.
    const joiner = run.harness?.startsWith('plugin-') ? '\n' : '\n\n';
    updateConversation(run.conversationId, item => ({ ...item, messages: item.messages.map(message => message.id === run.messageId ? { ...message, content: message.content + (message.content ? joiner : '') + event.text } : message) }));
  } else if (event.type === 'notice' && event.text) {
    toast(event.text, 'error');
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
  $('#prompt-input').value = '';
  draft = '';
  await runPrompt(conversation, prompt);
});

/** Starts the agent on `prompt` in an existing conversation (any pane or window). */
async function runPrompt(conversation, prompt) {
  const runId = crypto.randomUUID();
  const message = createMessage('assistant', '', { status: 'streaming', runId });
  runs.set(runId, { runId, conversationId: conversation.id, messageId: message.id, harness: conversation.harness });
  updateConversation(conversation.id, item => ({ ...item, draft: '', updatedAt: new Date().toISOString(), messages: [...item.messages, createMessage('user', prompt), message] }));
  try {
    await persistence.flush();
    await startRun({ runId, conversationId: conversation.id, harness: conversation.harness, model: conversation.model || null, projectPath: conversation.projectPath, prompt, resumeId: conversation.resumeId, dangerouslyBypassPermissions: conversation.dangerouslyBypassPermissions, autoResume: store.getState().preferences.autoResume });
  } catch (error) { finishRun(runId, String(error)); }
}

/** Stops whatever is running in a conversation. */
async function stopConversation(conversationId) {
  const run = running(conversationId);
  if (!run) return;
  run.stopping = true;
  try {
    if (run.scheduled) await cancelResumeJob(run.runId);
    else await cancelRun(run.runId);
  }
  catch (error) { run.stopping = false; toast(`Could not stop this run: ${String(error)}`, 'error'); }
}

$('#stop-button').addEventListener('click', () => void stopConversation(active()?.id));
$('#prompt-input').addEventListener('input', event => setDraft(event.target.value));
$('#prompt-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer-form').requestSubmit();
  }
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); setView(button.dataset.view); }));
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  $('#prompt-input').value = `${button.dataset.prompt}. `;
  setDraft($('#prompt-input').value);
  $('#prompt-input').focus();
}));
// Project: the folder chats work in. A different folder starts a new chat there.
function useFolder(projectPath) {
  store.setState(state => ({ ...state, projectPath, activeConversationId: null }));
  draft = '';
  $('#prompt-input').value = '';
  setView('chat');
  $('#prompt-input').focus();
}
function closeProjectMenu() {
  $('#project-menu').hidden = true;
  $('#choose-project').setAttribute('aria-expanded', 'false');
}
function openProjectMenu() {
  const state = store.getState();
  const current = active()?.projectPath ?? state.projectPath ?? null;
  const item = (label, detail, chosen, action) => {
    const button = element('button', `project-menu-item${chosen ? ' is-chosen' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(chosen));
    button.append(element('span', 'project-menu-check', chosen ? '✓' : ''), element('span', 'project-menu-copy'));
    button.lastChild.append(element('strong', '', label), element('small', '', detail));
    button.addEventListener('click', () => { closeProjectMenu(); action(); });
    return button;
  };
  const recent = [...new Set([...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => item.projectPath).filter(path => path && !path.includes('/.noai/')))].slice(0, 5);
  const menu = $('#project-menu');
  menu.replaceChildren(
    item('Choose a folder…', 'Work in one of your projects', false, async () => {
      if (!native) { toast('Choose project folders in the Noai desktop app.'); return; }
      try { const path = await chooseProject(); if (path) useFolder(path); } catch (error) { toast(String(error), 'error'); }
    }),
    item('Automatic workspace', 'A fresh, empty folder for each chat', !current || current.includes('/.noai/'), () => useFolder(null)),
    ...(recent.length ? [element('p', 'project-menu-label', 'Recent')] : []),
    ...recent.map(path => item(basename(path), path, path === current, () => useFolder(path))),
  );
  menu.hidden = false;
  $('#choose-project').setAttribute('aria-expanded', 'true');
  // Placed in the window, not the pane, so narrow panes and small windows never cut it off:
  // above the pill when there's room, otherwise below, and nudged to stay on screen.
  const pill = $('#choose-project').getBoundingClientRect(), box = menu.getBoundingClientRect();
  const left = Math.max(12, Math.min(pill.left, innerWidth - box.width - 12));
  const above = pill.top - box.height - 8 >= 12;
  menu.style.setProperty('left', `${left}px`);
  menu.style.setProperty('top', `${above ? pill.top - box.height - 8 : Math.min(pill.bottom + 8, innerHeight - box.height - 12)}px`);
}
addEventListener('resize', () => closeProjectMenu());
$('#choose-project').addEventListener('click', event => {
  event.stopPropagation();
  if ($('#project-menu').hidden) openProjectMenu(); else closeProjectMenu();
});
document.addEventListener('click', event => { if (!event.target.closest?.('.project-menu-wrap')) closeProjectMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#project-menu').hidden) closeProjectMenu(); });
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
// Settings is a page with its own list of sections, like System Settings.
function showSettingsSection(name) {
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    const selected = item.dataset.settingsSection === name;
    item.classList.toggle('is-active', selected);
    if (selected) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.settings-section').forEach(section => { section.hidden = section.dataset.section !== name; });
  if (name === 'jobs') void loadJobInstructions();
  if (name === 'plugins') renderPluginSettings();
  if (name === 'appearance') showThemePage(true);
}
document.querySelectorAll('.settings-nav-item').forEach(item => item.addEventListener('click', () => showSettingsSection(item.dataset.settingsSection)));
function leaveSettings() {
  const back = settingsReturn || { view: 'chat', hash: '' };
  settingsReturn = null;
  // Put back the page's address (e.g. #session=…) without reloading it.
  if (back.hash !== location.hash) history.replaceState({}, '', back.hash || location.pathname);
  setView(back.view);
}
$('#settings-back').addEventListener('click', leaveSettings);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view === 'settings' && !event.target.closest?.('input, textarea, select')) leaveSettings();
});
// ---- Accessibility -------------------------------------------------------------
function showAccessibility(settings = readAccessibility()) {
  $('#text-size').value = String(settings.textSize);
  $('#text-size-value').textContent = `${settings.textSize}%`;
  document.querySelectorAll('input[name="vision"]').forEach(input => { input.checked = input.value === settings.vision; });
  $('#contrast-setting').checked = settings.contrast;
  $('#motion-setting').checked = settings.motion;
}
showAccessibility(applyAccessibility());
$('#text-size').addEventListener('input', event => {
  $('#text-size-value').textContent = `${event.target.value}%`;
  applyAccessibility({ textSize: Number(event.target.value) });
});
$('#text-size-reset').addEventListener('click', () => showAccessibility(applyAccessibility({ textSize: ACCESSIBILITY_DEFAULTS.textSize })));
$('#vision-options').addEventListener('change', event => showAccessibility(applyAccessibility({ vision: event.target.value })));
$('#contrast-setting').addEventListener('change', event => applyAccessibility({ contrast: event.target.checked }));
$('#motion-setting').addEventListener('change', event => applyAccessibility({ motion: event.target.checked }));
// ⌘+ / ⌘− / ⌘0 change the text size too.
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const step = event.key === '=' || event.key === '+' ? 5 : event.key === '-' ? -5 : event.key === '0' ? 0 : null;
  if (step === null) return;
  event.preventDefault();
  const size = step === 0 ? 100 : readAccessibility().textSize + step;
  showAccessibility(applyAccessibility({ textSize: Math.min(150, Math.max(85, size)) }));
});

// The sidebar folds down to a strip of icons; the choice is remembered here.
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-collapse');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
  button.title = `${collapsed ? 'Show' : 'Hide'} sidebar (⌘\\)`;
  try { localStorage.setItem('noai.sidebarCollapsed', collapsed ? '1' : ''); } catch { /* not kept */ }
}
try { setSidebarCollapsed(localStorage.getItem('noai.sidebarCollapsed') === '1'); } catch { setSidebarCollapsed(false); }
$('#sidebar-collapse').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
// Icon-only items still say what they are on hover.
document.querySelectorAll('#sidebar .nav-item').forEach(item => { if (!item.title) item.title = item.textContent.trim(); });

// Version under the logo opens the changelog.
$('#version-button').textContent = `v${VERSION}`;
$('#version-button').addEventListener('click', () => {
  const body = $('#changelog-body');
  body.replaceChildren(...CHANGELOG.map(entry => {
    const section = element('section', 'changelog-entry');
    const head = element('div', 'changelog-head');
    head.append(element('strong', '', `Version ${entry.version}`), element('span', 'changelog-date', new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
    const list = element('ul');
    for (const note of entry.notes) list.append(element('li', '', note));
    section.append(head, element('h3', '', entry.title), list);
    return section;
  }));
  $('#changelog-dialog').showModal();
});
$('#changelog-close').addEventListener('click', () => $('#changelog-dialog').close());

document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === '\\') { event.preventDefault(); setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')); }
  // ⌘D splits the current chat to the right, ⌘⇧D below it.
  if (event.key.toLowerCase() === 'd' && view === 'chat' && workspace) { event.preventDefault(); workspace.splitFocused(event.shiftKey ? 'bottom' : 'right'); }
});
// ---- Help ---------------------------------------------------------------------
helpPanel = initHelp({ nav: $('#help-nav'), article: $('#help-article'), search: $('#help-search'), results: $('#help-results') });
function leaveHelp() {
  const back = helpReturn || { view: 'chat', hash: '' };
  helpReturn = null;
  if (back.hash !== location.hash) history.replaceState({}, '', back.hash || location.pathname);
  setView(back.view);
}
$('#header-help').addEventListener('click', () => setView('help'));
$('#help-back').addEventListener('click', leaveHelp);
$('#help-report').addEventListener('click', () => void openWebLink('https://github.com/Trimmendous/NoAI/issues/new'));
document.addEventListener('keydown', event => {
  const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  // ? (when not typing) or ⌘/ opens Help; Esc leaves it.
  if ((event.key === '?' && !typing && !event.metaKey && !event.ctrlKey) || ((event.metaKey || event.ctrlKey) && event.key === '/')) {
    event.preventDefault();
    if (view !== 'help') setView('help');
  } else if (event.key === 'Escape' && view === 'help' && !typing) leaveHelp();
});

// ⌘, (Ctrl+, elsewhere) opens Settings, as in other Mac apps.
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setView('settings'); } });

// Waking the computer for jobs. Turning it on may show the system's admin
// prompt once (macOS, Linux); the background service applies it within a minute.
function showWakeStatus(status) {
  const toggle = $('#wake-setting');
  toggle.checked = !!status?.enabled;
  toggle.disabled = !status?.supported;
  $('#wake-detail').textContent = status?.detail || '';
}
async function loadWakeStatus() {
  try { showWakeStatus(await getWakeStatus()); }
  catch (error) { $('#wake-status').textContent = `Could not check wake settings: ${String(error)}`; }
}
$('#wake-setting').addEventListener('change', async event => {
  const toggle = event.target, wanted = toggle.checked, status = $('#wake-status');
  toggle.disabled = true;
  status.textContent = wanted ? 'Waiting for your approval…' : 'Turning off…';
  try {
    showWakeStatus(await setWakeForJobs(wanted));
    status.textContent = wanted ? 'On. The computer will wake a minute before the next job.' : 'Off. Jobs run when the computer is next awake.';
  } catch (error) {
    toggle.checked = !wanted; toggle.disabled = false;
    status.textContent = String(error).replace(/^Error: /, '');
  }
});

// Notifications and the usage budget, kept by the background service.
let automation = null;
function showAutomation() {
  if (!automation) return;
  $('#notify-finished').checked = automation.notifyFinished;
  $('#notify-problems').checked = automation.notifyProblems;
  $('#notify-limits').checked = automation.notifyLimits;
  const on = automation.reservePercent != null;
  $('#budget-setting').checked = on;
  $('#budget-slider-row').hidden = !on;
  const keep = on ? automation.reservePercent : Number($('#budget-reserve').value);
  $('#budget-reserve').value = String(keep);
  $('#budget-value').textContent = `${keep}%`;
  $('#budget-explain').textContent = `Jobs start only while each limit is under ${100 - keep}% used. A job that would start later waits for the limit to reset, and running jobs are never stopped.`;
}
async function loadAutomation() {
  if (!native) { $('#automation-status').textContent = 'Open the desktop app to change notifications and the budget.'; return; }
  try { automation = await getAutomation(); showAutomation(); }
  catch (error) { $('#automation-status').textContent = `Could not load: ${String(error)}`; }
}
async function saveAutomation(changes) {
  if (!automation) return;
  const previous = automation;
  automation = { ...automation, ...changes };
  showAutomation();
  try { automation = await setAutomation(automation); showAutomation(); $('#automation-status').textContent = 'Saved.'; }
  catch (error) { automation = previous; showAutomation(); $('#automation-status').textContent = `Could not save: ${String(error)}`; }
}
$('#notify-finished').addEventListener('change', event => void saveAutomation({ notifyFinished: event.target.checked }));
$('#notify-problems').addEventListener('change', event => void saveAutomation({ notifyProblems: event.target.checked }));
$('#notify-limits').addEventListener('change', event => void saveAutomation({ notifyLimits: event.target.checked }));
$('#budget-setting').addEventListener('change', event => void saveAutomation({ reservePercent: event.target.checked ? Number($('#budget-reserve').value) : null }));
$('#budget-reserve').addEventListener('input', event => { $('#budget-value').textContent = `${event.target.value}%`; });
$('#budget-reserve').addEventListener('change', event => void saveAutomation({ reservePercent: Number(event.target.value) }));

// Standing instructions for every job run, kept by the background service.
let instructionsLoaded = false;
async function loadJobInstructions() {
  const form = $('#job-instructions-form'), status = $('#job-instructions-status');
  if (!native) { form.querySelectorAll('textarea, button, input').forEach(node => { node.disabled = true; }); status.textContent = 'Open the desktop app to set job instructions.'; return; }
  if (instructionsLoaded) return;
  try {
    const saved = await getJobInstructions();
    $('#job-instructions-recurring').value = saved?.recurring || '';
    $('#job-instructions-one-time').value = saved?.oneTime || '';
    $('#job-instructions-summary-log').checked = saved?.summaryLog !== false;
    instructionsLoaded = true;
    status.textContent = '';
  } catch (error) { status.textContent = `Could not load instructions: ${String(error)}`; }
}
$('#job-instructions-form').addEventListener('input', () => { $('#job-instructions-status').textContent = 'Not saved yet'; });
$('#job-instructions-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#job-instructions-save'), status = $('#job-instructions-status');
  button.disabled = true; status.textContent = 'Saving…';
  try {
    const saved = await setJobInstructions({ recurring: $('#job-instructions-recurring').value, oneTime: $('#job-instructions-one-time').value, summaryLog: $('#job-instructions-summary-log').checked });
    $('#job-instructions-recurring').value = saved.recurring; $('#job-instructions-one-time').value = saved.oneTime;
    status.textContent = 'Saved. Applies from the next run.';
  } catch (error) { status.textContent = String(error); }
  finally { button.disabled = false; }
});
$('#view-settings').addEventListener('change', event => {
  if (['theme', 'palette'].includes(event.target.name)) savePreferences({ [event.target.name]: event.target.value });
});
$('#auto-resume-setting').addEventListener('change', event => savePreferences({ autoResume: event.target.checked }));
$('#background-mode-setting').addEventListener('change', async event => {
  const enabled = event.target.checked;
  try { await setBackgroundMode(enabled); savePreferences({ backgroundMode: enabled }); }
  catch (error) { render(); toast(`Could not change background behavior: ${String(error)}`, 'error'); }
});
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


plans = initPlans($('#plans-overview'), { onReset: () => void refreshUsage(), openAccounts: () => setView('accounts') });
plans.render(usage);

// ---- Plugins ------------------------------------------------------------------------
function drawPluginThemes(themes) {
  const clean = setPluginThemes(themes);
  document.querySelectorAll('#theme-options .theme-choice.is-plugin').forEach(node => node.remove());
  for (const [key, plugin] of Object.entries(clean)) {
    const label = element('label', 'theme-choice is-plugin');
    const input = element('input');
    input.type = 'radio'; input.name = 'theme'; input.value = key;
    input.checked = store.getState().preferences.theme === key;
    const preview = element('span', 'theme-preview');
    preview.setAttribute('aria-hidden', 'true');
    const colors = plugin.colors;
    preview.style.setProperty('background', plugin.background ? `url("${plugin.background}") center / cover no-repeat, ${colors['--canvas'] || '#222'}` : colors['--canvas'] || '#222');
    const bars = [element('i'), element('i'), element('i')];
    bars[0].style.setProperty('background', colors['--sidebar'] || colors['--surface'] || '#333');
    bars[1].style.setProperty('background', colors['--accent'] || '#888');
    bars[2].style.setProperty('background', colors['--surface'] || '#444');
    preview.append(...bars);
    label.append(input, preview, element('span', 'theme-choice-name', plugin.name));
    if (plugin.subtitle) label.append(element('small', 'theme-choice-subtitle', plugin.subtitle));
    $('#theme-options').append(label);
  }
  showThemePage();
  // A plugin theme that went away falls back to the system look.
  const chosen = store.getState().preferences.theme;
  if (/^plugin:/.test(chosen) && !clean[chosen]) savePreferences({ theme: 'system' });
  else theme.update(store.getState().preferences);
}
// Theme picker: search by name, 12 at a time.
const THEMES_PER_PAGE = 12;
let themePage = 0;
function showThemePage(goToSelected = false) {
  const choices = [...document.querySelectorAll('#theme-options .theme-choice')];
  const query = $('#theme-search').value.trim().toLowerCase();
  const matches = choices.filter(choice => !query || choice.textContent.toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(matches.length / THEMES_PER_PAGE));
  if (goToSelected) {
    const selected = matches.findIndex(choice => choice.querySelector('input')?.checked);
    if (selected >= 0) themePage = Math.floor(selected / THEMES_PER_PAGE);
  }
  themePage = Math.min(Math.max(0, themePage), pages - 1);
  const shown = new Set(matches.slice(themePage * THEMES_PER_PAGE, (themePage + 1) * THEMES_PER_PAGE));
  for (const choice of choices) choice.hidden = !shown.has(choice);
  const many = choices.length > THEMES_PER_PAGE;
  $('#theme-tools').hidden = !many;
  $('#theme-pages').hidden = pages < 2;
  $('#theme-empty').hidden = matches.length > 0;
  $('#theme-page-label').textContent = `Page ${themePage + 1} of ${pages}`;
  $('#theme-prev').disabled = $('#theme-first').disabled = themePage === 0;
  $('#theme-next').disabled = $('#theme-last').disabled = themePage >= pages - 1;
  $('#theme-count').textContent = query ? `${matches.length} of ${choices.length}` : `${choices.length} themes`;
}
$('#theme-search').addEventListener('input', () => { themePage = 0; showThemePage(); });
$('#theme-prev').addEventListener('click', () => { themePage -= 1; showThemePage(); });
$('#theme-next').addEventListener('click', () => { themePage += 1; showThemePage(); });
$('#theme-first').addEventListener('click', () => { themePage = 0; showThemePage(); });
$('#theme-last').addEventListener('click', () => { themePage = Infinity; showThemePage(); });

async function pluginSendChat({ prompt, chatId, harness, model } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim().slice(0, 100000) : '';
  if (!text) throw new Error('A prompt is required');
  let conversation = chatId ? store.getState().conversations.find(item => item.id === chatId) : null;
  if (chatId && !conversation) throw new Error('No such chat');
  if (conversation && running(conversation.id)) throw new Error('That chat is already working');
  if (!conversation) {
    const agent = harness && getHarness(harness) ? harness : defaultHarness;
    const projectPath = await ensureProject(store.getState().projectPath || null);
    conversation = createConversation({ title: text.slice(0, 54), harness: agent, model: typeof model === 'string' ? model.slice(0, 200) : '', projectPath, dangerouslyBypassPermissions: false });
    store.setState(state => ({ ...state, conversations: [...state.conversations, conversation] }));
  }
  await runPrompt(conversation, text);
  return { chatId: conversation.id };
}
pluginHost = initPluginHost({
  native, platform: () => runtime.platform,
  navEl: $('.primary-nav'), viewEl: $('#view-plugin'), workersEl: $('#plugin-workers'),
  setView, getView: () => view, toast,
  onThemes: drawPluginThemes,
  onManage: () => { setView('settings'); showSettingsSection('plugins'); },
  api: {
    list: listPlugins,
    appInfo: () => ({ version: VERSION, theme: document.documentElement.dataset.theme }),
    listChats: () => store.getState().conversations.map(item => ({ id: item.id, title: item.title, harness: item.harness, model: item.model || '', projectPath: item.projectPath || '', updatedAt: item.updatedAt, messageCount: item.messages.length, running: !!running(item.id) })),
    getChat: id => {
      const item = store.getState().conversations.find(entry => entry.id === id);
      if (!item) throw new Error('No such chat');
      return { id: item.id, title: item.title, harness: item.harness, model: item.model || '', projectPath: item.projectPath || '', messages: item.messages.map(message => ({ role: message.role, content: message.content, createdAt: message.createdAt, status: message.status || '' })) };
    },
    openChat: id => { if (!store.getState().conversations.some(item => item.id === id)) throw new Error('No such chat'); selectConversation(id); return true; },
    sendChat: pluginSendChat,
    listJobs: async () => (await listScheduledTasks()).map(task => ({ id: task.id, title: task.title, status: task.status, harness: task.harness, model: task.model || '', intervalSeconds: task.intervalSeconds || null, nextRunAt: task.nextRunAt || null, lastResult: task.lastResult || null })),
    jobRuns: async id => (await getScheduledTaskRuns(id)).map(run => ({ runId: run.runId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt || null, result: run.result || null })),
    metricsSummary: async range => {
      const report = summarizeMetrics(normalizeMetrics((await activityMetrics()).records || []), { range });
      return { range, tokens: report.tokens, input: report.input, output: report.output, cacheRate: report.cacheRate, cost: report.cost, sessions: report.runs, toolEvents: report.toolCount, calls: outcomeTotals(report.outcomes) };
    },
  },
});
function renderPluginSettings() {
  pluginHost?.renderSettings($('#plugin-settings'), {
    // The agent list catches up in the background; the switch doesn't wait for it.
    setEnabled: async (id, enabled) => { await setPluginEnabled(id, enabled); void refreshRuntime(); },
    createExample: createExamplePlugin,
    openFolder: openPluginsFolder,
    remove: async id => { await deletePlugin(id); void refreshRuntime(); },
  });
}
void pluginHost.load().then(renderPluginSettings);

// ⌘K: every action in one searchable list, plugin commands included.
const palette = initPalette({
  dialog: $('#palette-dialog'), input: $('#palette-input'), list: $('#palette-list'),
  getCommands: () => [
    { key: 'new-chat', title: 'New chat', hint: '⌘N', run: newChat },
    // Chats are opened from here, the tabs, or Sessions; the sidebar has no list.
    ...[...store.getState().conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
      .map(item => ({ key: `chat-${item.id}`, title: item.title || 'Untitled chat', hint: `Chat · ${relativeTime(Date.parse(item.updatedAt) / 1000)}`, run: () => selectConversation(item.id) })),
    ...[['home', 'Dashboard'], ['chat', 'Chat'], ['jobs', 'Jobs'], ['digest', 'Digest'], ['sessions', 'Sessions'], ['activity', 'Activity'], ['accounts', 'Accounts'], ['models', 'Models'], ['settings', 'Settings']]
      .map(([id, title]) => ({ key: `go-${id}`, title: `Go to ${title}`, run: () => setView(id) })),
    { key: 'split-right', title: 'Split chat right', hint: '⌘D', run: () => { setView('chat'); workspace?.splitFocused('right'); } },
    { key: 'split-down', title: 'Split chat down', hint: '⇧⌘D', run: () => { setView('chat'); workspace?.splitFocused('bottom'); } },
    ...(active() ? [{ key: 'tear-off', title: 'Open this chat in a new window', run: () => tearOff(active().id) }] : []),
    { key: 'sidebar', title: 'Show or hide the sidebar', hint: '⌘\\', run: () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')) },
    { key: 'changelog', title: 'What’s new', run: () => $('#version-button').click() },
    ...HELP_SECTIONS.map(section => ({ key: `help-${section.id}`, title: `Help: ${section.title}`, hint: section.subtitle, run: () => { setView('help'); void helpPanel?.open(section.id); } })),
    ...(pluginHost?.commands() || []).filter(command => command.context !== 'chat' || active()).map(command => ({
      key: `plugin-${command.key}`, title: command.title, hint: command.plugin.name,
      run: () => pluginHost.run(command, command.context === 'chat' ? { chatId: active()?.id } : {}),
    })),
  ],
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); palette.open(); }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); }
});

// ---- Chats in their own windows --------------------------------------------
function chatWindowPayload(conversation) {
  const run = running(conversation.id);
  return {
    id: conversation.id, title: conversation.title, harness: conversation.harness,
    agent: getHarness(conversation.harness)?.label || conversation.harness, model: conversation.model || '',
    project: conversation.projectPath ? basename(conversation.projectPath) : '',
    messages: conversation.messages, running: !!run,
    status: run?.waiting ? `Waiting for quota · ${countdown(run.retryAt)}` : run ? 'Working in your project · You can stop at any time.' : 'Enter to send · Shift + Enter for a new line',
  };
}
function syncChatWindows(force = false) {
  for (const [id, last] of detachedChats) {
    const conversation = store.getState().conversations.find(item => item.id === id);
    const payload = conversation ? chatWindowPayload(conversation) : null;
    const signature = JSON.stringify(payload);
    if (!force && signature === last) continue;
    detachedChats.set(id, signature);
    void sendToChatWindow(id, payload).catch(() => {});
  }
}
async function tearOff(id, x = null, y = null) {
  const conversation = store.getState().conversations.find(item => item.id === id);
  if (!conversation || !native) return;
  try {
    await openChatWindow(id, conversation.title, x, y);
    detachedChats.set(id, '');
    render();
  } catch (error) { toast(`Could not open a window for this chat: ${String(error)}`, 'error'); }
}
function dock(id) {
  if (!detachedChats.delete(id)) return;
  void closeChatWindow(id).catch(() => {});
}
if (native) {
  await listenChatWindows(async ({ id, action, prompt }) => {
    if (!detachedChats.has(id)) return;
    const conversation = store.getState().conversations.find(item => item.id === id);
    if (action === 'ready') { detachedChats.set(id, ''); syncChatWindows(); }
    else if (action === 'send' && conversation && typeof prompt === 'string' && prompt.trim() && !running(id)) await runPrompt(conversation, prompt.trim().slice(0, 100000));
    else if (action === 'stop') await stopConversation(id);
    else if (action === 'dock') { dock(id); workspace?.splitFocused('right', id); }
  }, id => { if (detachedChats.delete(id)) render(); });
}

workspace = initWorkspace({
  isDetached: id => detachedChats.has(id),
  onTearOff: (id, x, y) => void tearOff(id, x, y),
  onShowDetached: id => void focusChatWindow(id).catch(() => {}),
  onDock: dock,
  layoutEl: $('#chat-layout'), tabsEl: $('#chat-tabs'),
  dock: { home: $('#chat-dock-home'), messages: $('#messages'), welcome: $('#chat-welcome'), composer: $('.composer-dock') },
  getState: () => store.getState(),
  titleOf: conversation => conversation.title,
  isRunning: id => !!running(id),
  onFocus: id => { store.setState(state => ({ ...state, activeConversationId: id })); if (view !== 'chat') setView('chat'); },
  onNewChat: newChat,
});

render();
try { await listenRunEvents(onRunEvent); }
catch (error) { persistenceAvailable = false; toast(`Cannot receive agent responses: ${String(error)}`, 'error'); }
await refreshRuntime();
try { await setBackgroundMode(store.getState().preferences.backgroundMode); }
catch (error) { toast(`Background mode is unavailable: ${String(error)}`, 'error'); }
await refreshJobs();
// Changes: the page, and the count next to it in the sidebar.
changesPanel = initChanges({
  native, list: listChanges, diff: changeDiff, review: reviewChange, openLink: openWebLink, toast,
  onCount: count => { $('#changes-badge').hidden = !count; $('#changes-badge').textContent = String(count); },
});
$('#changes-refresh').addEventListener('click', () => void changesPanel.refresh());
void changesPanel.refresh();

// Plugins hear when a job's run finishes ("job.finished").
const jobRunsSeen = new Map();
function noteJobForPlugins(task) {
  if (!task?.id || !task.lastRunId || !task.lastResult) return;
  const seen = jobRunsSeen.get(task.id);
  jobRunsSeen.set(task.id, task.lastRunId);
  if (seen === undefined || seen === task.lastRunId) return;
  pluginHost?.emit('job.finished', { jobId: task.id, title: task.title, status: task.status === 'scheduled' ? 'completed' : task.status, result: task.lastResult }, 'jobs:read');
}
try { (await listScheduledTasks()).forEach(task => { if (task.lastRunId) jobRunsSeen.set(task.id, task.lastRunId); }); } catch { /* jobs unavailable */ }
try { await listenScheduledTasks(task => {
  noteJobForPlugins(task);
  void changesPanel?.refresh(); if (['jobs', 'job', 'job-conversation'].includes(view)) void scheduledTasks.refresh(); if (view === 'digest') void digestPanel.refresh(); }); }
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
setInterval(() => { if (['accounts', 'home'].includes(view) && !document.hidden) void refreshUsage(); }, 120000);

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
