// Usage sources that are not agents Noai runs. Agents come from runtime_status.
export const USAGE_ONLY_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'gemini', label: 'Gemini CLI', harness: null }),
  Object.freeze({ id: 'copilot', label: 'GitHub Copilot', harness: null }),
  Object.freeze({ id: 'cursor', label: 'Cursor', harness: null }),
  Object.freeze({ id: 'openrouter', label: 'OpenRouter', harness: null }),
]);

export function buildProviderCards(runtime = {}) {
  const detected = new Map((Array.isArray(runtime.harnesses) ? runtime.harnesses : [])
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]));
  const agents = [...detected.values()].map((entry) => ({ id: entry.id, label: entry.label || entry.id, harness: entry.id }));
  return [...agents, ...USAGE_ONLY_PROVIDERS].map((provider) => {
    const harness = provider.harness ? detected.get(provider.harness) : null;
    return {
      id: provider.id,
      label: provider.label,
      harness: provider.harness,
      installed: harness ? harness.installed === true : null,
      plan: null,
      remaining: null,
      resetAt: null,
      usageStatus: 'unknown',
      detail: harness?.detail ?? 'Usage is unavailable in this app.',
    };
  });
}
