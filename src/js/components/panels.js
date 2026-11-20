import { element, basename, timeLabel } from './dom.js';
import { buildProviderCards } from '../services/providers.js';
import { getHarness } from '../core/catalog.js';
import { countdown } from './jobs.js';

export function renderAccounts(container, runtime, native, snapshots = [], manualPlans = {}, editPlan = () => {}) {
  const fragment = document.createDocumentFragment();
  const intro = element('div', 'notice', native
    ? 'Your existing sign-ins power supported account checks. Each card shows its data source; unavailable quotas are never estimated.'
    : 'Browser preview · Open the Noai desktop app to detect your installed coding agents.');
  fragment.append(intro);
  for (const provider of buildProviderCards(runtime)) {
    const snapshot = snapshots.find(item => item.id === provider.id);
    const card = element('article', 'account-card');
    const header = element('div', 'account-header');
    const name = element('div', 'account-name');
    name.append(element('span', 'provider-mark', provider.label.slice(0, 1)), element('h3', '', provider.label));
    const ready = provider.harness && provider.installed;
    const available = snapshot?.status === 'available';
    header.append(name, element('span', `account-status ${available ? 'is-ready' : ''}`, !native ? 'Desktop required' : available ? 'Connected' : snapshot?.status === 'stale' ? 'Stale data' : snapshot?.status === 'error' ? 'Check connection' : ready ? 'CLI detected' : 'Unavailable'));
    const metrics = element('div', 'account-metrics');
    const manual = manualPlans[provider.id];
    for (const [label, value] of [['Plan', snapshot?.plan || (manual ? `${manual} · user set` : 'Unavailable')], ['Account', snapshot?.accountLabel || 'Not reported']]) {
      const metric = element('div');
      metric.append(element('span', 'metric-label', label), element('span', 'metric-value', value));
      metrics.append(metric);
    }
    card.append(header, metrics);
    for (const window of snapshot?.windows || []) {
      const row = element('div', 'usage-window');
      const rowHeader = element('div', 'usage-window-header');
      rowHeader.append(element('span', '', window.label));
      if (Number.isFinite(window.usedPercent)) {
        const used = Math.max(0, Math.min(100, window.usedPercent));
        rowHeader.append(element('strong', '', `${Math.round(used)}% used`));
        row.append(rowHeader);
        const meter = element('progress', 'usage-meter');
        meter.max = 100;
        meter.value = used;
        meter.setAttribute('aria-label', `${window.label}: ${Math.round(used)}% used`);
        row.append(meter);
      } else {
        rowHeader.append(element('strong', '', Number.isFinite(window.remaining) ? `${window.remaining.toLocaleString()} remaining${window.unit ? ` ${window.unit}` : ''}` : 'Remaining not reported'));
        row.append(rowHeader);
      }
      if (window.resetsAt) row.append(element('span', 'usage-reset', `${countdown(window.resetsAt)} · ${new Date(window.resetsAt * 1000).toLocaleString()}`));
      if (Number.isFinite(window.usedPercent) && Number.isFinite(window.remaining)) row.append(element('span', 'usage-reset', `${window.remaining.toLocaleString()}${window.unit ? ` ${window.unit}` : ''} remaining${Number.isFinite(window.limit) ? ` of ${window.limit.toLocaleString()}` : ''}`));
      card.append(row);
    }
    if (!snapshot?.windows?.length) card.append(element('p', 'usage-empty', 'Remaining quota is unavailable.'));
    card.append(element('p', 'usage-empty', snapshot?.detail || (native ? 'This provider does not expose usage through a connected adapter.' : 'Open the desktop app to check this account.')));
    const footer = element('div', 'account-footer');
    footer.append(element('span', 'source-label', `${snapshot?.source || 'unavailable'}${snapshot?.fetchedAt ? ` · Checked ${timeLabel(snapshot.fetchedAt * 1000)}` : ''}`));
    const planButton = element('button', 'secondary-button plan-button', manual ? 'Edit plan label' : 'Set plan label');
    planButton.type = 'button';
    planButton.addEventListener('click', () => editPlan(provider.id, provider.label));
    footer.append(planButton);
    card.append(footer);
    fragment.append(card);
  }
  container.replaceChildren(fragment);
}

export function renderDetails(container, conversation, workspace, running) {
  const fragment = document.createDocumentFragment();
  const items = [
    ['Project', conversation?.projectPath || workspace.projectPath || 'No folder selected'],
    ['Harness', getHarness(conversation?.harness)?.label || conversation?.harness || '—'],
    ['Model', conversation?.model || 'Harness default'],
    ['Session', conversation?.resumeId ? 'Native session retained' : 'New session'],
    ['Status', running ? 'Working' : 'Ready'],
  ];
  for (const [label, value] of items) {
    const item = element('div', 'detail-item');
    item.append(element('span', 'eyebrow', label), element('p', 'detail-value', value));
    fragment.append(item);
  }
  const note = element('div', 'detail-note');
  note.append(element('h3', '', 'Your work stays local'), element('p', '', 'Conversations are saved on this device. The selected coding agent connects to its own provider.'));
  fragment.append(note);
  const permissions = element('div', 'detail-note');
  permissions.append(element('h3', '', 'Agent permissions'), element('p', '', conversation?.dangerouslyBypassPermissions ? 'Permission bypass is enabled for this conversation. Agent tools may execute without approval.' : 'Normal CLI permissions apply. Claude tools requiring an interactive approval are denied in this build.'));
  fragment.append(permissions);
  const automation = element('div', 'detail-note');
  automation.append(element('h3', '', 'Automatic resume'), element('p', '', workspace.preferences.autoResume ? 'Timed provider limits can pause this task and resume its native session after reset. View waiting tasks in Activity.' : 'Disabled for new requests. You can enable it in Settings.'));
  automation.append(element('p', '', 'The background scheduler runs independently of this window. Use noai service stop to stop the systemd service.'));
  fragment.append(automation);
  container.replaceChildren(fragment);
}

export function renderActivity(container, workspace, liveActivities) {
  const entries = workspace.conversations.flatMap(conversation => conversation.messages.filter(message => message.role === 'user' || message.role === 'system').map(message => ({ id: message.id, text: message.content, at: message.createdAt, title: conversation.title, project: basename(conversation.projectPath) })));
  entries.push(...liveActivities);
  entries.sort((a, b) => b.at.localeCompare(a.at));
  if (!entries.length) {
    const empty = element('div', 'empty-state content-placeholder');
    empty.append(element('span', 'placeholder-symbol', '◇'), element('h3', '', 'Nothing in motion. Yet.'), element('p', '', 'Your prompts and agent activity will appear here.'));
    container.replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(0, 100)) {
    const item = element('article', 'activity-item');
    item.append(element('span', 'activity-dot'), element('div', 'activity-copy'));
    item.lastChild.append(element('h3', '', entry.title || 'Agent activity'), element('p', '', entry.text), element('time', 'activity-time', `${new Date(entry.at).toLocaleDateString()} · ${timeLabel(entry.at)}`));
    fragment.append(item);
  }
  container.replaceChildren(fragment);
}
