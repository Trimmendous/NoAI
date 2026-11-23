import { element, basename } from './dom.js';
import { summaryCard } from './summary.js';
import { renderMarkdown } from './markdown.js';
import { getHarness } from '../core/catalog.js';
import { normalizeMetrics } from '../core/metrics.js';
import { renderSessionStats } from './session-stats.js';
import { renderItemAnalytics } from './item-analytics.js';
import { agentColor, agentTile, filterTiles, relativeTime, row } from './ui.js';

const $ = selector => document.querySelector(selector);
const date = value => value ? new Date(value * 1000).toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}) : '—';
const PAGE_SIZE = 25;
const compact = value => Intl.NumberFormat(undefined, {notation:'compact', maximumFractionDigits:1}).format(value);
const full = value => value.toLocaleString();
const sum = tokens => tokens ? (tokens.input || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0) + (tokens.output || 0) : 0;

/** All tokens a session used, its subagents included; null when none were recorded. */
export function sessionTokens(session) {
  if (!session.tokens && !session.subagents) return null;
  const own = sum(session.tokens), subagents = sum(session.subagents?.tokens);
  return {own, subagents, subagentCount:session.subagents?.count || 0, total:own+subagents};
}

/** How full the context window was after the latest call, 0–100; null when unknown. */
export function contextPercent(session) {
  const {used, window} = session.context || {};
  return used >= 0 && window > 0 ? Math.min(100, used/window*100) : null;
}

function contextCell(session) {
  const cell = element('span', 'session-context'), percent = contextPercent(session);
  if (percent === null) return null;
  const {used, window} = session.context;
  const meter = element('span', `context-meter${percent >= 80 ? ' is-high' : ''}`), fill = element('span');
  fill.style.width = `${percent}%`; meter.append(fill);
  meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `Context ${percent.toFixed(0)}% full`);
  cell.append(meter, element('span', '', `${percent.toFixed(0)}%`));
  cell.title = `${full(used)} of ${full(window)} tokens in context after the latest call`;
  return cell;
}

function tokensCell(session) {
  const cell = element('span', 'session-tokens'), tokens = sessionTokens(session);
  if (!tokens) return null;
  cell.append(element('strong', '', compact(tokens.total)), document.createTextNode(' tokens'));
  const t = session.tokens || {};
  cell.title = [`Input ${full(t.input || 0)}`, `Cache read ${full(t.cacheRead || 0)}`, `Cache write ${full(t.cacheWrite || 0)}`, `Output ${full(t.output || 0)}`,
    ...(tokens.subagentCount ? [`Subagents ${full(tokens.subagents)}`] : []), `Total ${full(tokens.total)}`].join('\n');
  return cell;
}

export function combineSessions(local, conversations) {
  const ids = new Set(local.map(session => `${session.harness}:${session.sessionId}`));
  return [...local, ...conversations.filter(chat => !chat.resumeId || !ids.has(`${chat.harness}:${chat.resumeId}`)).map(chat => ({
    id:`noai:${chat.id}`, sessionId:chat.resumeId || chat.id, title:chat.title, harness:chat.harness, model:chat.model,
    projectPath:chat.projectPath, startedAt:Date.parse(chat.createdAt)/1000, updatedAt:Date.parse(chat.updatedAt)/1000,
    messageCount:chat.messages.length, conversation:chat, sourcePath:'Saved in Noai',
  }))];
}

