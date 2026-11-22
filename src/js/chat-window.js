// A chat torn off into its own window. It owns nothing: the main Noai
// window sends it the chat (`noai:chat-window-sync`) and does whatever is
// asked here (`noai:chat-window-action`: ready, send, stop, dock).
import { createMessageRenderer } from './components/messages.js';
import { setLinkHandler } from './components/markdown.js';
import { applyTheme } from './core/theme.js';
import { applyAccessibility } from './core/accessibility.js';
import { initMatrixRain } from './components/matrix-rain.js';
import { openWebLink } from './services/bridge.js';

const $ = selector => document.querySelector(selector);
const id = new URLSearchParams(location.search).get('id') || '';
const tauri = window.__TAURI__;
const renderMessages = createMessageRenderer($('#chat-window-messages'));
let chat = null;

const send = (action, extra = {}) => tauri?.event?.emitTo('main', 'noai:chat-window-action', { id, action, ...extra });

function render() {
  document.title = chat ? `${chat.title} · Noai` : 'Noai chat';
  $('#chat-window-title').textContent = chat?.title || 'Chat not found';
  $('#chat-window-meta').textContent = chat ? [chat.agent, chat.model, chat.project].filter(Boolean).join(' · ') : '';
  renderMessages(chat ? { id: chat.id, harness: chat.harness, agentLabel: chat.agent, messages: chat.messages } : null);
  $('#chat-window-stop').hidden = !chat?.running;
  $('#chat-window-send').disabled = !chat || chat.running || !$('#chat-window-input').value.trim();
  $('#chat-window-status').textContent = !chat ? 'This chat is no longer in Noai.' : chat.status;
}

applyTheme();
applyAccessibility();
initMatrixRain($('#matrix-rain'));
setLinkHandler(openWebLink);
// The main window saves appearance changes; follow them here too.
addEventListener('storage', event => {
  if (event.key === 'noai.appearance') applyTheme();
  if (event.key === 'noai.accessibility') applyAccessibility();
});

if (!/^[\w-]{1,64}$/.test(id) || !tauri) {
  render();
} else {
  await tauri.event.listen('noai:chat-window-sync', event => {
    if (event.payload?.id !== id) return;
    chat = event.payload.chat;
    render();
  });
  send('ready');
}

$('#chat-window-input').addEventListener('input', render);
$('#chat-window-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-window-form').requestSubmit(); }
});
$('#chat-window-form').addEventListener('submit', event => {
  event.preventDefault();
  const prompt = $('#chat-window-input').value.trim();
  if (!prompt || !chat || chat.running) return;
  $('#chat-window-input').value = '';
  send('send', { prompt });
  render();
});
$('#chat-window-stop').addEventListener('click', () => send('stop'));
// Dragging the handle over the main window docks the chat where it's dropped;
// a click docks it beside the current chat.
$('#dock-handle').addEventListener('dragstart', event => {
  event.dataTransfer.setData('application/x-noai-chat', id);
  event.dataTransfer.setData('text/plain', `noai-chat:${id}`);
  event.dataTransfer.effectAllowed = 'move';
});
$('#dock-handle').addEventListener('click', () => send('dock'));
