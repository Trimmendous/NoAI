// Runs before styles load to prevent a flash of the wrong theme.
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('noai.appearance') || '{}');
    // A plugin theme's colours were saved when its plugin last loaded.
    const plugin = /^plugin:/.test(saved.theme || '') ? (JSON.parse(localStorage.getItem('noai.pluginThemes') || '{}') || {})[saved.theme] : null;
    if (plugin) {
      document.documentElement.dataset.theme = plugin.base === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.skin = 'plugin';
      for (const [name, value] of Object.entries(plugin.colors || {})) if (/^--[a-z0-9-]+$/.test(name)) document.documentElement.style.setProperty(name, value);
      if (/^(noaiplugin:\/\/localhost|http:\/\/noaiplugin\.localhost)\/[\w./-]+$/.test(plugin.background || '') && !plugin.background.includes('..')) {
        document.documentElement.style.setProperty('--theme-backdrop', `url("${plugin.background}")`);
        document.documentElement.style.setProperty('--theme-backdrop-opacity', String(plugin.backgroundOpacity || .3));
        document.documentElement.dataset.backdrop = 'on';
      }
    }
    const preference = ['light', 'dark', 'system', 'matrix'].includes(saved.theme) ? saved.theme : 'system';
    if (!plugin) {
      document.documentElement.dataset.theme = preference === 'system'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : preference === 'matrix' ? 'dark' : preference;
      if (preference === 'matrix') document.documentElement.dataset.skin = 'matrix';
    }
    const legacyGrey = saved.v !== 2 && saved.palette === 'graphite';
    document.documentElement.dataset.palette = !legacyGrey && ['graphite', 'sage', 'blue', 'purple', 'amber'].includes(saved.palette) ? saved.palette : 'blue';
    // Accessibility attributes too, so colours are right on the first paint.
    const access = JSON.parse(localStorage.getItem('noai.accessibility') || '{}');
    if (['red-green', 'blue-yellow'].includes(access.vision)) document.documentElement.dataset.vision = access.vision;
    if (access.contrast === true) document.documentElement.dataset.contrast = 'more';
    if (access.motion === true) document.documentElement.dataset.motion = 'reduce';
  } catch {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.palette = 'blue';
  }
})();
