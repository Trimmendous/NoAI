export const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'codex', label: 'Codex', harness: 'codex' }),
  Object.freeze({ id: 'claude', label: 'Claude Code', harness: 'claude' }),
  Object.freeze({ id: 'gemini', label: 'Gemini CLI', harness: null }),
  Object.freeze({ id: 'copilot', label: 'GitHub Copilot', harness: null }),
  Object.freeze({ id: 'cursor', label: 'Cursor', harness: null }),
  Object.freeze({ id: 'openrouter', label: 'OpenRouter', harness: null }),
]);

export function buildProviderCards(runtime = {}) {
  const detected = new Map((Array.isArray(runtime.harnesses) ? runtime.harnesses : [])
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]));
  return PROVIDERS.map((provider) => {
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
