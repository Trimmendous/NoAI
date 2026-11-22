// Accessibility settings, kept on this device and shared by every Noai
// window: text size (the whole interface zooms), colour-vision mode,
// increased contrast and reduced motion.
const KEY = 'noai.accessibility';
export const ACCESSIBILITY_DEFAULTS = { textSize: 100, vision: 'default', contrast: false, motion: false };
const VISIONS = new Set(['default', 'red-green', 'blue-yellow']);

export function readAccessibility() {
  let saved = {};
  try { saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const size = Number(saved.textSize);
  return {
    textSize: Number.isFinite(size) ? Math.min(150, Math.max(85, Math.round(size / 5) * 5)) : 100,
    vision: VISIONS.has(saved.vision) ? saved.vision : 'default',
    contrast: saved.contrast === true,
    motion: saved.motion === true,
  };
}

/** Applies (and with `changes`, saves) the settings to this window. */
export function applyAccessibility(changes = null) {
  const settings = { ...readAccessibility(), ...(changes || {}) };
  settings.textSize = Math.min(150, Math.max(85, Math.round((Number(settings.textSize) || 100) / 5) * 5));
  if (changes) { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)); } catch { /* not kept */ } }
  const root = globalThis.document?.documentElement;
  if (!root) return settings;
  if (settings.vision === 'default') delete root.dataset.vision; else root.dataset.vision = settings.vision;
  if (settings.contrast) root.dataset.contrast = 'more'; else delete root.dataset.contrast;
  if (settings.motion) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
  // Zoom the whole page, like the browser's zoom, so layout scales with the text.
  const scale = settings.textSize / 100;
  const webview = globalThis.__TAURI__?.webview?.getCurrentWebview?.();
  if (webview?.setZoom) { root.style.zoom = ''; void webview.setZoom(scale).catch(() => { root.style.zoom = String(scale); }); }
  else root.style.zoom = scale === 1 ? '' : String(scale);
  return settings;
}
