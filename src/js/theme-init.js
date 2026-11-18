// Runs before styles load to prevent a flash of the wrong theme.
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('noai.appearance') || '{}');
    const preference = ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system';
    document.documentElement.dataset.theme = preference === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : preference;
    document.documentElement.dataset.palette = ['graphite', 'sage', 'blue', 'amber'].includes(saved.palette) ? saved.palette : 'graphite';
  } catch {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.palette = 'graphite';
  }
})();
