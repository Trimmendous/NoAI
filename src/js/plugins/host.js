import { element } from '../components/dom.js';
import { pill, row as uiRow, tile } from '../components/ui.js';

// Runs Noai plugins (see PLUGINS.md). Every plugin page and background script
// is a sandboxed iframe served from noaiplugin://, with no access to Noai
// except the API below, and only for the permissions it declared.
//
// The API runs over a private MessageChannel, handed to each frame once, when
// the plugin's page says hello. Sandboxed frames all have the opaque origin
// "null", so a message's origin can't tell the plugin from a site it was sent
// to. If the frame later loads another document (a clicked link, a redirect),
// Noai closes the port, so that page never talks to Noai, and replaces the
// frame with a fresh one.

const SANDBOX = 'allow-scripts allow-forms allow-modals';
const PATH = /^[\w.-]+(\/[\w.-]+)*$/;
const MAX_RELOADS = 3; // a frame that keeps leaving its page is left blank
// Which permission each API call needs (null: always allowed).
const METHODS = {
  'app.info': null, 'chats.open': null, 'storage.get': null, 'storage.set': null,
  'chats.list': 'chats:read', 'chats.get': 'chats:read', 'chats.send': 'chats:write',
  'jobs.list': 'jobs:read', 'jobs.runs': 'jobs:read', 'metrics.summary': 'metrics:read', 'notify': 'notify',
};
export const PERMISSION_TEXT = {
  'chats:read': 'Read your chats', 'chats:write': 'Start agent runs in chats', 'jobs:read': 'Read your jobs and their runs',
  'metrics:read': 'Read usage numbers', 'notify': 'Show notifications', 'network': 'Use the internet',
};

