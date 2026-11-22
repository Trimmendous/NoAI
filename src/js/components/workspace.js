import { element } from './dom.js';
import { createMessageRenderer } from './messages.js';

// Chat workspace: open chats as tabs, shown in panes that can be split
// side by side or top and bottom, again and again. The focused pane is the
// active conversation: the app's one composer, welcome screen and message
// log move into it, so sending, streaming and stopping work as before. Other
// panes keep their own live message log. Drag a tab (or a chat from the
// sidebar) onto a pane: its edges split the pane, its middle swaps the chat in.
// Dropping a chat outside the window tears it off into its own window
// (`onTearOff`); dragging that window's handle back over a pane docks it again.
// The layout is remembered on this device.

const KEY = 'noai.chatWorkspace';
const DRAG_TYPE = 'application/x-noai-chat';
const MIN_RATIO = .15;
let nextId = 1;
const newId = () => `pane-${Date.now().toString(36)}-${nextId++}`;
const pane = (conversationId = null) => ({ type: 'pane', id: newId(), conversationId });

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.root?.type) return saved;
  } catch { /* storage unavailable or damaged */ }
  const first = pane();
  return { root: first, focused: first.id, tabs: [] };
}

function panes(node, list = []) {
  if (node.type === 'pane') list.push(node);
  else { panes(node.a, list); panes(node.b, list); }
  return list;
}

