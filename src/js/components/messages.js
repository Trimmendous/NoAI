import { element, timeLabel } from './dom.js';
import { getHarness } from '../core/catalog.js';

// Render only known structure; agent output is never inserted as HTML.
export function renderContent(text) {
  const fragment = document.createDocumentFragment();
  const blocks = text.split(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g);
  for (let index = 0; index < blocks.length; index += 3) {
    if (blocks[index]) fragment.append(element('div', 'message-prose', blocks[index]));
    if (blocks[index + 2] !== undefined) {
      const wrapper = element('div', 'code-block');
      const header = element('div', 'code-header');
      header.append(element('span', '', blocks[index + 1].trim() || 'code'));
      const copy = element('button', 'text-button', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(blocks[index + 2]);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
        } catch { copy.textContent = 'Select to copy'; }
      });
      header.append(copy);
      const pre = element('pre');
      pre.append(element('code', '', blocks[index + 2]));
      wrapper.append(header, pre);
      fragment.append(wrapper);
    }
  }
  return fragment;
}

export function createMessageRenderer(container) {
  const nodes = new Map();
  let conversationId;
  return (conversation) => {
    const changedConversation = conversationId !== conversation?.id;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
    if (changedConversation) {
      container.replaceChildren();
      nodes.clear();
      conversationId = conversation?.id;
    }
    const messages = conversation?.messages ?? [];
    const ids = new Set(messages.map(message => message.id));
    for (const [id, entry] of nodes) {
      if (!ids.has(id)) { entry.node.remove(); nodes.delete(id); }
    }
    for (const message of messages) {
      let entry = nodes.get(message.id);
      if (!entry) {
        const node = element('article', `message role-${message.role}`);
        const header = element('div', 'message-header');
        const name = message.role === 'user' ? 'You' : message.role === 'system' ? 'Noai' : getHarness(conversation.harness)?.label || 'Agent';
        header.append(element('span', 'message-avatar', name.slice(0, 1)), element('strong', '', name));
        const time = element('time', '', timeLabel(message.createdAt));
        time.dateTime = message.createdAt;
        header.append(time);
        const content = element('div', 'message-content');
        const status = element('span', 'message-status');
        node.append(header, content, status);
        entry = { node, content, status };
        nodes.set(message.id, entry);
        container.append(node);
      }
      const displayText = message.content || (message.status === 'streaming' ? 'Thinking…' : '');
      if (entry.text !== displayText) {
        entry.content.replaceChildren(renderContent(displayText));
        entry.text = displayText;
      }
      entry.status.textContent = message.status === 'waiting' ? 'Waiting for quota — automatic resume scheduled.' : message.status === 'streaming' ? 'Working' : message.status === 'interrupted' ? 'Interrupted — send a follow-up to continue.' : message.status === 'error' ? 'Run ended with an error. Check Activity for recovery details.' : '';
      entry.node.classList.toggle('is-streaming', message.status === 'streaming');
    }
    if (nearBottom || changedConversation) container.scrollTop = container.scrollHeight;
  };
}
