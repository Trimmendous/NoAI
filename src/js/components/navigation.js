import { element, basename } from './dom.js';
import { getHarness } from '../core/catalog.js';

export function renderConversations(container, workspace, query, select) {
  const conversations = workspace.conversations.filter(item => `${item.title} ${item.projectPath ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!conversations.length) {
    container.replaceChildren(element('p', 'conversation-empty', query ? 'No matching conversations.' : 'A fresh start. Your chats will live here.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const conversation of conversations) {
    const button = element('button', 'conversation-item');
    button.type = 'button';
    button.classList.toggle('is-active', conversation.id === workspace.activeConversationId);
    button.setAttribute('aria-current', conversation.id === workspace.activeConversationId ? 'true' : 'false');
    button.title = conversation.title;
    button.append(element('span', 'conversation-title', conversation.title));
    button.append(element('span', 'conversation-meta', `${getHarness(conversation.harness)?.label} · ${conversation.projectPath ? basename(conversation.projectPath) : 'No project'}`));
    button.addEventListener('click', () => select(conversation.id));
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}
