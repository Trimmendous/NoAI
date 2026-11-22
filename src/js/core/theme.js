const validThemes = new Set(['system', 'light', 'dark', 'matrix']);
const validPalettes = new Set(['graphite', 'sage', 'blue', 'purple', 'amber']);
const APPEARANCE_KEY = 'noai.appearance';
const PLUGIN_THEMES_KEY = 'noai.pluginThemes';
export const PLUGIN_THEME = /^plugin:[a-z0-9-]{1,40}:[a-z0-9-]{1,40}$/;
const SAFE_VAR = /^--[a-z0-9-]{1,40}$/, SAFE_VALUE = /^[#a-zA-Z0-9(),.%\s/-]{1,80}$/;

/**
 * Themes from enabled plugins: { 'plugin:<plugin>:<theme>': { name, base, colors } }.
 * Kept in storage so the first paint (theme-init.js) already uses them.
 */
export function setPluginThemes(themes) {
  const clean = {};
  for (const [key, theme] of Object.entries(themes || {})) {
    if (!PLUGIN_THEME.test(key) || !theme || typeof theme !== 'object') continue;
    const colors = Object.fromEntries(Object.entries(theme.colors || {}).filter(([name, value]) => SAFE_VAR.test(name) && typeof value === 'string' && SAFE_VALUE.test(value) && !/url\s*\(/i.test(value)));
    // A background picture must be a file from the plugin itself (host resolves the URL).
    const background = typeof theme.backgroundUrl === 'string' && SAFE_BACKGROUND.test(theme.backgroundUrl) ? theme.backgroundUrl : '';
    const opacity = Number(theme.backgroundOpacity);
    clean[key] = { name: String(theme.name || key).slice(0, 40), base: theme.base === 'light' ? 'light' : 'dark', colors, background, backgroundOpacity: Number.isFinite(opacity) ? Math.min(.6, Math.max(.05, opacity)) : .3 };
  }
  try { globalThis.localStorage?.setItem(PLUGIN_THEMES_KEY, JSON.stringify(clean)); } catch { /* not kept */ }
  return clean;
}
export function pluginThemes() {
  try { return JSON.parse(globalThis.localStorage?.getItem(PLUGIN_THEMES_KEY) || '{}') || {}; } catch { return {}; }
}
let appliedVars = [];
const SAFE_BACKGROUND = /^(noaiplugin:\/\/localhost|http:\/\/noaiplugin\.localhost)\/[a-z0-9-]{1,40}\/[\w./-]{1,200}$/;

function storedAppearance() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(APPEARANCE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    // Before version 2, grey was the default rather than a choice; move it to the new blue default.
    return value.v !== 2 && value.palette === 'graphite' ? { ...value, palette: 'blue' } : value;
  } catch {
    return {};
  }
}

export function applyTheme(preferences = {}) {
  const source = { ...storedAppearance(), ...preferences };
  const plugin = PLUGIN_THEME.test(source.theme || '') ? pluginThemes()[source.theme] : null;
  const theme = validThemes.has(source.theme) || plugin ? source.theme : 'system';
  const palette = validPalettes.has(source.palette) ? source.palette : 'blue';
  // Matrix is a dark theme with its own green look; every dark-mode rule still applies.
  const dark = plugin ? plugin.base === 'dark' : theme === 'dark' || theme === 'matrix' || (theme === 'system' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  if (globalThis.document?.documentElement) {
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    if (theme === 'matrix') root.dataset.skin = 'matrix';
    else if (plugin) root.dataset.skin = 'plugin';
    else delete root.dataset.skin;
    // A plugin theme sets its colours directly; switching away removes them.
    for (const name of appliedVars) root.style?.removeProperty?.(name);
    appliedVars = [];
    for (const [name, value] of Object.entries(plugin?.colors || {})) { root.style?.setProperty?.(name, value); appliedVars.push(name); }
    // Optional picture behind the app (e.g. a flag), shown faintly under see-through panels.
    if (plugin?.background && !plugin.background.includes('..')) {
      root.style?.setProperty?.('--theme-backdrop', `url("${plugin.background}")`);
      root.style?.setProperty?.('--theme-backdrop-opacity', String(plugin.backgroundOpacity ?? .3));
      appliedVars.push('--theme-backdrop', '--theme-backdrop-opacity');
      root.dataset.backdrop = 'on';
    } else delete root.dataset.backdrop;
    root.dataset.themePreference = theme;
    root.dataset.palette = palette;
  }
  try {
    globalThis.localStorage?.setItem(APPEARANCE_KEY, JSON.stringify({ theme, palette, v: 2 }));
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
