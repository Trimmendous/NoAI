import { normalizeWorkspace } from '../core/state.js';
import { loadWorkspace, saveWorkspace } from './bridge.js';

export async function loadInitialWorkspace() {
  return normalizeWorkspace(await loadWorkspace());
}

export function createWorkspacePersistence({ save = saveWorkspace, delay = 250, onError } = {}) {
  let pending;
  let timer = null;
  let running = null;
  let disposed = false;

  async function drain() {
    if (running) return running;
    running = (async () => {
      while (pending !== undefined) {
        const workspace = pending;
        pending = undefined;
        try {
          await save(workspace);
        } catch (error) {
          if (pending === undefined) pending = workspace;
          onError?.(error);
          throw error;
        }
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  function schedule(workspace) {
    if (disposed) throw new Error('Workspace persistence has been disposed');
    pending = workspace;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain().catch(() => {});
    }, delay);
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (running) {
      await running;
      if (pending !== undefined) await drain();
    } else if (pending !== undefined) {
      await drain();
    }
  }

  async function dispose() {
    await flush();
    disposed = true;
  }

  return { schedule, flush, dispose };
}
