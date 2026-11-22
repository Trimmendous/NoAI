import { element, basename } from './dom.js';
import { getHarness } from '../core/catalog.js';

export function renderConversations(container, workspace, query, select, makeDraggable) {
  const conversations = workspace.conversations.filter(item => `${item.title} ${item.projectPath ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!conversations.length) {
    container.replaceChildren(element('p', 'conversation-empty', query ? 'No matching conversations.' : 'A fresh start. Your chats will live here.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  // Grouped by when they were last used, like Notes and Mail.
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const day = 86400000, today = startOfToday.getTime();
  const groupOf = at => at >= today ? 'Today' : at >= today - day ? 'Yesterday' : at >= today - 7 * day ? 'Previous 7 days' : at >= today - 30 * day ? 'Previous 30 days' : 'Earlier';
  let lastGroup = '';
  for (const conversation of conversations) {
    const group = groupOf(Date.parse(conversation.updatedAt) || 0);
    if (group !== lastGroup) { fragment.append(element('p', 'conversation-group', group)); lastGroup = group; }
    const button = element('button', 'conversation-item');
    button.type = 'button';
    button.classList.toggle('is-active', conversation.id === workspace.activeConversationId);
    button.setAttribute('aria-current', conversation.id === workspace.activeConversationId ? 'true' : 'false');
    button.title = conversation.title;
    button.append(element('span', 'conversation-title', conversation.title));
    button.append(element('span', 'conversation-meta', `${getHarness(conversation.harness)?.label} · ${conversation.projectPath ? basename(conversation.projectPath) : 'No project'}`));
    button.addEventListener('click', () => select(conversation.id));
    // Drag a chat onto the chat area to open it in a pane or split beside one.
    makeDraggable?.(button, conversation.id);
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}
