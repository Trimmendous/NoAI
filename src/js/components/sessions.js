import { element, basename } from './dom.js';
import { HARNESSES, getHarness } from '../core/catalog.js';
import { normalizeMetrics } from '../core/metrics.js';
import { renderSessionStats } from './session-stats.js';

const $ = selector => document.querySelector(selector);
const date = value => value ? new Date(value * 1000).toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}) : '—';
const PAGE_SIZE = 25;

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
  const body = $('#sessions-body'), search = $('#sessions-search'), harness = $('#sessions-harness'), sort = $('#sessions-sort');
  function renderHarnessFilter() {
    const ids = [...new Set([...HARNESSES.map(item => item.id), ...sessions.map(session => session.harness).filter(Boolean)])];
    const signature = ids.join('|');
    if (harness.dataset.signature === signature) return;
    const selected = harness.value;
    harness.replaceChildren(new Option('All agents', ''), ...ids.map(id => new Option(getHarness(id)?.label || id, id)));
    harness.value = ids.includes(selected) ? selected : '';
    harness.dataset.signature = signature;
  }
  function render() {
    renderHarnessFilter();
    const query = search.value.trim().toLowerCase();
    const filtered = sessions.filter(session => (!harness.value || session.harness === harness.value) && (!query || [session.title,session.projectPath,session.model,session.sessionId].some(value => value?.toLowerCase().includes(query))));
    filtered.sort((a,b) => sort.value === 'title' ? a.title.localeCompare(b.title) : sort.value === 'oldest' ? a.updatedAt-b.updatedAt : b.updatedAt-a.updatedAt);
    const pages = Math.max(1, Math.ceil(filtered.length/PAGE_SIZE)); page = Math.min(page, pages-1);
    body.replaceChildren();
    for (const session of filtered.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE)) {
      const row = element('tr');
      const title = element('td'), link = element('a', 'session-title-link', session.title || 'Untitled session');
      link.href = `#session=${encodeURIComponent(session.id)}`;
      link.addEventListener('click', event => { event.preventDefault(); void open(session); });
      title.append(link, element('small', '', session.archived ? 'Archived' : session.conversation ? 'Noai' : session.sessionId));
      const project = element('td', 'session-project', session.projectPath ? basename(session.projectPath) : '—'); project.title = session.projectPath || '';
      const agent = element('td'); agent.append(element('span', '', getHarness(session.harness)?.label || session.harness), element('small', '', session.model || 'Default model'));
      row.append(title, project, agent, element('td', 'session-count', String(session.messageCount)), element('td', 'session-date', date(session.updatedAt)));
      row.addEventListener('click', event => { if (!event.target.closest('a') && !window.getSelection()?.toString()) void open(session); });
      body.append(row);
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
          } else article.append(header, element('div', 'session-message-text', message.text));
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
  for (const node of [harness, sort]) node.addEventListener('change', () => { page = 0; render(); });
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
