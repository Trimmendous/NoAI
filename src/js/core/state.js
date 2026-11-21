export const WORKSPACE_VERSION = 1;

const THEMES = new Set(['system', 'light', 'dark']);
const PALETTES = new Set(['graphite', 'sage', 'blue', 'purple', 'amber']);
// Version 2 made blue the default. Grey from before then was the old default, not a choice.
const PALETTE_VERSION = 2;
const ROLES = new Set(['user', 'assistant', 'system']);
import { HARNESS_ID } from './catalog.js';
const SAVED_STATUSES = new Set(['complete', 'error', 'interrupted']);
const TRANSIENT_STATUSES = new Set(['queued', 'running', 'streaming']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value) {
  const trimmed = text(value).trim();
  return trimmed || null;
}

function timestamp(value, fallback) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function customModels(value) {
  const input = object(value);
  const clean = (models) => Array.isArray(models)
    ? [...new Set(models.filter((model) => typeof model === 'string').map((model) => model.trim()).filter(Boolean))]
    : [];
  return Object.fromEntries(Object.entries(input).filter(([harness]) => HARNESS_ID.test(harness)).map(([harness, models]) => [harness, clean(models)]));
}

export function createInitialWorkspace() {
  return {
    version: WORKSPACE_VERSION,
    conversations: [],
    activeConversationId: null,
    projectPath: null,
    preferences: { theme: 'system', palette: 'blue', paletteVersion: PALETTE_VERSION, customModels: {}, autoResume: true, backgroundMode: true, manualPlans: {} },
  };
}

export function normalizeMessage(raw, now = new Date().toISOString()) {
  const input = object(raw);
  const status = text(input.status);
  const normalized = {
    id: nullableText(input.id) ?? newId(),
    role: ROLES.has(input.role) ? input.role : 'assistant',
    content: text(input.content),
    createdAt: timestamp(input.createdAt, now),
  };
  if (SAVED_STATUSES.has(status)) normalized.status = status;
  else if (status) normalized.status = 'interrupted';
  if (nullableText(input.runId)) normalized.runId = input.runId;
  if (Number.isSafeInteger(input.lastEventId) && input.lastEventId >= 0) normalized.lastEventId = input.lastEventId;
  return normalized;
}

export function normalizeConversation(raw, now = new Date().toISOString()) {
  const input = object(raw);
  const createdAt = timestamp(input.createdAt, now);
  const messages = Array.isArray(input.messages)
    ? input.messages.map((message) => normalizeMessage(message, createdAt))
    : [];
  const seen = new Set();
  for (const message of messages) {
    if (seen.has(message.id)) message.id = newId();
    seen.add(message.id);
  }
  return {
    id: nullableText(input.id) ?? newId(),
    title: nullableText(input.title) ?? 'New conversation',
    harness: typeof input.harness === 'string' && HARNESS_ID.test(input.harness) ? input.harness : '',
    model: text(input.model).trim(),
    projectPath: nullableText(input.projectPath),
    resumeId: nullableText(input.resumeId),
    dangerouslyBypassPermissions: input.dangerouslyBypassPermissions === true,
    draft: text(input.draft),
    messages,
    createdAt,
    updatedAt: timestamp(input.updatedAt, createdAt),
  };
}

export function normalizeWorkspace(raw) {
  const input = object(raw);
  const initial = createInitialWorkspace();
  const conversations = Array.isArray(input.conversations)
    ? input.conversations.map((conversation) => normalizeConversation(conversation))
    : [];
  const seen = new Set();
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) conversation.id = newId();
    seen.add(conversation.id);
  }
  const preferences = object(input.preferences);
  const requestedActiveId = nullableText(input.activeConversationId);
  return {
    version: WORKSPACE_VERSION,
    conversations,
    activeConversationId: seen.has(requestedActiveId) ? requestedActiveId : null,
    projectPath: nullableText(input.projectPath),
    preferences: {
      theme: THEMES.has(preferences.theme) ? preferences.theme : initial.preferences.theme,
      palette: PALETTES.has(preferences.palette) && !(preferences.palette === 'graphite' && preferences.paletteVersion !== PALETTE_VERSION) ? preferences.palette : initial.preferences.palette,
      paletteVersion: PALETTE_VERSION,
      autoResume: preferences.autoResume !== false,
      backgroundMode: preferences.backgroundMode !== false,
      manualPlans: Object.fromEntries(Object.entries(object(preferences.manualPlans)).filter(([key, value]) => /^[a-z]+$/.test(key) && typeof value === 'string').map(([key, value]) => [key, value.slice(0, 80)])),
      customModels: customModels(preferences.customModels),
    },
  };
}

export function createMessage(role, content, options = {}) {
  const message = normalizeMessage({ id: newId(), role, content, createdAt: new Date().toISOString(), ...options });
  if (TRANSIENT_STATUSES.has(options.status)) message.status = options.status;
  return message;
}

export function createConversation(options = {}) {
  return normalizeConversation({
    id: newId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...options,
  });
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function createStore(initial) {
  let state = freezeDeep(clone(initial));
  const listeners = new Set();
  return {
    getState() { return state; },
    setState(update) {
      const next = typeof update === 'function' ? update(state) : update;
      if (next === state) return state;
      if (next === undefined) throw new TypeError('setState requires a state value');
      state = freezeDeep(clone(next));
      for (const listener of [...listeners]) listener(state);
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
