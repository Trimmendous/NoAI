import { test } from 'node:test';
import assert from 'node:assert/strict';

// A tiny fake DOM: just enough for plugins/host.js to create frames.
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.parent = null; }
  set className(value) { this.attrs.class = value; }
  set textContent(value) { this.text = value; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = undefined; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({}); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
      // A live iframe has a window once it is in the page.
      if (node.tag === 'iframe') node.contentWindow = fakeWindow(node);
    }
  }
  replaceWith(node) { const list = this.parent.children; list[list.indexOf(this)] = node; node.parent = this.parent; node.contentWindow = fakeWindow(node); this.contentWindow = null; this.parent = null; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const sent = []; // { frame, data, ports } posted to frames by the host
function fakeWindow(frame) { return { postMessage(data, _origin, ports = []) { sent.push({ frame, data, ports }); } }; }

const windowListeners = [];
globalThis.document = { createElement: tag => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag), documentElement: { dataset: {} } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.addEventListener = (type, fn) => { if (type === 'message') windowListeners.push(fn); };
const hello = (source, loaded = false) => { for (const fn of windowListeners) fn({ source, data: { noai: 1, hello: true, loaded } }); };

const { initPluginHost } = await import('../src/js/plugins/host.js');

function call(port, method) {
  return new Promise(resolve => {
    const id = Math.random();
    const timer = setTimeout(() => resolve('no answer'), 200);
    port.addEventListener('message', event => { if (event.data.id === id) { clearTimeout(timer); resolve(event.data.result ?? event.data.error); } });
    port.start();
    port.postMessage({ noai: 1, id, method, params: {} });
  });
}

test('a plugin frame gets one API port, and loses it when the frame leaves its page', async () => {
  const workersEl = new FakeNode('div');
  const toasts = [];
  const host = initPluginHost({
    native: true, platform: () => 'macos', navEl: new FakeNode('nav'), viewEl: new FakeNode('div'), workersEl,
    setView() {}, getView: () => 'chat', toast: text => toasts.push(text), onThemes() {},
    api: {
      list: async () => [{ id: 'demo', name: 'Demo', enabled: true, permissions: [], problems: [], manifest: { main: 'main.js' } }],
      appInfo: async () => 'info',
    },
  });
  await host.load();
  const first = workersEl.children[0];
  assert.equal(first.src, 'noaiplugin://localhost/demo/__main.html');

  // Nothing is sent to a frame before its page says hello.
  assert.equal(sent.length, 0);
  hello(first.contentWindow);
  const offer = sent.find(item => item.data.connect);
  assert.ok(offer && offer.ports.length === 1 && offer.frame === first);
  const port = offer.ports[0];
  assert.equal(await call(port, 'app.info'), 'info');

  // A second hello from the same frame gets nothing new.
  hello(first.contentWindow);
  assert.equal(sent.filter(item => item.data.connect).length, 1);

  // Its own page's load is fine; the next load is another page.
  first.fire('load');
  assert.equal(await call(port, 'app.info'), 'info');
  first.fire('load');
  assert.equal(await call(port, 'app.info'), 'no answer', 'the old port must be closed');
  assert.match(toasts.at(-1), /another page/);

  // The frame was swapped for a fresh one; the old window can't reconnect.
  const fresh = workersEl.children[0];
  assert.notEqual(fresh, first);
  hello(first.contentWindow);
  hello({ postMessage() {} });
  assert.equal(sent.filter(item => item.data.connect).length, 1);
  hello(fresh.contentWindow, true);
  const again = sent.filter(item => item.data.connect);
  assert.equal(again.length, 2);
  assert.equal(await call(again[1].ports[0], 'app.info'), 'info');

  // An already-loaded page has no own load left: its next load is a navigation.
  fresh.fire('load');
  assert.equal(await call(again[1].ports[0], 'app.info'), 'no answer');
  for (const item of sent) for (const p of item.ports) p.close();
});
