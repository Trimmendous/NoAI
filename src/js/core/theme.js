const validThemes = new Set(['system', 'light', 'dark']);
const validPalettes = new Set(['graphite', 'sage', 'blue', 'amber']);
const APPEARANCE_KEY = 'noai.appearance';

function storedAppearance() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(APPEARANCE_KEY) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function applyTheme(preferences = {}) {
  const source = { ...storedAppearance(), ...preferences };
  const theme = validThemes.has(source.theme) ? source.theme : 'system';
  const palette = validPalettes.has(source.palette) ? source.palette : 'graphite';
  const dark = theme === 'dark' || (theme === 'system' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  if (globalThis.document?.documentElement) {
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePreference = theme;
    root.dataset.palette = palette;
  }
  try {
    globalThis.localStorage?.setItem(APPEARANCE_KEY, JSON.stringify({ theme, palette }));
  } catch {
    // Browser preview storage may be disabled.
  }
  return { theme, palette, resolvedTheme: dark ? 'dark' : 'light' };
}

export function initTheme(preferences = {}, onChange) {
  let current = preferences;
  applyTheme(current);
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const update = () => {
    const applied = applyTheme(current);
    if (typeof onChange === 'function') onChange(applied);
  };
  media?.addEventListener?.('change', update);
  return {
    update(preferencesNext) {
      current = preferencesNext ?? {};
      return applyTheme(current);
    },
    dispose() { media?.removeEventListener?.('change', update); },
  };
}
