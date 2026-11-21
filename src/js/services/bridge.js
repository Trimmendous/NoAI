const PREVIEW_STORAGE_KEY = 'noai.workspace.v1';

function tauri() {
  return globalThis.window?.__TAURI__ ?? null;
}

export function isNative() {
  return typeof tauri()?.core?.invoke === 'function';
}

async function invoke(command, args) {
  if (!isNative()) throw new Error('This action requires the Noai desktop app.');
  return tauri().core.invoke(command, args);
}

export async function runtimeStatus() {
  if (isNative()) return invoke('runtime_status');
  return {
    platform: 'browser',
    // Agents are discovered by the desktop app; the browser preview has none.
    harnesses: [],
  };
}

export async function loadWorkspace() {
  if (isNative()) return invoke('load_workspace');
  try {
    const value = globalThis.localStorage?.getItem(PREVIEW_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    throw new Error('Cannot load browser preview workspace.', { cause: error });
  }
}

export async function saveWorkspace(workspace) {
  if (isNative()) return invoke('save_workspace', { workspace });
  try {
    if (!globalThis.localStorage) throw new Error('localStorage is unavailable');
    globalThis.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(workspace));
  } catch (error) {
    throw new Error('Browser preview storage is unavailable.', { cause: error });
  }
}

export async function chooseProject() {
  return invoke('choose_project');
}

export async function startRun(request) {
  return invoke('start_run', { request });
}

export async function cancelRun(runId) {
  return invoke('cancel_run', { runId });
}

export async function listenRunEvents(callback) {
  if (typeof callback !== 'function') throw new TypeError('Run event callback must be a function');
  if (!isNative()) return () => {};
  const listen = tauri()?.event?.listen;
  if (typeof listen !== 'function') throw new Error('Tauri event bridge is unavailable.');
  return listen('noai:run', (event) => callback(event.payload));
}

export async function providerUsage() {
  return isNative() ? invoke('get_provider_usage') : [];
}

export async function harnessModels(harness) {
  return isNative() ? invoke('get_harness_models', { harness }) : [];
}

export async function resumeJobs() {
  return isNative() ? invoke('get_resume_jobs') : [];
}

export async function cancelResumeJob(jobId) {
  return invoke('cancel_resume_job', { jobId });
}

export async function setBackgroundMode(enabled) {
  if (isNative()) return invoke('set_background_mode', { enabled });
}

export async function ensureProject(projectPath = null) {
  return invoke('ensure_project', { projectPath });
}
export async function listScheduledTasks() {
  return isNative() ? invoke('list_scheduled_tasks') : [];
}
export async function createScheduledTask(input) {
  return invoke('create_scheduled_task', { input });
}
export async function cancelScheduledTask(id) {
  return invoke('cancel_scheduled_task', { id });
}
export async function pauseScheduledTask(id) { return invoke('pause_scheduled_task', { id }); }
export async function resumeScheduledTask(id) { return invoke('resume_scheduled_task', { id }); }
export async function getScheduledTaskRuns(id) {
  return isNative() ? invoke('get_scheduled_task_runs', { id }) : [];
}
export async function listenScheduledTasks(callback) {
  if (!isNative()) return () => {};
  return tauri().event.listen('noai:scheduled-task', event => callback(event.payload));
}

export async function connectEvents() { if (isNative()) return invoke('connect_events'); }
export async function activeRuns() { return isNative() ? invoke('get_active_runs') : []; }

export async function activityMetrics() { return isNative() ? invoke('get_activity_metrics') : {records:[]}; }

export async function listLocalSessions() { return isNative() ? invoke('list_local_sessions') : {sessions:[]}; }
export async function getLocalSession(id, offset = 0) { return invoke('get_local_session', {id, offset}); }

export async function editScheduledTask(id, input, expectedLastRunId) { return invoke('edit_scheduled_task', {id, input, expectedLastRunId}); }

export async function retryScheduledTask(id, startAt, expectedLastRunId) { return invoke('retry_scheduled_task', {id, startAt, expectedLastRunId}); }

export async function openWebLink(url) { if (isNative()) return invoke('open_web_link', { url }); window.open(url, '_blank', 'noopener'); }

export async function getDigest() { return isNative() ? invoke('get_digest') : { task: null, runs: [] }; }
export async function setDigest(input) { return invoke('set_digest', { input }); }
export async function runDigestNow() { return invoke('run_digest_now'); }
