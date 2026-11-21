import { element, basename, timeLabel } from './dom.js';
import { buildProviderCards } from '../services/providers.js';
import { getHarness } from '../core/catalog.js';
import { countdown } from './jobs.js';
import { agentTile, group, pill, ring, row, tile } from './ui.js';

/** "Resets in 2h 5m" when soon, otherwise "Resets Tue 9:00 PM". */
function resetLabel(at) {
  if (at * 1000 - Date.now() > 36 * 3600000) return `Resets ${new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  return `Resets ${countdown(at).replace(/^In /, 'in ')}`;
}

// Connected agents get a panel with Activity-style rings for each usage window;
// everything else is one compact row in a grouped list.
export function renderAccounts(container, runtime, native, snapshots = [], manualPlans = {}, editPlan = () => {}) {
  const fragment = document.createDocumentFragment();
  const panels = element('div', 'account-panels');
  const others = [];
  for (const provider of buildProviderCards(runtime)) {
    const snapshot = snapshots.find(item => item.id === provider.id);
    const ready = provider.harness && provider.installed;
    const available = snapshot?.status === 'available';
    const manual = manualPlans[provider.id];
    const plan = snapshot?.plan || (manual ? `${manual} · user set` : '');
    const status = !native ? ['Desktop required', 'muted'] : available ? ['Connected', 'good'] : snapshot?.status === 'stale' ? ['Stale data', 'warn'] : snapshot?.status === 'error' ? ['Check connection', 'bad'] : ready ? ['CLI detected', 'accent'] : ['Not connected', 'muted'];
    const planButton = element('button', 'text-button plan-button', manual ? 'Edit plan label' : 'Set plan label');
    planButton.type = 'button';
    planButton.addEventListener('click', () => editPlan(provider.id, provider.label));
    if (!available && !snapshot?.windows?.length) {
      const item = row({ leading: agentTile(provider.id, provider.label), title: provider.label, subtitle: plan || snapshot?.detail || (native ? (ready ? 'Installed · usage not reported by this agent' : 'Not installed on this computer') : 'Open the desktop app to check this account'), trailing: [pill(status[0], status[1]), planButton] });
      item.classList.add('account-card');
      others.push(item);
      continue;
    }
    const card = element('article', 'account-card account-panel');
    const header = element('div', 'account-panel-header');
    const name = element('div', 'account-panel-name');
    name.append(element('h3', '', provider.label), element('p', '', [snapshot?.accountLabel, plan].filter(Boolean).join(' · ') || 'Account not reported'));
    header.append(agentTile(provider.id, provider.label, 'is-large'), name, pill(status[0], status[1]));
    card.append(header);
    const gauges = element('div', 'account-gauges');
    for (const window of snapshot?.windows || []) {
      const gauge = element('div', 'account-gauge');
      const copy = element('div', 'account-gauge-copy');
      if (Number.isFinite(window.usedPercent)) {
        const used = Math.max(0, Math.min(100, window.usedPercent));
        gauge.append(ring(100 - used, { remaining: true, label: `${window.label}: ${Math.round(used)}% used` }));
        copy.append(element('strong', '', window.label), element('span', '', `${Math.round(used)}% used`));
      } else {
        copy.append(element('strong', '', window.label), element('span', '', Number.isFinite(window.remaining) ? `${window.remaining.toLocaleString()}${window.unit ? ` ${window.unit}` : ''} left` : 'Remaining not reported'));
      }
      if (window.resetsAt) copy.append(element('small', '', resetLabel(window.resetsAt)));
      if (Number.isFinite(window.usedPercent) && Number.isFinite(window.remaining)) copy.append(element('small', '', `${window.remaining.toLocaleString()}${window.unit ? ` ${window.unit}` : ''} left${Number.isFinite(window.limit) ? ` of ${window.limit.toLocaleString()}` : ''}`));
      gauge.title = window.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : '';
      gauge.append(copy);
      gauges.append(gauge);
    }
    if (!gauges.childElementCount) gauges.append(element('p', 'usage-empty', 'Remaining quota is unavailable.'));
    card.append(gauges);
    const footer = element('div', 'account-footer');
    footer.append(element('span', 'source-label', `${snapshot?.detail ? `${snapshot.detail} · ` : ''}${snapshot?.source === 'provider' ? 'From the provider' : snapshot?.source || 'Unavailable'}${snapshot?.fetchedAt ? ` · checked ${timeLabel(snapshot.fetchedAt * 1000)}` : ''}`), planButton);
    card.append(footer);
    panels.append(card);
  }
  if (panels.childElementCount) fragment.append(panels);
  if (others.length) fragment.append(group(panels.childElementCount ? 'Other agents and services' : 'Agents and services', others));
  fragment.append(element('p', 'ui-footnote', native
    ? 'Noai reuses each CLI’s own sign-in. Quotas that a provider doesn’t report are never estimated.'
    : 'Browser preview · Open the Noai desktop app to detect your installed coding agents.'));
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
  const entries = workspace.conversations.flatMap(conversation => conversation.messages.filter(message => message.role === 'user' || message.role === 'system').map(message => ({ id: message.id, text: message.content, at: message.createdAt, title: conversation.title, project: basename(conversation.projectPath), harness: conversation.harness, role: message.role })));
  entries.push(...liveActivities);
  entries.sort((a, b) => b.at.localeCompare(a.at));
  if (!entries.length) {
    const empty = element('div', 'scheduled-empty-state');
    empty.append(tile('chat', 'var(--tile-activity)', 'is-large'), element('h3', '', 'Nothing in motion yet'), element('p', '', 'Your prompts and agent activity will show up here.'));
    container.replaceChildren(empty);
    return;
  }
  // Group by day, newest first, like Notification Center.
  const days = new Map();
  for (const entry of entries.slice(0, 100)) {
    const date = new Date(entry.at);
    const today = new Date(); const yesterday = new Date(Date.now() - 86400000);
    const key = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!days.has(key)) days.set(key, []);
    const label = getHarness(entry.harness)?.label;
    const item = row({ leading: entry.role === 'system' ? tile('alert', 'var(--tile-settings)') : label ? agentTile(entry.harness, label) : tile('chat', 'var(--tile-activity)'), title: entry.title || 'Agent activity', subtitle: entry.text || '', trailing: [timeLabel(entry.at)] });
    item.classList.add('activity-row');
    days.get(key).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const [day, rows] of days) fragment.append(group(day, rows));
  container.replaceChildren(fragment);
}
