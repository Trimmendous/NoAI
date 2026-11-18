export const HARNESSES = Object.freeze([
  Object.freeze({ id: 'codex', label: 'Codex', executable: 'codex', available: true, defaultModel: '' }),
  Object.freeze({ id: 'claude', label: 'Claude Code', executable: 'claude', available: true, defaultModel: '' }),
  Object.freeze({ id: 'opencode', label: 'OpenCode', executable: null, available: false, defaultModel: '', detail: 'Coming soon' }),
]);

export function getHarness(id) {
  return HARNESSES.find((harness) => harness.id === id) ?? null;
}

export function getDefaultModel(id) {
  return getHarness(id)?.defaultModel ?? '';
}

export function resolveModel(id, selection) {
  if (!getHarness(id)) throw new Error(`Unknown harness: ${id}`);
  return typeof selection === 'string' ? selection.trim() : '';
}
