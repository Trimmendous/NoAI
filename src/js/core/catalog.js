// Agents come from the backend registry (runtime_status); nothing here names one.
export const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FALLBACK_PERMISSIONS = Object.freeze([Object.freeze({ id: 'provider-default', label: 'Existing CLI settings', description: 'Keep the CLI’s configured permissions.' })]);

export let HARNESSES = Object.freeze([]);

/** Replace the agent list with what the backend reports. */
export function setHarnesses(list = []) {
  const seen = new Set();
  HARNESSES = Object.freeze((Array.isArray(list) ? list : []).filter(item => {
    if (!item || typeof item.id !== 'string' || !HARNESS_ID.test(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).map(item => Object.freeze({
    id: item.id,
    label: typeof item.label === 'string' && item.label ? item.label : item.id,
    available: true,
    defaultModel: '',
    permissions: Object.freeze(Array.isArray(item.permissions) && item.permissions.length ? item.permissions.filter(mode => mode && typeof mode.id === 'string') : FALLBACK_PERMISSIONS),
    bypassDescription: typeof item.bypassDescription === 'string' && item.bypassDescription ? item.bypassDescription : `Skip ${item.label || item.id} permission checks.`,
  })));
  return HARNESSES;
}

export function getHarness(id) {
  return HARNESSES.find((harness) => harness.id === id) ?? null;
}

/** First usable agent that is installed on this machine, else the first usable one. */
export function preferredHarness(detected = [], current = '') {
  const installed = new Set(detected.filter(item => item.installed).map(item => item.id));
  const usable = HARNESSES.filter(item => item.available);
  if (current && installed.has(current)) return current;
  return usable.find(item => installed.has(item.id))?.id || (current && usable.some(item => item.id === current) ? current : usable[0]?.id || '');
}

export function harnessOptionLabel(harness, detected = []) {
  if (!harness.available) return `${harness.label} · coming soon`;
  return detected.find(item => item.id === harness.id)?.installed === false ? `${harness.label} (not detected)` : harness.label;
}

export function getDefaultModel(id) {
  return getHarness(id)?.defaultModel ?? '';
}

export function resolveModel(id, selection) {
  if (!getHarness(id)) throw new Error(`Unknown harness: ${id}`);
  return typeof selection === 'string' ? selection.trim() : '';
}
