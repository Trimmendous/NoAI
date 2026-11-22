import { element } from './dom.js';

// ⌘K command palette: Noai's own actions plus commands from plugins.
// `getCommands()` returns [{ key, title, hint?, run }].
export function initPalette({ dialog, input, list, getCommands }) {
  let items = [], selected = 0;
  function draw() {
    const query = input.value.trim().toLowerCase();
    items = getCommands().filter(item => !query || `${item.title} ${item.hint || ''}`.toLowerCase().includes(query)).slice(0, 50);
    selected = Math.min(selected, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((item, index) => {
      const option = element('button', `palette-item${index === selected ? ' is-selected' : ''}`);
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === selected));
      option.append(element('span', 'palette-title', item.title));
      if (item.hint) option.append(element('span', 'palette-hint', item.hint));
      option.addEventListener('click', () => choose(index));
      option.addEventListener('mousemove', () => { if (selected !== index) { selected = index; draw(); } });
      return option;
    }));
    if (!items.length) list.append(element('p', 'palette-empty', 'No matching commands.'));
  }
  function choose(index) {
    const item = items[index];
    if (!item) return;
    dialog.close();
    void item.run();
  }
  function open() {
    if (dialog.open) return;
    input.value = '';
    selected = 0;
    draw();
    dialog.showModal();
    input.focus();
  }
  input.addEventListener('input', () => { selected = 0; draw(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(items.length - 1, selected + 1); draw(); list.children[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(0, selected - 1); draw(); list.children[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(selected); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  return { open };
}
