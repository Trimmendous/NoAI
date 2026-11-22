// Noai plugin SDK. Plugin pages load it with <script src="../_sdk/noai.js">.
// Pages run in a sandbox with no access to Noai's data except through
// these calls, and only for the permissions listed in plugin.json.
(() => {
  const pending = new Map(), listeners = new Map(), commands = new Map();
  let next = 1;
  // Noai hands this page a private port once it has loaded (see plugins/host.js).
  // Calls made before then wait in `queue`.
  let port = null;
  const queue = [];
  const post = message => {
    const data = { noai: 1, ...message };
    if (port) port.postMessage(data); else queue.push(data);
  };

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`Noai didn't answer ${method}`)); }, 30000);
    });
  }

  // Noai's current colours, as --noai-* variables, so pages can match the app.
  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    root.dataset.theme = theme.dark ? 'dark' : 'light';
    for (const [name, value] of Object.entries(theme.vars || {})) root.style.setProperty(`--noai-${name.replace(/^--/, '')}`, value);
  }

  addEventListener('message', event => {
    if (port || event.source !== parent || event.data?.noai !== 1 || !event.data.connect || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = message => receive(message.data);
    for (const data of queue.splice(0)) port.postMessage(data);
  });

  function receive(message) {
    if (!message || message.noai !== 1) return;
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    } else if (message.theme) applyTheme(message.theme);
    else if (message.event) {
      for (const listener of listeners.get(message.event) || []) {
        try { listener(message.data); } catch (error) { console.error(error); }
      }
    } else if (message.command) {
      const handler = commands.get(message.command);
      Promise.resolve(handler ? handler(message.context || {}) : Promise.reject(new Error(`No handler for ${message.command}`)))
        .then(result => post({ commandDone: message.token, result: result ?? null }))
        .catch(error => post({ commandDone: message.token, error: String(error?.message || error) }));
    }
  }

  window.noai = Object.freeze({
    call,
    /** Events: "chat.finished" { chatId, error }, "job.finished" { jobId, title, status }. */
    on(event, listener) { listeners.set(event, [...(listeners.get(event) || []), listener]); },
    /** Handles a command declared in plugin.json. Return a value or a promise. */
    onCommand(id, handler) { commands.set(id, handler); },
    app: { info: () => call('app.info') },
    chats: {
      list: () => call('chats.list'),
      get: id => call('chats.get', { id }),
      open: id => call('chats.open', { id }),
      /** Needs "chats:write". Starts the agent: { prompt, chatId? , harness?, model? }. */
      send: options => call('chats.send', options),
    },
    jobs: { list: () => call('jobs.list'), runs: id => call('jobs.runs', { id }) },
    metrics: { summary: (range = '7d') => call('metrics.summary', { range }) },
    notify: (text, tone = 'info') => call('notify', { text, tone }),
    /** Small key/value storage kept by Noai for this plugin. */
    storage: { get: key => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }) },
  });
  // Ask for the port. `loaded` tells Noai whether this page's load event has already fired.
  parent.postMessage({ noai: 1, hello: true, loaded: document.readyState === 'complete' }, '*');
})();
