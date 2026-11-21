import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversation, createInitialWorkspace, createMessage, createStore,
  normalizeWorkspace,
} from '../src/js/core/state.js';
import { createWorkspacePersistence } from '../src/js/services/workspace.js';
import { buildProviderCards } from '../src/js/services/providers.js';
import { applyTheme } from '../src/js/core/theme.js';
import { isNative, listenRunEvents, loadWorkspace, saveWorkspace, startRun } from '../src/js/services/bridge.js';

test('workspace normalization preserves drafts and custom models and interrupts unfinished work', () => {
  const workspace = normalizeWorkspace({
    activeConversationId: 'conversation-1',
    preferences: { theme: 'dark', palette: 'blue', customModels: {
      codex: ['gpt-example', ' gpt-example ', '', 42], claude: ['claude-example'],
    } },
    conversations: [{
      id: 'conversation-1', draft: 'Unsent prompt', harness: 'codex',
      messages: [{ id: 'message-1', role: 'assistant', content: 'Partial answer', status: 'running' }],
    }],
  });
  assert.equal(workspace.activeConversationId, 'conversation-1');
  assert.equal(workspace.conversations[0].draft, 'Unsent prompt');
  assert.deepEqual(workspace.preferences.customModels, {
    codex: ['gpt-example'], claude: ['claude-example'],
  });
  assert.equal(workspace.conversations[0].messages[0].status, 'interrupted');
  assert.equal(createMessage('assistant', '', { status: 'running' }).status, 'running');
  assert.deepEqual(createInitialWorkspace().preferences.customModels, {});
});

test('store snapshots are immutable and subscriptions receive fresh state', () => {
  const initial = createInitialWorkspace();
  const store = createStore(initial);
  const observed = [];
  const unsubscribe = store.subscribe((state) => observed.push(state.conversations.length));
  store.setState((state) => ({ ...state, conversations: [createConversation({ draft: 'hello' })] }));
  assert.deepEqual(observed, [1]);
  assert.equal(store.getState().conversations[0].draft, 'hello');
  assert.equal(Object.isFrozen(store.getState().conversations[0]), true);
  assert.deepEqual(initial.conversations, []);
  unsubscribe();
  store.setState(createInitialWorkspace());
  assert.deepEqual(observed, [1]);
});

test('persistence saves the latest snapshot after an in-flight save', async () => {
  const saved = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let savingFirst;
  const firstStarted = new Promise((resolve) => { savingFirst = resolve; });
  const persistence = createWorkspacePersistence({
    delay: 0,
    save: async (value) => {
      saved.push(value);
      if (value === 'first') { savingFirst(); await first; }
    },
  });
  persistence.schedule('first');
  await firstStarted;
  persistence.schedule('second');
  releaseFirst();
  await persistence.flush();
  assert.deepEqual(saved, ['first', 'second']);
  await persistence.dispose();
});

test('failed saves remain pending for a later flush', async () => {
  const saved = [];
  let attempts = 0;
  const persistence = createWorkspacePersistence({
    delay: 1000,
    save: async (value) => {
      if (++attempts === 1) throw new Error('disk full');
      saved.push(value);
    },
  });
  persistence.schedule('important');
  await assert.rejects(persistence.flush(), /disk full/);
  await persistence.flush();
  assert.deepEqual(saved, ['important']);
  await persistence.dispose();
});

test('provider cards only report observed installation and leave usage unknown', () => {
  const cards = buildProviderCards({ harnesses: [
    { id: 'codex', installed: true, version: '1.0' },
    { id: 'claude', installed: false, detail: 'Missing' },
  ] });
  assert.equal(cards.find((card) => card.id === 'codex').installed, true);
  assert.equal(cards.find((card) => card.id === 'claude').installed, false);
  assert.equal(cards.find((card) => card.id === 'gemini').installed, null);
  assert.ok(cards.every((card) => card.usageStatus === 'unknown' && card.remaining === null));
});