export function initPluginHost({ native, platform, navEl, viewEl, workersEl, setView, getView, toast, api, onThemes, onManage = () => {} }) {
  let plugins = [], pages = [], commands = [], current = null;
  const links = new Map(); // iframe -> { plugin, port } while its own page is loaded
  const frameState = new WeakMap(); // iframe -> { plugin, used, ownLoadPending, … }
  const pageFrames = new Map(); // page key -> iframe
  const workers = new Map(); // plugin id -> iframe
  const waiting = new Map(); // command token -> { resolve, reject }
  const base = () => (platform() === 'windows' ? 'http://noaiplugin.localhost/' : 'noaiplugin://localhost/');
  const allowed = (plugin, permission) => !permission || plugin.permissions.includes(permission);

  /**
   * A plugin frame. It gets an API port once, when its page says hello, and
   * never again. The first load after that is the page's own (unless it had
   * already loaded); any later load means the frame went somewhere else, so
   * the port is closed and the frame is swapped for a fresh one.
   */
  function frame(plugin, path, className, reloads = 0) {
    const node = element('iframe', className);
    node.setAttribute('sandbox', SANDBOX);
    node.setAttribute('referrerpolicy', 'no-referrer');
    node.title = plugin.name;
    const state = { plugin, used: false, ownLoadPending: false, rebuild: () => frame(plugin, path, className, reloads + 1), reloads };
    frameState.set(node, state);
    node.addEventListener('load', () => {
      if (!links.has(node)) return; // the empty first document, or a page without the SDK
      if (state.ownLoadPending) { state.ownLoadPending = false; return; }
      left(node);
    });
    node.src = `${base()}${plugin.id}/${path}`;
    return node;
  }

  /** The frame loaded a page Noai didn't give it: cut it off and start over. */
  function left(node) {
    const state = frameState.get(node);
    unlink(node);
    if (state.reloads >= MAX_RELOADS) {
      toast(`${state.plugin.name} kept leaving its page, so Noai stopped it. Turn it off and on to try again.`, 'error');
      node.removeAttribute('src');
      return;
    }
    toast(`${state.plugin.name} tried to open another page inside Noai, so Noai reloaded it.`, 'error');
    const fresh = state.rebuild();
    fresh.hidden = node.hidden;
    for (const map of [workers, pageFrames]) for (const [key, value] of map) if (value === node) map.set(key, fresh);
    node.replaceWith(fresh);
  }

  /** Gives a frame's page its own API port, once per frame. */
  function connect(node, loaded) {
    const state = frameState.get(node);
    if (state.used || !node.contentWindow) return;
    state.used = true;
    state.ownLoadPending = !loaded;
    const channel = new MessageChannel();
    const link = { plugin: state.plugin, port: channel.port1 };
    channel.port1.onmessage = event => receive(link, event.data);
    links.set(node, link);
    node.contentWindow.postMessage({ noai: 1, connect: true }, '*', [channel.port2]);
    link.port.postMessage(themeMessage());
  }
  function unlink(node) {
    const link = links.get(node);
    if (!link) return;
    link.port.onmessage = null;
    link.port.close();
    links.delete(node);
  }
  // A page's hello, the only message Noai takes outside a port.
  addEventListener('message', event => {
    if (event.data?.noai !== 1 || !event.data.hello) return;
    for (const node of [...workers.values(), ...pageFrames.values()]) {
      if (node.contentWindow && node.contentWindow === event.source) { connect(node, event.data.loaded === true); return; }
    }
  });

  /** Noai's current colours, so plugin pages can match. */
  function themeMessage() {
    const style = getComputedStyle(document.documentElement);
    const vars = Object.fromEntries(['canvas', 'surface', 'surface-subtle', 'ink', 'ink-soft', 'ink-muted', 'line', 'accent', 'accent-ink', 'fill'].map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
    return { noai: 1, theme: { dark: document.documentElement.dataset.theme === 'dark', vars } };
  }
  function sendTheme(node) { links.get(node)?.port.postMessage(themeMessage()); }

  // ---- loading ---------------------------------------------------------------
  async function load() {
    if (!native) { plugins = []; draw(); return; }
    try { plugins = await api.list(); }
    catch (error) { plugins = []; toast(`Could not load plugins: ${String(error)}`, 'error'); }
    const on = plugins.filter(plugin => plugin.enabled);
    pages = on.flatMap(plugin => (plugin.manifest.pages || []).filter(page => page && PATH.test(page.entry || '') && /^[\w-]{1,40}$/.test(page.id || '')).map(page => ({
      key: `${plugin.id}:${page.id}`, plugin, title: String(page.title || page.id).slice(0, 40), icon: String(page.icon || page.title || '?').slice(0, 2), entry: page.entry,
    })));
    commands = on.flatMap(plugin => (plugin.manifest.commands || []).filter(command => command && /^[\w-]{1,40}$/.test(command.id || '')).map(command => ({
      key: `${plugin.id}:${command.id}`, plugin, id: command.id, title: String(command.title || command.id).slice(0, 80), context: command.context === 'chat' ? 'chat' : 'global',
    })));
    const themes = {};
    for (const plugin of on) for (const theme of plugin.manifest.themes || []) {
      if (!theme || !/^[a-z0-9-]{1,40}$/.test(theme.id || '')) continue;
      const background = typeof theme.background === 'string' && PATH.test(theme.background) && !theme.background.includes('..') ? `${base()}${plugin.id}/${theme.background}` : '';
      themes[`plugin:${plugin.id}:${theme.id}`] = { ...theme, name: `${theme.name || theme.id}`, backgroundUrl: background };
    }
    onThemes(themes);
    // Background scripts: one hidden frame per plugin that has `main`.
    for (const [id, node] of workers) if (!on.some(plugin => plugin.id === id && plugin.manifest.main)) { unlink(node); node.remove(); workers.delete(id); }
    for (const plugin of on) if (plugin.manifest.main && PATH.test(plugin.manifest.main) && !workers.has(plugin.id)) {
      const node = frame(plugin, '__main.html', 'plugin-worker');
      workers.set(plugin.id, node);
      workersEl.append(node);
    }
    for (const [key, node] of pageFrames) if (!pages.some(page => page.key === key)) { unlink(node); node.remove(); pageFrames.delete(key); }
    if (current && !pages.some(page => page.key === current)) { current = null; if (getView() === 'plugin') setView('chat'); }
    draw();
  }

  // ---- sidebar and page view ----------------------------------------------------
  function draw() {
    navEl.querySelectorAll('.plugin-nav').forEach(node => node.remove());
    if (!pages.length) return;
    const label = element('div', 'nav-group-label plugin-nav plugin-nav-head');
    const manage = element('button', 'plugin-manage', 'Manage');
    manage.type = 'button';
    manage.title = 'Install, turn on or delete plugins';
    manage.addEventListener('click', onManage);
    label.append(element('span', '', 'Plugins'), manage);
    navEl.append(label);
    for (const page of pages) {
      const button = element('button', 'nav-item plugin-nav');
      button.type = 'button';
      button.title = `${page.title} · ${page.plugin.name}`;
      button.dataset.pluginPage = page.key;
      const mark = element('span', 'plugin-nav-icon', page.icon);
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark, element('span', '', page.title));
      button.addEventListener('click', () => show(page.key));
      navEl.append(button);
    }
    renderNav();
  }
  function renderNav() {
    navEl.querySelectorAll('[data-plugin-page]').forEach(button => {
      const selected = getView() === 'plugin' && button.dataset.pluginPage === current;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  function show(key) {
    const page = pages.find(item => item.key === key);
    if (!page) return;
    current = key;
    if (!pageFrames.has(key)) {
      const node = frame(page.plugin, page.entry, 'plugin-frame');
      pageFrames.set(key, node);
      viewEl.append(node);
    }
    for (const [other, node] of pageFrames) node.hidden = other !== key;
    setView('plugin');
  }
  const title = () => pages.find(page => page.key === current)?.title || 'Plugin';

  // ---- the plugin API --------------------------------------------------------------
  function storageKey(plugin) { return `noai.plugin.${plugin.id}`; }
  function readStore(plugin) { try { return JSON.parse(localStorage.getItem(storageKey(plugin)) || '{}') || {}; } catch { return {}; } }
  async function handle(plugin, method, params = {}) {
    if (!(method in METHODS)) throw new Error(`Unknown method ${method}`);
    if (!allowed(plugin, METHODS[method])) throw new Error(`${plugin.name} needs the "${METHODS[method]}" permission for ${method}`);
    switch (method) {
      case 'app.info': return api.appInfo();
      case 'chats.list': return api.listChats();
      case 'chats.get': return api.getChat(String(params.id || ''));
      case 'chats.open': return api.openChat(String(params.id || ''));
      case 'chats.send': return api.sendChat(params);
      case 'jobs.list': return api.listJobs();
      case 'jobs.runs': return api.jobRuns(String(params.id || ''));
      case 'metrics.summary': return api.metricsSummary(['24h', '7d', '30d', 'all'].includes(params.range) ? params.range : '7d');
      case 'notify': toast(`${plugin.name}: ${String(params.text || '').slice(0, 300)}`, params.tone === 'error' ? 'error' : undefined); return true;
      case 'storage.get': return readStore(plugin)[String(params.key)] ?? null;
      case 'storage.set': {
        const data = { ...readStore(plugin), [String(params.key).slice(0, 100)]: params.value };
        const text = JSON.stringify(data);
        if (text.length > 256 * 1024) throw new Error('Plugin storage is limited to 256 KB');
        localStorage.setItem(storageKey(plugin), text);
        return true;
      }
    }
    return null;
  }

  async function receive(link, message) {
    const { plugin, port } = link;
    if (!message || message.noai !== 1) return;
    if (message.ready) { port.postMessage(themeMessage()); return; }
    if (message.commandDone) {
      const request = waiting.get(message.commandDone);
      if (request) { waiting.delete(message.commandDone); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result); }
      return;
    }
    if (!message.id || typeof message.method !== 'string') return;
    // The link may have been closed while the call ran; a closed port drops the reply.
    try { port.postMessage({ noai: 1, id: message.id, result: await handle(plugin, message.method, message.params || {}) }); }
    catch (error) { port.postMessage({ noai: 1, id: message.id, error: String(error?.message || error) }); }
  }

  /** Tells plugins about something that happened (only those allowed to know). */
  function emit(name, data, permission) {
    for (const { plugin, port } of links.values()) if (allowed(plugin, permission)) port.postMessage({ noai: 1, event: name, data });
  }
  function retheme() { for (const node of [...workers.values(), ...pageFrames.values()]) sendTheme(node); }

  async function run(command, context = {}) {
    const worker = workers.get(command.plugin.id);
    const link = worker && links.get(worker);
    if (!link) { toast(`${command.plugin.name} has no background script to run “${command.title}”.`, 'error'); return; }
    const token = crypto.randomUUID();
    const result = new Promise((resolve, reject) => {
      waiting.set(token, { resolve, reject });
      setTimeout(() => { if (waiting.delete(token)) reject(new Error('The plugin did not answer')); }, 60000);
    });
    link.port.postMessage({ noai: 1, command: command.id, token, context });
    try { await result; } catch (error) { toast(`${command.plugin.name}: ${String(error?.message || error)}`, 'error'); }
  }

  // ---- Settings › Plugins ---------------------------------------------------------
  function renderSettings(container, actions) {
    const { setEnabled, createExample, openFolder, remove } = actions;
    const contributions = plugin => {
      const m = plugin.manifest || {}, parts = [];
      for (const [key, word] of [['pages', 'page'], ['commands', 'command'], ['themes', 'theme'], ['agents', 'agent']]) {
        const count = Array.isArray(m[key]) ? m[key].length : 0;
        if (count) parts.push(`${count} ${word}${count === 1 ? '' : 's'}`);
      }
      if (m.main) parts.push('background script');
      return parts.join(' · ');
    };
    const rows = plugins.map(plugin => {
      const toggle = element('input', 'ui-switch');
      toggle.type = 'checkbox';
      toggle.checked = plugin.enabled;
      toggle.disabled = !native || plugin.problems.length > 0;
      toggle.setAttribute('aria-label', `Turn ${plugin.name} ${plugin.enabled ? 'off' : 'on'}`);
      toggle.addEventListener('change', async () => {
        const on = toggle.checked;
        toggle.disabled = true;
        // Show straight away that something is happening; big plugins take a moment.
        const note = element('span', 'plugin-busy', on ? 'Turning on…' : 'Turning off…');
        note.setAttribute('role', 'status');
        toggle.closest('.ui-row-trailing')?.prepend(note);
        try {
          await setEnabled(plugin.id, on);
          await load();
          renderSettings(container, actions);
          toast(on ? `${plugin.name} is on${contributions(plugin) ? ` · ${contributions(plugin)}` : ''}.` : `${plugin.name} is off.`);
        }
        catch (error) { note.remove(); toggle.checked = !on; toggle.disabled = false; toast(`Could not turn ${plugin.name} ${on ? 'on' : 'off'}: ${String(error)}`, 'error'); }
      });
      // Two taps: deleting removes the plugin's folder for good.
      const del = element('button', 'secondary-button is-compact is-destructive', 'Delete');
      del.type = 'button';
      del.disabled = !native;
      del.setAttribute('aria-label', `Delete ${plugin.name}`);
      del.addEventListener('click', async () => {
        if (!del.classList.contains('is-confirming')) {
          del.classList.add('is-confirming'); del.textContent = 'Confirm delete';
          setTimeout(() => { if (del.isConnected) { del.classList.remove('is-confirming'); del.textContent = 'Delete'; } }, 4000);
          return;
        }
        del.disabled = true;
        try { await remove(plugin.id); await load(); renderSettings(container, actions); toast(`Deleted ${plugin.name}.`); }
        catch (error) { del.disabled = false; toast(String(error), 'error'); }
      });
      const node = uiRow({
        leading: tile(plugin.name.slice(0, 1).toUpperCase(), 'var(--tile-models)'),
        title: `${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}`,
        subtitle: plugin.problems.length ? plugin.problems.join(' ') : [plugin.description, contributions(plugin) || 'Nothing to add yet'].filter(Boolean).join(' · '),
        trailing: plugin.problems.length ? [pill("Can't load", 'bad'), del, toggle] : [del, toggle],
        className: 'plugin-row',
      });
      if (plugin.permissions.length) {
        const list = element('div', 'plugin-permissions');
        list.append(element('span', '', 'Can:'), ...plugin.permissions.map(name => pill(PERMISSION_TEXT[name] || name, name === 'chats:write' || name === 'network' ? 'warn' : 'muted')));
        node.querySelector('.ui-row-copy').append(list);
      }
      return node;
    });
    const list = element('div', 'ui-list');
    if (rows.length) list.append(...rows);
    else list.append(element('p', 'ui-list-empty', native ? 'No plugins yet. Create the example plugin to see how one is put together.' : 'Plugins need the Noai desktop app.'));
    const buttons = element('div', 'plugin-actions');
    const make = (label, action, className = 'secondary-button') => {
      const button = element('button', className, label);
      button.type = 'button';
      button.disabled = !native;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await action(); } catch (error) { toast(String(error), 'error'); }
        finally { button.disabled = false; }
      });
      return button;
    };
    buttons.append(
      make('Open plugins folder', openFolder),
      make('Create example plugin', async () => { await createExample(); await load(); renderSettings(container, actions); toast('Created “Hello Noai”. Turn it on to try it.'); }),
      make('Reload', async () => { await load(); renderSettings(container, actions); }),
    );
    container.replaceChildren(list, buttons);
  }

  return { load, show, title, renderNav, emit, retheme, run, commands: () => commands, renderSettings, current: () => current };
}