/** Replaces the node with `id` by what `replace(node)` returns (or removes it when null). */
function rewrite(node, id, replace) {
  if (node.id === id) return replace(node);
  if (node.type === 'pane') return node;
  const a = rewrite(node.a, id, replace), b = rewrite(node.b, id, replace);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** Which part of a pane the pointer is over: an edge to split, or the middle. */
export function dropZone(rect, x, y) {
  const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
  const edges = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((p, q) => p[1] - q[1]);
  return edges[0][1] < .25 ? edges[0][0] : 'center';
}

export function initWorkspace({ layoutEl, tabsEl, dock, getState, titleOf, isRunning, onFocus, onNewChat, isDetached = () => false, onTearOff = () => {}, onShowDetached = () => {}, onDock = () => {} }) {
  let state = load();
  const renderers = new Map(); // pane id -> { el, messages, render }
  let signature = '';

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not kept */ } };
  const focusedPane = () => panes(state.root).find(item => item.id === state.focused) || panes(state.root)[0];
  const paneShowing = id => panes(state.root).find(item => item.conversationId === id);

  function setFocus(id) {
    const target = panes(state.root).find(item => item.id === id);
    if (!target || target.id === state.focused) return;
    state.focused = target.id;
    save();
    onFocus(target.conversationId);
  }

  function addTab(id) {
    if (id && !state.tabs.includes(id)) state.tabs = [...state.tabs, id];
  }

  function closePane(id) {
    if (panes(state.root).length < 2) return;
    state.root = rewrite(state.root, id, () => null);
    if (state.focused === id) {
      state.focused = panes(state.root)[0].id;
      onFocus(focusedPane().conversationId);
    }
    save(); draw(true);
  }

  function split(targetId, side, conversationId = null) {
    // A chat appears in one pane at a time: moving it closes its old pane.
    const previous = conversationId && paneShowing(conversationId);
    if (previous && previous.id !== targetId && panes(state.root).length > 1) state.root = rewrite(state.root, previous.id, () => null);
    else if (previous && previous.id !== targetId) previous.conversationId = null;
    const fresh = pane(conversationId);
    const dir = side === 'left' || side === 'right' ? 'row' : 'column';
    const first = side === 'left' || side === 'top';
    state.root = rewrite(state.root, targetId, node => ({ type: 'split', id: newId(), dir, ratio: .5, a: first ? fresh : node, b: first ? node : fresh }));
    addTab(conversationId);
    state.focused = fresh.id;
    save();
    onFocus(conversationId);
  }

  function show(targetId, conversationId) {
    const elsewhere = paneShowing(conversationId);
    const target = panes(state.root).find(item => item.id === targetId);
    if (!target) return;
    if (elsewhere && elsewhere.id !== targetId) elsewhere.conversationId = target.conversationId; // swap
    target.conversationId = conversationId;
    addTab(conversationId);
    state.focused = target.id;
    save();
    onFocus(conversationId);
  }

  function closeTab(id) {
    state.tabs = state.tabs.filter(tab => tab !== id);
    for (const item of panes(state.root).filter(node => node.conversationId === id)) {
      if (item.id !== state.focused && panes(state.root).length > 1) state.root = rewrite(state.root, item.id, () => null);
      else item.conversationId = state.tabs.at(-1) ?? null;
    }
    if (!panes(state.root).some(item => item.id === state.focused)) state.focused = panes(state.root)[0].id;
    save();
    onFocus(focusedPane().conversationId);
  }

  // ---- drag and drop -----------------------------------------------------
  // A chat window's handle may arrive as plain text ("noai-chat:<id>") from the other window.
  const dragged = event => event.dataTransfer?.types?.includes(DRAG_TYPE) || event.dataTransfer?.types?.includes('text/plain');
  const draggedId = event => event.dataTransfer.getData(DRAG_TYPE) || (/^noai-chat:([\w-]{1,64})$/.exec(event.dataTransfer.getData('text/plain') || '') || [])[1] || '';
  function enableDrop(el, item) {
    el.addEventListener('dragover', event => {
      if (!dragged(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      el.dataset.drop = dropZone(el.getBoundingClientRect(), event.clientX, event.clientY);
    });
    el.addEventListener('dragleave', event => { if (!el.contains(event.relatedTarget)) delete el.dataset.drop; });
    el.addEventListener('drop', event => {
      if (!dragged(event)) return;
      event.preventDefault();
      const zone = el.dataset.drop || 'center';
      delete el.dataset.drop;
      const id = draggedId(event);
      if (!getState().conversations.some(conversation => conversation.id === id)) return;
      if (isDetached(id)) onDock(id);
      if (zone === 'center') show(item.id, id); else split(item.id, zone, id);
    });
  }
  /** Lets any element (a tab, a sidebar chat) be dragged into the workspace. */
  function makeDraggable(el, conversationId) {
    el.draggable = true;
    el.addEventListener('dragstart', event => {
      event.dataTransfer.setData(DRAG_TYPE, conversationId);
      event.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('is-dragging-chat');
    });
    el.addEventListener('dragend', event => {
      document.body.classList.remove('is-dragging-chat');
      // Dropped outside the window: tear the chat off into its own window there.
      const outside = event.screenX < window.screenX || event.screenY < window.screenY
        || event.screenX > window.screenX + window.outerWidth || event.screenY > window.screenY + window.outerHeight;
      if (event.dataTransfer.dropEffect === 'none' && outside) onTearOff(conversationId, event.screenX - 120, event.screenY - 20);
      layoutEl.querySelectorAll('[data-drop]').forEach(node => { delete node.dataset.drop; });
    });
  }

  // ---- drawing -------------------------------------------------------------
  function icon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
    return svg;
  }
  function tool(label, paths, action) {
    const button = element('button', 'icon-button pane-tool');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.append(icon(paths));
    button.addEventListener('click', event => { event.stopPropagation(); action(); });
    return button;
  }

  function drawNode(node, multi) {
    if (node.type === 'split') {
      const box = element('div', `pane-split is-${node.dir}`);
      box.style.setProperty('--ratio', String(node.ratio));
      const a = drawNode(node.a, multi), b = drawNode(node.b, multi);
      a.classList.add('pane-first');
      const divider = element('div', 'pane-divider');
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
      divider.addEventListener('pointerdown', event => {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        const rect = box.getBoundingClientRect();
        const move = moveEvent => {
          const ratio = node.dir === 'row' ? (moveEvent.clientX - rect.left) / rect.width : (moveEvent.clientY - rect.top) / rect.height;
          node.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
          box.style.setProperty('--ratio', String(node.ratio));
        };
        const up = () => { divider.removeEventListener('pointermove', move); save(); };
        divider.addEventListener('pointermove', move);
        divider.addEventListener('pointerup', up, { once: true });
        divider.addEventListener('pointercancel', up, { once: true });
      });
      divider.addEventListener('dblclick', () => { node.ratio = .5; box.style.setProperty('--ratio', '.5'); save(); });
      box.append(a, divider, b);
      return box;
    }
    const el = element('section', 'chat-pane');
    el.dataset.pane = node.id;
    const head = element('header', 'pane-head');
    const title = element('span', 'pane-title');
    head.append(title, element('span', 'pane-badge'));
    head.append(
      tool('Open in new window', ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'], () => { if (node.conversationId) onTearOff(node.conversationId); }),
      tool('Split right', ['M4 5h16v14H4z', 'M12 5v14'], () => split(node.id, 'right')),
      tool('Split down', ['M4 5h16v14H4z', 'M4 12h16'], () => split(node.id, 'bottom')),
    );
    if (multi) head.append(tool('Close pane', ['M7 7l10 10M17 7 7 17'], () => closePane(node.id)));
    const body = element('div', 'pane-body');
    el.append(head, body);
    el.addEventListener('pointerdown', () => setFocus(node.id));
    enableDrop(el, node);
    const messages = element('div', 'messages pane-messages');
    messages.setAttribute('role', 'log');
    renderers.set(node.id, { el, head, title, body, messages, render: createMessageRenderer(messages) });
    return el;
  }

  function draw(force = false) {
    const list = panes(state.root);
    const next = JSON.stringify([state.root, list.length]);
    if (!force && next === signature) return;
    signature = next;
    // Keep the shared chat pieces alive while the tree is rebuilt.
    dock.home.append(dock.messages, dock.welcome, dock.composer);
    renderers.clear();
    layoutEl.replaceChildren(drawNode(state.root, list.length > 1));
    layoutEl.classList.toggle('is-split', list.length > 1);
  }

  function drawTabs(conversations) {
    const focused = focusedPane();
    const fragment = document.createDocumentFragment();
    for (const id of state.tabs) {
      const conversation = conversations.find(item => item.id === id);
      if (!conversation) continue;
      const detached = isDetached(id);
      const tab = element('div', `chat-tab${focused.conversationId === id ? ' is-active' : ''}${paneShowing(id) ? ' is-visible' : ''}${detached ? ' is-detached' : ''}`);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(focused.conversationId === id));
      const open = element('button', 'chat-tab-open');
      open.type = 'button';
      open.title = detached ? `${conversation.title} — open in its own window` : `${conversation.title} — drag onto a pane to split, or out of the window to open it on its own`;
      if (isRunning(id)) open.append(element('span', 'chat-tab-dot'));
      open.append(element('span', 'chat-tab-title', titleOf(conversation)));
      if (detached) open.append(element('span', 'chat-tab-window', '↗'));
      open.addEventListener('click', () => {
        if (detached) { onShowDetached(id); return; }
        const shown = paneShowing(id);
        if (shown) setFocus(shown.id); else show(focused.id, id);
      });
      const close = element('button', 'chat-tab-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${conversation.title}`);
      close.addEventListener('click', () => closeTab(id));
      tab.append(open, close);
      makeDraggable(tab, id);
      fragment.append(tab);
    }
    const add = element('button', 'chat-tab-new', '+');
    add.type = 'button'; add.title = 'New chat'; add.setAttribute('aria-label', 'New chat');
    add.addEventListener('click', onNewChat);
    fragment.append(add);
    tabsEl.replaceChildren(fragment);
    tabsEl.hidden = !state.tabs.length && panes(state.root).length < 2;
  }

  /** Called on every app render: follow the active chat, then refresh each pane. */
  function sync() {
    const app = getState();
    const known = new Set(app.conversations.map(item => item.id));
    state.tabs = state.tabs.filter(id => known.has(id));
    for (const item of panes(state.root)) if (item.conversationId && !known.has(item.conversationId)) item.conversationId = null;
    // A chat in its own window isn't shown in a pane as well.
    for (const item of panes(state.root)) {
      if (!item.conversationId || !isDetached(item.conversationId)) continue;
      if (item.id !== state.focused && panes(state.root).length > 1) state.root = rewrite(state.root, item.id, () => null);
      else item.conversationId = null;
    }
    const focused = focusedPane();
    state.focused = focused.id;
    // The focused pane always shows the active chat (sidebar picks, new chats, sends).
    if (focused.conversationId !== app.activeConversationId) {
      // Picking a chat that has its own window brings that window forward instead.
      if (app.activeConversationId && isDetached(app.activeConversationId)) { onShowDetached(app.activeConversationId); onFocus(focused.conversationId); return; }
      const elsewhere = app.activeConversationId && paneShowing(app.activeConversationId);
      if (elsewhere && elsewhere.id !== focused.id) { state.focused = elsewhere.id; }
      else focused.conversationId = app.activeConversationId;
      save();
    }
    addTab(app.activeConversationId);
    draw();
    for (const item of panes(state.root)) {
      const view = renderers.get(item.id);
      if (!view) continue;
      const isFocused = item.id === state.focused;
      const conversation = app.conversations.find(entry => entry.id === item.conversationId);
      view.el.classList.toggle('is-focused', isFocused);
      view.title.textContent = conversation ? titleOf(conversation) : 'New chat';
      view.head.querySelector('.pane-badge').textContent = conversation && isRunning(conversation.id) ? 'Working' : '';
      if (isFocused) {
        if (dock.messages.parentElement !== view.body) {
          view.messages.remove();
          view.body.append(dock.messages, dock.welcome, dock.composer);
        }
      } else {
        if (view.messages.parentElement !== view.body) view.body.replaceChildren(view.messages);
        view.render(conversation);
        if (!conversation) view.messages.replaceChildren(element('p', 'pane-empty', 'New chat · click to write here'));
      }
    }
    drawTabs(app.conversations);
    save();
  }

  return { sync, makeDraggable, splitFocused: (side, conversationId = null) => split(state.focused, side, conversationId) };
}