test('appearance is applied and cached for immediate startup', () => {
  const beforeDocument = globalThis.document;
  const beforeStorage = globalThis.localStorage;
  const values = new Map();
  const root = { dataset: {}, style: {} };
  globalThis.document = { documentElement: root };
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.deepEqual(applyTheme({ theme: 'dark', palette: 'amber' }), {
      theme: 'dark', palette: 'amber', resolvedTheme: 'dark',
    });
    assert.equal(root.dataset.theme, 'dark');
    assert.deepEqual(JSON.parse(values.get('noai.appearance')), { theme: 'dark', palette: 'amber', v: 2 });
    assert.equal(applyTheme().palette, 'amber');
    // The old grey default moves to blue once; a grey chosen after that stays grey.
    values.set('noai.appearance', JSON.stringify({ theme: 'light', palette: 'graphite' }));
    assert.equal(applyTheme().palette, 'blue');
    values.set('noai.appearance', JSON.stringify({ theme: 'light', palette: 'graphite', v: 2 }));
    assert.equal(applyTheme().palette, 'graphite');
  } finally {
    if (beforeDocument === undefined) delete globalThis.document;
    else globalThis.document = beforeDocument;
    if (beforeStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = beforeStorage;
  }
});

test('browser workspace round-trips while desktop actions require the native bridge', async () => {
  const beforeWindow = globalThis.window;
  const beforeStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.equal(isNative(), false);
    await saveWorkspace({ version: 1, conversations: [{ id: 'one' }] });
    assert.deepEqual(await loadWorkspace(), { version: 1, conversations: [{ id: 'one' }] });
    await assert.rejects(startRun({ prompt: 'hello' }), /desktop app/);
    values.set('noai.workspace.v1', '{invalid');
    await assert.rejects(loadWorkspace(), /Cannot load browser preview workspace/);
  } finally {
    if (beforeWindow === undefined) delete globalThis.window;
    else globalThis.window = beforeWindow;
    if (beforeStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = beforeStorage;
  }
});

test('native bridge forwards Tauri command arguments and run events', async () => {
  const beforeWindow = globalThis.window;
  const calls = [];
  let eventCallback;
  const stop = () => {};
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push({ command, args }); return null; } },
    event: { listen: async (name, callback) => {
      assert.equal(name, 'noai:run');
      eventCallback = callback;
      return stop;
    } },
  } };
  try {
    const request = { runId: 'run-1', conversationId: 'conversation-1', prompt: 'hello' };
    assert.equal(isNative(), true);
    await startRun(request);
    assert.deepEqual(calls, [{ command: 'start_run', args: { request } }]);
    const events = [];
    assert.equal(await listenRunEvents((event) => events.push(event)), stop);
    eventCallback({ payload: { runId: 'run-1', type: 'done' } });
    assert.deepEqual(events, [{ runId: 'run-1', type: 'done' }]);
  } finally {
    if (beforeWindow === undefined) delete globalThis.window;
    else globalThis.window = beforeWindow;
  }
});

test('permission bypass defaults off and preserves explicit chat choice', () => {
  assert.equal(createConversation().dangerouslyBypassPermissions, false);
  assert.equal(normalizeWorkspace({conversations:[{dangerouslyBypassPermissions:true}]}).conversations[0].dangerouslyBypassPermissions,true);
  assert.equal(normalizeWorkspace({conversations:[{dangerouslyBypassPermissions:'true'}]}).conversations[0].dangerouslyBypassPermissions,false);
});

test('black-only logos are detected so dark themes can show them in white', async () => {
  const { isMonochromeSvg } = await import('../src/js/components/ui.js');
  assert.equal(isMonochromeSvg('<svg><path d="M0 0h1"/></svg>'), true);
  assert.equal(isMonochromeSvg('<svg><path fill="#000000" d="M0 0h1"/></svg>'), true);
  assert.equal(isMonochromeSvg('<svg><path fill="#D97757" d="M0 0h1"/></svg>'), false);
  assert.equal(isMonochromeSvg('<svg><linearGradient id="g"/><path fill="url(#g)"/></svg>'), false);
});
