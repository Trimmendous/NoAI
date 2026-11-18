export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function basename(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Choose a folder';
}

export function timeLabel(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function toast(message, type = 'info') {
  const node = element('div', `toast toast-${type}`, message);
  document.querySelector('#toast-region').append(node);
  setTimeout(() => node.remove(), 6000);
}
