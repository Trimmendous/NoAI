// Runs before styles load to prevent a flash of the wrong theme.
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('noai.appearance') || '{}');
    const preference = ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system';
    document.documentElement.dataset.theme = preference === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : preference;
    const legacyGrey = saved.v !== 2 && saved.palette === 'graphite';
    document.documentElement.dataset.palette = !legacyGrey && ['graphite', 'sage', 'blue', 'purple', 'amber'].includes(saved.palette) ? saved.palette : 'blue';
  } catch {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.palette = 'blue';
  }
})();