export function initSessions({list, detail, getConversations, fetchMetrics, navigate, native}) {
  let sessions = [], page = 0, selected = null, generation = 0, loading = null, listScroll = 0;
  const body = $('#sessions-body'), search = $('#sessions-search'), sort = $('#sessions-sort');
  const modelSelect = $('#sessions-model'), folderSelect = $('#sessions-folder'), periodSelect = $('#sessions-period');
  let agent = '';
  // Sort and filters are remembered on this device.
  const saved = (() => { try { return JSON.parse(localStorage.getItem('noai.sessionsView') || '{}') || {}; } catch { return {}; } })();
  if ([...sort.options].some(option => option.value === saved.sort)) sort.value = saved.sort;
  if ([...periodSelect.options].some(option => option.value === saved.period)) periodSelect.value = saved.period;
  let wantedModel = saved.model || '', wantedFolder = saved.folder || '';
  const remember = () => { try { localStorage.setItem('noai.sessionsView', JSON.stringify({ sort: sort.value, period: periodSelect.value, model: modelSelect.value, folder: folderSelect.value })); } catch { /* not kept */ } };
  /** Fills a filter menu from the sessions on hand, with a count for each choice. */
  function fillOptions(select, allLabel, values, label = value => value) {
    const wanted = select.value || (select === modelSelect ? wantedModel : wantedFolder);
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const options = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    select.replaceChildren(new Option(allLabel, ''), ...options.map(([value, count]) => { const option = new Option(`${label(value)} (${count})`, value); option.title = value; return option; }));
    select.value = counts.has(wanted) ? wanted : '';
  }
  // Filter tiles: all sessions, then one per agent that has any.
  function renderAgentFilter() {
    const counts = new Map();
    for (const session of sessions) if (session.harness) counts.set(session.harness, (counts.get(session.harness) || 0) + 1);
    if (agent && !counts.has(agent)) agent = '';
    const items = [{ id:'', label:'All sessions', count:sessions.length, icon:'chat', color:'var(--tile-sessions)' },
      ...[...counts].sort((a, b) => b[1]-a[1]).map(([id, count]) => ({ id, label:getHarness(id)?.label || id, count, icon:(getHarness(id)?.label || id).slice(0, 1).toUpperCase(), color:agentColor(id), agent:id }))];
    $('#sessions-filters').replaceChildren(filterTiles(items, agent, id => { agent = id; page = 0; render(); }));
  }
  function render() {
    renderAgentFilter();
    const query = search.value.trim().toLowerCase();
    const inAgent = sessions.filter(session => !agent || session.harness === agent);
    fillOptions(modelSelect, 'All models', inAgent.map(session => session.model || ''), value => value || 'Default model');
    fillOptions(folderSelect, 'All folders', inAgent.map(session => session.projectPath || ''), value => value ? basename(value) : 'No folder');
    const days = Number(periodSelect.value) || 0;
    const since = days ? (() => { const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1)); return start.getTime() / 1000; })() : 0;
    const model = modelSelect.value, folder = folderSelect.value;
    const filtered = inAgent.filter(session => (!modelSelect.selectedIndex || (session.model || '') === model)
      && (!folderSelect.selectedIndex || (session.projectPath || '') === folder)
      && (!since || session.updatedAt >= since)
      && (!query || [session.title,session.projectPath,session.model,session.sessionId].some(value => value?.toLowerCase().includes(query))));
    $('#sessions-clear').hidden = !(modelSelect.selectedIndex || folderSelect.selectedIndex || days || query || agent);
    const order = {
      title:(a,b) => a.title.localeCompare(b.title),
      oldest:(a,b) => a.updatedAt-b.updatedAt,
      tokens:(a,b) => (sessionTokens(b)?.total ?? -1)-(sessionTokens(a)?.total ?? -1) || b.updatedAt-a.updatedAt,
      context:(a,b) => (contextPercent(b) ?? -1)-(contextPercent(a) ?? -1) || b.updatedAt-a.updatedAt,
      'fewest-tokens':(a,b) => (sessionTokens(a)?.total ?? Infinity)-(sessionTokens(b)?.total ?? Infinity) || b.updatedAt-a.updatedAt,
      messages:(a,b) => (b.messageCount || 0)-(a.messageCount || 0) || b.updatedAt-a.updatedAt,
      duration:(a,b) => ((b.updatedAt-(b.startedAt || b.updatedAt)) - (a.updatedAt-(a.startedAt || a.updatedAt))) || b.updatedAt-a.updatedAt,
    }[sort.value] || ((a,b) => b.updatedAt-a.updatedAt);
    filtered.sort(order);
    const pages = Math.max(1, Math.ceil(filtered.length/PAGE_SIZE)); page = Math.min(page, pages-1);
    body.replaceChildren();
    for (const session of filtered.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE)) {
      const label = getHarness(session.harness)?.label || session.harness || 'Agent';
      const where = session.projectPath ? basename(session.projectPath) : '';
      const item = row({
        leading: agentTile(session.harness, label),
        title: session.title || 'Untitled session',
        subtitle: [where, session.model || 'Default model', relativeTime(session.updatedAt), session.archived ? 'Archived' : session.conversation ? 'Noai' : ''].filter(Boolean).join(' · '),
        trailing: [contextCell(session), tokensCell(session)],
        onClick: () => void open(session),
      });
      item.classList.add('session-row');
      item.title = `${session.title || 'Untitled session'}\n${session.projectPath || 'No project'} · ${label} · ${session.messageCount} messages\nUpdated ${date(session.updatedAt)}`;
      body.append(item);
    }
    $('#sessions-empty').hidden = filtered.length > 0;
    $('#sessions-count').textContent = `${filtered.length.toLocaleString()} session${filtered.length === 1 ? '' : 's'}`;
    $('#sessions-page').textContent = `${page+1} / ${pages}`;
    $('#sessions-previous').disabled = page === 0;
    $('#sessions-next').disabled = page === pages-1;
  }
  async function refresh() {
    if (loading) return loading;
    $('#sessions-status').textContent = native ? 'Reading local histories…' : 'Local histories are available in the desktop app.';
    $('#sessions-refresh').disabled = true;
    loading = (async () => {
      try {
        const data = await list(); sessions = combineSessions(data.sessions || [], getConversations()); render();
        $('#sessions-status').textContent = data.errors || data.parseErrors ? `${data.errors || 0} unreadable files · ${data.parseErrors || 0} malformed records skipped. Partial histories are shown.` : native ? 'Codex, Claude, and Noai · stored on this computer' : 'Showing saved Noai conversations';
      } catch (error) { $('#sessions-status').textContent = `Could not read sessions: ${String(error)}`; }
      finally { $('#sessions-refresh').disabled = false; loading = null; }
    })();
    return loading;
  }
  async function open(session, push = true) {
    if (!$('#view-sessions').hidden) listScroll = $('.main-content').scrollTop;
    $('#session-conversation').hidden = true;
    $('#session-back').textContent = '← All sessions';
    $('#session-open-conversation').hidden = false;
    selected = session; const request = ++generation;
    if (push) history.pushState({sessionId:session.id}, '', `#session=${encodeURIComponent(session.id)}`);
    navigate('session');
    $('#session-heading').textContent = session.title || 'Untitled session';
    $('#session-agent').textContent = `${getHarness(session.harness)?.label || session.harness} · ${session.model || 'Default model'}`;
    $('#session-project').textContent = session.projectPath || 'No project recorded';
    $('#session-meta').textContent = `Started ${date(session.startedAt)} · Updated ${date(session.updatedAt)}`;
    $('#session-source').textContent = `${session.sessionId}\n${session.sourcePath || ''}`;
    $('#session-original-prompt').hidden=true;$('#session-original-prompt').open=false;
    $('#session-transcript').replaceChildren(); $('#session-statistics').replaceChildren();
    $('#session-summary').replaceChildren(summaryCard(session.projectPath ? [session.projectPath] : [], { refresh: !push }));
    $('#session-load-more').hidden = true; $('#session-detail-status').textContent = 'Opening session…';
    $('.main-content').scrollTop = 0;
    const messages = session.conversation?.messages || [];
    const load = async offset => {
      $('#session-load-more').disabled = true;
      try {
        const data = session.conversation ? {messages:messages.slice(offset,offset+100).map(message => ({role:message.role,text:message.content,at:Date.parse(message.createdAt)/1000})), nextOffset:messages.length>offset+100 ? offset+100 : null, records:offset === 0 && fetchMetrics ? (await fetchMetrics()).records || [] : []} : await detail(session.id, offset);
        if (request !== generation) return;
        if (!offset) {
          const runIds = new Set(messages.map(message => message.runId).filter(Boolean));
          const rows = normalizeMetrics(data.records || []).filter(row => !session.conversation || runIds.has(row.runId) || row.harness === session.harness && row.sessionId === session.sessionId).map(row => ({...row, runId:session.id}));
          const run = {runId:session.id, historyAvailable:false, elapsedLabel:'Session span', startedAt:session.startedAt, finishedAt:session.updatedAt, events:[]};
          renderSessionStats($('#session-statistics'), session, run, rows, 'Recorded usage for this session.');
          renderItemAnalytics($('#session-analytics'), rows, { what: 'this session' });
        }
        if(!offset) {
          const prompt=data.messages.find(message=>message.role==='user'&&message.text);
          $('#session-original-prompt').hidden=!prompt;
          $('#session-original-prompt p').textContent=prompt?.text || '';
        }
        for (const message of data.messages) {
          const article = element('article', `session-message is-${['user','assistant','tool','system','developer'].includes(message.role) ? message.role : 'system'}`);
          const header = element('header'); header.append(element('strong', '', message.role === 'user' ? 'You' : message.role === 'assistant' ? getHarness(session.harness)?.label || 'Assistant' : message.role), element('time', '', date(message.at)));
          const copy=element('button','job-copy','Copy');copy.type='button';
          copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText([message.text,...(message.activities || []).map(item=>item.text)].filter(Boolean).join('\n\n'));copy.textContent='Copied';}catch{copy.textContent='Copy unavailable';}});header.append(copy);
          if (['system','developer','tool','thinking','reasoning'].includes(message.role)) {
            const disclosure = element('details'); disclosure.append(element('summary', '', message.role === 'tool' ? 'Tool activity' : ['thinking','reasoning'].includes(message.role) ? 'Recorded thinking' : 'Session instructions'), element('pre', '', message.text)); article.append(header, disclosure);
          } else article.append(header, message.role === 'user' ? element('div', 'session-message-text', message.text) : renderMarkdown(message.text, 'session-message-text'));
          for(const activity of message.activities || []) {
            const disclosure=element('details');disclosure.append(element('summary','',activity.kind==='thinking'?'Recorded thinking':'Tool activity'),element('pre','',activity.text));article.append(disclosure);
          }
          $('#session-transcript').append(article);
        }
        $('#session-detail-status').textContent = data.parseErrors ? `${data.parseErrors} malformed records skipped; this transcript is partial.` : !offset && !data.messages.length ? 'No readable conversation messages in this history.' : '';
        $('#session-load-more').hidden = data.nextOffset == null;
        $('#session-load-more').onclick = () => void load(data.nextOffset);
      } catch (error) { if (request === generation) $('#session-detail-status').textContent = `Could not open session: ${String(error)}. Use Refresh session to retry.`; }
      finally { if (request === generation) $('#session-load-more').disabled = false; }
    };
    await load(0);
  }
  function back() { if (!$('#session-conversation').hidden) { $('#session-conversation').hidden=true; $('#session-open-conversation').hidden=false; $('#session-back').textContent='← All sessions'; $('.main-content').scrollTop=0; return; } ++generation; history.pushState({}, '', '#sessions'); navigate('sessions'); render(); $('.main-content').scrollTop=listScroll; }
  $('#session-open-conversation').addEventListener('click',()=>{ $('#session-conversation').hidden=false; $('#session-open-conversation').hidden=true; $('#session-back').textContent='← Session overview'; $('#session-conversation').scrollIntoView({block:'start'}); });
  $('#session-back').addEventListener('click', back);
  $('#session-refresh').addEventListener('click', () => { if (selected) void open(selected, false); });
  $('#sessions-refresh').addEventListener('click', () => void refresh());
  search.addEventListener('input', () => { page = 0; render(); });
  sort.addEventListener('change', () => { page = 0; remember(); render(); });
  for (const select of [modelSelect, folderSelect, periodSelect]) select.addEventListener('change', () => {
    wantedModel = modelSelect.value; wantedFolder = folderSelect.value;
    page = 0; remember(); render();
  });
  $('#sessions-clear').addEventListener('click', () => {
    agent = ''; search.value = ''; modelSelect.value = ''; folderSelect.value = ''; periodSelect.value = '';
    wantedModel = ''; wantedFolder = ''; page = 0; remember(); render();
  });
  $('#sessions-previous').addEventListener('click', () => { page--; render(); });
  $('#sessions-next').addEventListener('click', () => { page++; render(); });
  async function route() {
    if (location.hash.startsWith('#session=')) {
      let id; try { id = decodeURIComponent(location.hash.slice(9)); } catch { return; }
      if (!sessions.length) await refresh();
      const session = sessions.find(item => item.id === id);
      if (session) await open(session, false);
      else { navigate('sessions'); $('#sessions-status').textContent = 'That session is no longer available. Refresh to check local histories.'; }
    } else if (location.hash === '#sessions' || selected) { ++generation; navigate('sessions'); }
  }
  window.addEventListener('popstate', () => void route());
  return {refresh, route};
}
