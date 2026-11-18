// Optional development check: NOAI_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.NOAI_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const url = process.env.NOAI_TEST_URL || 'http://127.0.0.1:1420';
await mkdir('/tmp/noai-check', { recursive: true });
try {
  await page.goto(url);
  await page.locator('button[data-view="chat"]').click();
  await page.locator('#runtime-label').filter({ hasText: 'Desktop preview' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('[data-prompt]').first().click();
  assert.match(await page.locator('#prompt-input').inputValue(), /understand/);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  await page.locator('#open-settings').click();
  await page.locator('input[name="palette"][value="blue"]').check();
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'blue');
  await page.locator('input[name="theme"][value="dark"]').check();
  await page.locator('#settings-close').click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()), '#0e0e0f');
  await page.screenshot({ path: '/tmp/noai-check/dark.png', fullPage: true });
  await page.waitForTimeout(350);
  await page.reload();
  await page.locator('#runtime-label').filter({ hasText: 'Desktop preview' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'blue');
  await page.locator('#theme-toggle').click();
  await page.locator('#open-settings').click();
  await page.locator('input[name="palette"][value="sage"]').check();
  await page.locator('#settings-close').click();
  await page.screenshot({ path: '/tmp/noai-check/light.png', fullPage: true });
  await page.locator('button[data-view="accounts"]').click();
  assert.equal(await page.locator('.account-card').count(), 6);
  assert.match(await page.locator('#account-list').innerText(), /unavailable|Unavailable/);
  await page.locator('button[data-view="chat"]').click();
  await page.locator('#model-select').selectOption('__custom__');
  await page.locator('#custom-model-input').fill('my-supported-model');
  await page.locator('#model-save').click();
  assert.equal(await page.locator('#model-select').inputValue(), 'my-supported-model');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-action="toggle-sidebar"]').click();
  await page.locator('button[data-view="activity"]').click();
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('sidebar-open')), false);
  await page.screenshot({ path: '/tmp/noai-check/mobile.png', fullPage: true });

  const native = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await native.addInitScript(() => {
    const events = new Map();
    window.testRequests = [];
    window.testTasks = JSON.parse(localStorage.getItem('test.tasks') || '[]');
    window.testSaveTasks = () => localStorage.setItem('test.tasks', JSON.stringify(window.testTasks));
    window.testJobs = JSON.parse(localStorage.getItem('test.jobs') || '[]');
    window.testSaveJobs = () => localStorage.setItem('test.jobs', JSON.stringify(window.testJobs));
    window.testEmit = event => events.get('noai:run')?.({ payload: event });
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        if (command === 'list_local_sessions') return {sessions:Array.from({length:28}, (_, i) => ({id:`local-${i}`,sessionId:`provider-${i}`,title:i === 0 ? 'Design the garden tracker' : `Local session ${i}`,harness:i % 2 ? 'claude' : 'codex',model:i % 2 ? 'claude-model' : 'codex-model',projectPath:'/home/fixture/garden',messageCount:102,startedAt:1800000000,updatedAt:1800000000-i,sourcePath:`/history/session-${i}.jsonl`,archived:i===2}))};
        if (command === 'get_local_session') return {messages:args.offset ? [{role:'assistant',text:'Final page',at:1800000010}] : [{role:'user',text:'Build a garden tracker <script>unsafe()</script>',at:1800000000},{role:'assistant',text:'Here is the plan.',at:1800000001}],nextOffset:args.offset ? null : 100,records:[{id:'session-usage',runId:'local:codex:provider-0',sessionId:'provider-0',harness:'codex',model:'codex-model',at:1800000000,type:'usage',usage:{kind:'tokens',scope:'turn',inputTokens:120,outputTokens:40,cacheReadTokens:30}}]};
        if (command === 'runtime_status') return { platform: 'linux', harnesses: [{ id: 'codex', installed: true, version: 'fixture' }, { id: 'claude', installed: true }] };
        if (command === 'load_workspace') return JSON.parse(localStorage.getItem('test.workspace') || 'null');
        if (command === 'save_workspace') { localStorage.setItem('test.workspace', JSON.stringify(args.workspace)); return; }
        if (command === 'ensure_project') return args.projectPath || `/home/fixture/.noai/${crypto.randomUUID()}`;
        if (command === 'list_scheduled_tasks') return structuredClone(window.testTasks);
        if (command === 'create_scheduled_task') {
          const task = { ...args.input, id: crypto.randomUUID(), status: 'scheduled', nextRunAt: args.input.startAt, createdAt: Date.now() / 1000 };
          window.testTasks.push(task); window.testSaveTasks(); return task;
        }
        if (command === 'edit_scheduled_task') {
          const task = window.testTasks.find(task => task.id === args.id);
          if (task.status !== 'scheduled' || (task.lastRunId || null) !== args.expectedLastRunId) throw new Error('This job has already started or changed.');
          Object.assign(task, args.input, {nextRunAt:args.input.startAt}); window.testSaveTasks(); return task;
        }
        if (command === 'retry_scheduled_task') {
          const task = window.testTasks.find(task => task.id === args.id);
          if (!['needs_attention','failed','paused','cancelled'].includes(task.status) || (task.lastRunId || null) !== args.expectedLastRunId) throw new Error('Job changed');
          Object.assign(task,{status:'scheduled',nextRunAt:args.startAt,pendingResumeId:'fixture-session'});
          window.testSaveTasks(); return structuredClone(task);
        }
        if (command === 'cancel_scheduled_task') {
          window.testTasks.find(task => task.id === args.id).status = 'cancelled'; window.testSaveTasks(); return;
        }
        if (command === 'get_scheduled_task_runs') return window.testTaskRuns?.[args.id] || [{ runId: 'fixture-run', status: 'completed', startedAt: 2000000000, result: 'Completed', events: [{ type:'text', text:'Job output <script>safe</script>' }] }];
        if (command === 'choose_project') return '/tmp/noai-fixture';
        if (command === 'set_background_mode' || command === 'connect_events') return;
        if (command === 'get_active_runs') return [];
        if (command === 'get_activity_metrics') return {records:[
          {id:1,at:Date.now()/1000-1800,runId:'metrics-a',type:'usage',harness:'codex',model:'fixture-model',usage:{kind:'tokens',scope:'turn',inputTokens:100,outputTokens:30,cacheReadTokens:20}},
          {id:2,at:Date.now()/1000-1700,runId:'metrics-a',type:'activity',harness:'codex',model:'fixture-model',tool:'command_execution'},
          {id:3,at:Date.now()/1000-1600,runId:'metrics-b',type:'usage',harness:'claude',model:'claude-fixture',usage:{kind:'tokens',scope:'turn',inputTokens:200,outputTokens:40}},
          {id:4,at:Date.now()/1000-1500,runId:'metrics-b',type:'activity',harness:'claude',model:'claude-fixture',tool:'Read'}
        ]};
        if (command === 'get_harness_models') return [{ id: 'fixture-model', label: 'Fixture model' }];
        if (command === 'get_provider_usage') return [{ id: 'codex', label: 'Codex', accountLabel: 'Fixture account', plan: 'Fixture plan', source: 'provider', status: 'available', fetchedAt: 1000, windows: [{ label: 'Session', usedPercent: 42, resetsAt: 2100000000 }] }];
        if (command === 'get_resume_jobs') return structuredClone(window.testJobs);
        if (command === 'cancel_resume_job') {
          const job = window.testJobs.find(job => job.id === args.jobId);
          job.status = 'cancelled';
          const event = { eventId: job.events.length + 1, type: 'done', text: 'Cancelled' };
          job.events.push(event);
          window.testSaveJobs();
          window.testEmit({ ...event, runId: job.runId, conversationId: job.conversationId });
          return;
        }
        if (command === 'start_run') { window.testRequests.push(args.request); return; }
        if (command === 'cancel_run') { const req = window.testRequests.at(-1); window.testEmit({ ...req, type: 'done', text: 'Cancelled' }); return; }
        throw new Error(`Unexpected command: ${command}`);
      } },
      event: { listen: async (name, callback) => { events.set(name, callback); return () => events.delete(name); } },
    };
  });
  const chat = await native.newPage();
  chat.on('pageerror', error => errors.push(error.message));
  await chat.goto(url);
  await chat.locator('button[data-view="chat"]').click();
  await chat.locator('#runtime-label').filter({ hasText: '2 local agents available' }).waitFor();
  assert.equal(await chat.locator('#chat-bypass-permissions').isChecked(), false);
  await chat.locator('#chat-bypass-permissions').check();
  await chat.locator('#prompt-input').fill('Explain this project');
  await chat.locator('#send-button').click();
  await chat.waitForFunction(() => window.testRequests.length === 1);
  assert.match(await chat.evaluate(() => window.testRequests[0].projectPath), /^\/home\/fixture\/.noai\/[0-9a-f-]{36}$/);
  assert.equal(await chat.evaluate(() => window.testRequests[0].dangerouslyBypassPermissions), true);
  assert.equal(await chat.locator('#chat-bypass-permissions').isDisabled(), true);
  await chat.evaluate(() => {
    const req = window.testRequests[0];
    window.testEmit({ ...req, type: 'session', resumeId: 'native-session-1' });
    window.testEmit({ ...req, type: 'text', text: 'A useful answer.\n```js\nconst x = "<script>alert(1)</script>";\n```' });
    window.testEmit({ ...req, type: 'done' });
  });
  await chat.locator('.message.role-assistant').filter({ hasText: 'A useful answer' }).waitFor();
  assert.equal(await chat.locator('.message-content script').count(), 0);
  await chat.locator('#prompt-input').fill('Continue');
  await chat.locator('#send-button').click();
  await chat.waitForFunction(() => window.testRequests.length === 2);
  assert.equal(await chat.evaluate(() => window.testRequests[1].resumeId), 'native-session-1');
  await chat.locator('#stop-button').click();
  await chat.locator('#stop-button').waitFor({ state: 'hidden' });
  await chat.locator('#prompt-input').fill('An unsent draft');
  await chat.waitForTimeout(350);
  await chat.reload();
  await chat.locator('button[data-view="chat"]').click();
  await chat.locator('#runtime-label').filter({ hasText: '2 local agents available' }).waitFor();
  assert.equal(await chat.locator('#prompt-input').inputValue(), 'An unsent draft');
  await chat.locator('#rename-chat').click();
  await chat.locator('#edit-input').fill('My saved conversation');
  await chat.locator('#edit-confirm').click();
  assert.equal(await chat.locator('#main-title').innerText(), 'My saved conversation');
  await chat.locator('#harness-select').selectOption('claude');
  assert.equal(await chat.locator('#main-title').innerText(), 'New chat');
  assert.equal(await chat.locator('#harness-select').inputValue(), 'claude');
  assert.equal(await chat.locator('#chat-bypass-permissions').isChecked(), false);
  assert.match(await chat.locator('#chat-bypass-description').innerText(), /Claude/);
  assert.equal(await chat.locator('#prompt-input').inputValue(), '');
  await chat.locator('.conversation-item').first().click();
  assert.equal(await chat.locator('#prompt-input').inputValue(), 'An unsent draft');
  await chat.locator('#prompt-input').fill('Wait through a timed limit');
  await chat.locator('#send-button').click();
  await chat.waitForFunction(() => window.testRequests.length === 1);
  await chat.evaluate(() => {
    const req = window.testRequests[0];
    const events = [
      { eventId: 1, type: 'session', resumeId: 'native-session-1' },
      { eventId: 2, type: 'text', text: 'Before the limit.' },
      { eventId: 3, type: 'waiting', retryAt: 2100000000, text: 'Timed quota reached.' },
    ];
    window.testJobs = [{ id: req.runId, runId: req.runId, conversationId: req.conversationId, harness: req.harness, status: 'waiting', reason: 'Timed quota reached.', retryAt: 2100000000, attempts: 0, events }];
    window.testSaveJobs();
    for (const event of events) window.testEmit({ ...req, ...event });
  });
  await chat.locator('#stop-button').filter({ hasText: 'Cancel resume' }).waitFor();
  await chat.waitForTimeout(350);
  await chat.reload();
  await chat.locator('button[data-view="chat"]').click();
  await chat.locator('#stop-button').filter({ hasText: 'Cancel resume' }).waitFor();
  assert.equal(await chat.locator('#send-button').isDisabled(), true);
  await chat.locator('button[data-view="activity"]').click();
  assert.equal(await chat.locator('.resume-card').count(), 1);
  await chat.evaluate(() => {
    const job = window.testJobs[0];
    job.status = 'completed';
    job.events.push({ eventId: 4, type: 'resumed' }, { eventId: 5, type: 'text', text: 'After the reset.' }, { eventId: 6, type: 'done' });
    window.testSaveJobs();
  });
  await chat.reload();
  await chat.locator('button[data-view="chat"]').click();
  await chat.locator('.message.role-assistant').filter({ hasText: 'After the reset.' }).waitFor();
  const replayed = await chat.locator('.message.role-assistant').last().innerText();
  assert.equal(replayed.match(/Before the limit\./g)?.length, 1);
  assert.equal(replayed.match(/After the reset\./g)?.length, 1);
  assert.equal(await chat.locator('#stop-button').isVisible(), false);
  await chat.locator('button[data-view="accounts"]').click();
  await chat.locator('.account-card').filter({ hasText: 'Fixture plan' }).waitFor();
  assert.equal(await chat.locator('.usage-meter').getAttribute('value'), '42');
  await chat.locator('.account-card').filter({ hasText: 'Cursor' }).locator('.plan-button').click();
  await chat.locator('#edit-input').fill('My plan');
  await chat.locator('#edit-confirm').click();
  await chat.locator('.account-card').filter({ hasText: 'My plan · user set' }).waitFor();
  await chat.locator('button[data-view="chat"]').click();
  await chat.screenshot({ path: '/tmp/noai-check/conversation.png', fullPage: true });
  await chat.locator('#delete-chat').click();
  await chat.locator('#edit-confirm').click();
  assert.equal(await chat.locator('.conversation-item').count(), 0);
  await chat.locator('button[data-view="jobs"]').click();
  assert.equal(await chat.locator('#scheduled-permissions').inputValue(), 'workspace-network');
  await chat.locator('#scheduled-title-input').fill('Recurring review');
  assert.equal(await chat.locator('#scheduled-bypass-permissions').isChecked(), false);
  await chat.locator('#scheduled-bypass-permissions').check();
  await chat.locator('#scheduled-prompt').fill('Review changes and report findings');
  await chat.locator('input[name="scheduled-repeat"][value="interval"]').check();
  await chat.locator('#scheduled-interval').fill('2');
  await chat.locator('#scheduled-interval-unit').selectOption('3600');
  await chat.locator('#scheduled-submit').click();
  await chat.getByRole('region', {name:'Recurring jobs', exact:true}).locator('.scheduled-card').filter({hasText:'Recurring review'}).waitFor();
  let task = await chat.evaluate(() => window.testTasks[0]);
  assert.equal(task.intervalSeconds, 7200);
  assert.equal(task.dangerouslyBypassPermissions, true);
  assert.equal(task.permissions, 'workspace-network');
  assert.equal(await chat.locator('#scheduled-bypass-permissions').isChecked(), false);
  assert.equal(task.autoResume, true);
  assert.match(task.projectPath, /^\/home\/fixture\/.noai\/[0-9a-f-]{36}$/);
  await chat.locator('#scheduled-permissions').selectOption('workspace-write');
  await chat.locator('#scheduled-title-input').fill('Tomorrow one time');
  await chat.locator('#scheduled-prompt').fill('Run a one-time check');
  await chat.locator('input[name="scheduled-start"][value="later"]').check();
  const localTime = await chat.evaluate(() => {
    const date = new Date(Date.now() + 86400000);
    return new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  });
  await chat.locator('#scheduled-time').fill(localTime);
  await chat.locator('#scheduled-project').fill('/tmp/explicit-job-project');
  await chat.locator('#scheduled-submit').click();
  await chat.locator('.scheduled-card').filter({hasText:'Tomorrow one time'}).waitFor();
  task = await chat.evaluate(() => window.testTasks[1]);
  assert.equal(task.intervalSeconds, null);
  assert.equal(task.projectPath, '/tmp/explicit-job-project');
  assert.ok(task.startAt > Date.now()/1000);
  await chat.reload();
  await chat.locator('button[data-view="chat"]').click();
  await chat.locator('button[data-view="jobs"]').click();
  assert.equal(await chat.locator('#scheduled-list > section:not(:last-child) .scheduled-card').count(), 2);
  const recurringCard = chat.getByRole('region', {name:'Recurring jobs', exact:true}).locator('.scheduled-card').filter({hasText:'Recurring review'});
  await recurringCard.getByRole('button', {name:'Edit job',exact:true}).click();
  assert.equal(await chat.locator('#scheduled-title-input').inputValue(), 'Recurring review');
  assert.equal(await chat.locator('#scheduled-interval').inputValue(), '2');
  await chat.locator('#scheduled-title-input').fill('Recurring review edited');
  await chat.locator('#scheduled-prompt').fill('Updated prompt');
  await chat.locator('#scheduled-harness').selectOption('claude');
  await chat.locator('#scheduled-model').selectOption('__custom__');
  await chat.locator('#scheduled-custom-model').fill('edited-model');
  await chat.locator('#scheduled-time').fill(localTime);
  await chat.locator('#scheduled-interval-unit').selectOption('1');
  await chat.locator('#scheduled-interval').fill('90');
  await chat.locator('#scheduled-project').fill('/tmp/edited-project');
  await chat.locator('#scheduled-auto-resume').uncheck();
  await chat.locator('#scheduled-submit').click();
  await recurringCard.getByRole('heading', {name:'Recurring review edited',exact:true}).waitFor();
  const edited = await chat.evaluate(() => window.testTasks.find(task => task.title === 'Recurring review edited'));
  assert.equal(edited.prompt, 'Updated prompt'); assert.equal(edited.harness, 'claude'); assert.equal(edited.model, 'edited-model');
  assert.equal(edited.permissions, 'auto-review');
  assert.equal(edited.intervalSeconds, 90); assert.equal(edited.projectPath, '/tmp/edited-project'); assert.equal(edited.autoResume, false);
  await recurringCard.getByRole('button', {name:'Edit job',exact:true}).click();
  assert.equal(await chat.locator('#scheduled-custom-model').inputValue(), 'edited-model');
  assert.equal(await chat.locator('#scheduled-interval').inputValue(), '90');
  await chat.locator('#scheduled-edit-cancel').click();
  const oneTimeCard = chat.locator('.scheduled-card').filter({hasText:'Tomorrow one time'});
  await oneTimeCard.getByRole('button', {name:'Edit job',exact:true}).click();
  assert.equal(await chat.locator('#scheduled-permissions').inputValue(), 'workspace-write');
  await chat.locator('#scheduled-prompt').fill('Edited one-off prompt');
  await chat.locator('#scheduled-submit').click();
  await chat.locator('#scheduled-form-status').filter({hasText:'Changes saved.'}).waitFor();
  assert.equal(await chat.evaluate(() => window.testTasks.find(task => task.title === 'Tomorrow one time').prompt), 'Edited one-off prompt');
  await oneTimeCard.getByRole('button', {name:'Edit job',exact:true}).click();
  assert.equal(await chat.locator('#scheduled-permissions').inputValue(), 'workspace-write');
  await chat.locator('#scheduled-prompt').fill('Must not save after starting');
  await chat.evaluate(() => { window.testTasks.find(task => task.title === 'Tomorrow one time').status = 'running'; });
  await chat.locator('#scheduled-submit').click();
  await chat.locator('#scheduled-form-status').filter({hasText:'Editing is closed'}).waitFor();
  assert.equal(await chat.locator('#scheduled-submit').isDisabled(), true);
  assert.equal(await chat.evaluate(() => window.testTasks.find(task => task.title === 'Tomorrow one time').prompt), 'Edited one-off prompt');
  await chat.locator('#scheduled-edit-cancel').click();

  await recurringCard.getByRole('button', {name:'Recurring review edited', exact:true}).click();
  await chat.locator('#view-job').waitFor();
  assert.equal(await chat.locator('#view-jobs').isVisible(), false);
  assert.equal(await chat.getByText('View session', {exact:true}).count(), 0);
  await chat.getByRole('button', {name:'Open conversation', exact:true}).click();
  await chat.locator('#job-conversation-stream pre').filter({hasText:'Job output'}).waitFor();
  assert.equal(await chat.locator('#job-conversation-stream script').count(), 0);
  await native.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chat.locator('.job-message').filter({hasText:'Job output'}).getByRole('button', {name:'Copy', exact:true}).click();
  assert.equal(await chat.evaluate(() => navigator.clipboard.readText()), 'Job output <script>safe</script>');
  await chat.locator('#job-conversation-back').click();
  await chat.locator('#job-back').click();
  await recurringCard.getByRole('button', {name:'Cancel job'}).click();
  await recurringCard.locator('.scheduled-status').filter({hasText:'Cancelled'}).waitFor();
  await chat.evaluate(() => {
    const make = (id, status, intervalSeconds = null) => ({id, title:id, status, intervalSeconds, harness:'claude', model:'claude-fixture', prompt:'Check work', createdAt:2000000000, lastRunId:`${id}-run`});
    window.testTasks = [make('Recurring waiting', 'running', 3600), make('Paused check', 'needs_attention'), make('Failed check', 'needs_attention'), ...Array.from({length:12}, (_, i) => make(`Finished ${i}`, 'completed'))];
    window.testTaskRuns = Object.fromEntries(window.testTasks.map(task => [task.id, [{runId:task.lastRunId, conversationId:`session-${task.id}`, status:task.id === 'Recurring waiting' ? 'waiting' : task.status, startedAt:2000000000, events: task.id === 'Failed check' ? [{type:'error', text:'Command failed'}] : [{type:'text',text:'Session output',model:'actual-model'}, {type:'usage',model:'actual-model',usage:{kind:'tokens',scope:'turn',inputTokens:120,outputTokens:40,cacheReadTokens:30}}, {type:'activity',text:'Read'}, {type:'waiting', retryAt:2100000000}]}]]));
  });
  await chat.locator('#scheduled-refresh').click();
  const recurringSection = chat.getByRole('region', {name:'Recurring jobs', exact:true});
  const oneOffSection = chat.getByRole('region', {name:'One-time jobs', exact:true});
  const completedSection = chat.getByRole('region', {name:'Completed jobs', exact:true});
  await recurringSection.locator('.scheduled-card-header .scheduled-status').filter({hasText:'Waiting for reset'}).waitFor();
  assert.equal(await oneOffSection.locator('.scheduled-card').count(), 1);
  assert.match(await oneOffSection.innerText(), /Paused/);
  assert.equal(await completedSection.locator('.scheduled-card').count(), 10);
  assert.match(await completedSection.innerText(), /Failed/);
  assert.match(await completedSection.innerText(), /Succeeded/);
  await completedSection.getByRole('button', {name:'Next', exact:true}).click();
  assert.equal(await completedSection.locator('.scheduled-card').count(), 3);
  assert.equal(await completedSection.getByRole('button', {name:'Next', exact:true}).isDisabled(), true);
  await completedSection.getByRole('button', {name:'Previous', exact:true}).click();
  assert.equal(await completedSection.locator('.scheduled-card').count(), 10);
  const boxes = await Promise.all([recurringSection.boundingBox(), oneOffSection.boundingBox(), completedSection.boundingBox()]);
  assert.equal(Math.round(boxes[0].y), Math.round(boxes[1].y));
  assert.ok(boxes[1].x > boxes[0].x);
  assert.ok(boxes[2].y > boxes[0].y + boxes[0].height);
  await chat.locator('#scheduled-title').scrollIntoViewIfNeeded();
  await chat.screenshot({path:'/tmp/noai-check/jobs-overview.png', fullPage:true});
  await chat.setViewportSize({width:390, height:844});
  assert.equal(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileBoxes = await Promise.all([recurringSection.boundingBox(), oneOffSection.boundingBox()]);
  assert.ok(mobileBoxes[1].y > mobileBoxes[0].y);
  await chat.screenshot({path:'/tmp/noai-check/jobs-mobile.png', fullPage:true});
  await chat.setViewportSize({width:1280, height:900});
  await completedSection.getByRole('button', {name:'Finished 0', exact:true}).click();
  await chat.locator('#job-heading').filter({hasText:'Finished 0'}).waitFor();
  await chat.locator('#job-back').click();
  await recurringSection.getByRole('button', {name:'Recurring waiting', exact:true}).click();
  assert.match(await chat.locator('#job-content').innerText(), /actual-model/);
  assert.equal(await chat.locator('#job-content .job-prompt').evaluate(node => node.open), false);
  const sessionStats = chat.locator('#job-content').getByRole('region', {name:'Session stats', exact:true});
  await sessionStats.locator('.session-stats-more > summary').click();
  await sessionStats.getByText('Usage by model', {exact:true}).waitFor();
  assert.equal(await sessionStats.locator('.session-stats-grid > div').filter({has:chat.getByText('Total tokens', {exact:true})}).locator('dd').innerText(), '160');
  assert.equal(await sessionStats.locator('.session-stats-grid > div').filter({has:chat.getByText('Cached input', {exact:true})}).locator('dd').innerText(), '30');
  await chat.screenshot({path:'/tmp/noai-check/job-detail.png', fullPage:true});
  await chat.getByRole('button', {name:'Open conversation', exact:true}).click();
  await chat.locator('.job-message details summary').filter({hasText:'Tool activity'}).click();
  await chat.screenshot({path:'/tmp/noai-check/job-conversation.png', fullPage:true});
  await chat.locator('#job-conversation-back').click();
  await chat.locator('#job-back').click();
  await chat.evaluate(() => {
    window.testJobs.push({runId:'Recurring waiting-run', status:'running'});
  });
  await chat.locator('#scheduled-refresh').click();
  await recurringSection.locator('.scheduled-card-header .scheduled-status').filter({hasText:'Running'}).waitFor();
  await chat.evaluate(() => {
    window.testJobs.find(job => job.runId === 'Recurring waiting-run').status = 'waiting';
    window.testTasks = window.testTasks.filter(task => !task.title.startsWith('Finished'));
  });
  await completedSection.getByRole('button', {name:'Next', exact:true}).click();
  await chat.locator('#scheduled-refresh').click();
  await completedSection.locator('.scheduled-pagination').filter({hasText:'Page 1 of 1'}).waitFor();
  const failedCard = completedSection.locator('.scheduled-card').filter({hasText:'Failed check'});
  await failedCard.getByRole('button', {name:'Failed check',exact:true}).click();
  await chat.locator('#job-content').getByRole('button', {name:'Retry job',exact:true}).click();
  await chat.locator('#job-content').getByText('Retry scheduled',{exact:true}).waitFor();
  assert.equal(await chat.locator('#job-content').getByRole('button',{name:'Retry job',exact:true}).count(),0);
  const retried = await chat.evaluate(() => window.testTasks.find(task=>task.id==='Failed check'));
  assert.ok(retried.nextRunAt >= Date.now()/1000+55);
  assert.equal(retried.lastRunId,'Failed check-run');
  await chat.locator('#job-back').click();
  assert.equal(await oneOffSection.locator('.scheduled-card').filter({hasText:'Failed check'}).getByRole('button',{name:'Retry job',exact:true}).count(),0);
  assert.equal(await oneOffSection.locator('.scheduled-card').filter({hasText:'Paused check'}).getByRole('button',{name:'Retry job',exact:true}).count(),1);



  await chat.locator('button[data-view="home"]').click();
  await chat.locator('#metrics-chart svg').waitFor();
  assert.equal(await chat.locator('#metrics-harness').inputValue(), '');
  assert.equal(await chat.locator('#metrics-model').inputValue(), '');
  assert.match(await chat.locator('#metrics-totals').innerText(), /370/);
  await chat.locator('.metrics-daily-section > summary').click();
  assert.match(await chat.locator('#metrics-daily').innerText(), /370/);
  await chat.locator('#metrics-harness').selectOption('claude');
  assert.match(await chat.locator('#metrics-totals').innerText(), /240/);
  assert.equal(await chat.locator('#metrics-breakdown tr').count(), 1);
  await chat.locator('#metrics-model').selectOption('claude-fixture');
  assert.match(await chat.locator('#metrics-tools').innerText(), /Read/);
  await chat.locator('#metrics-value').selectOption('tools');
  assert.match(await chat.locator('#metrics-chart svg').getAttribute('aria-label'), /Tool events over time/);
  await chat.locator('#metrics-harness').selectOption('');
  await chat.locator('#metrics-value').selectOption('total');
  await chat.screenshot({path:'/tmp/noai-check/activity-metrics.png',fullPage:true});
  await chat.locator('button[data-view="jobs"]').click();
  await chat.locator('#open-settings').click();
  await chat.locator('input[name="theme"][value="dark"]').check();
  await chat.locator('input[name="palette"][value="graphite"]').check();
  await chat.locator('#settings-close').click();
  await chat.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
  await chat.screenshot({path:'/tmp/noai-check/jobs-dark.png',fullPage:true});
  await chat.setViewportSize({width:390,height:844});
  assert.equal(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (await chat.locator('body').evaluate(node => node.classList.contains('sidebar-open'))) await chat.locator('.sidebar-close').click();
  await chat.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
  await chat.screenshot({path:'/tmp/noai-check/jobs-mobile.png',fullPage:true,animations:'disabled'});

  await chat.setViewportSize({width:1440,height:960});
  await chat.locator('button[data-view="sessions"]').click();
  await chat.locator('#sessions-body tr').first().waitFor();
  assert.equal(await chat.locator('#sessions-body tr').count(), 25);
  await chat.locator('#sessions-next').click();
  assert.equal(await chat.locator('#sessions-previous').isDisabled(), false);
  await chat.locator('#sessions-search').fill('Design the garden');
  assert.equal(await chat.locator('#sessions-body tr').count(), 1);
  await chat.screenshot({path:'/tmp/noai-check/sessions-table.png',fullPage:true,animations:'disabled'});
  await chat.getByRole('link', {name:'Design the garden tracker',exact:true}).click();
  if (await chat.locator('#session-open-conversation').isVisible()) await chat.locator('#session-open-conversation').click();
  await chat.locator('#session-transcript').getByText('Here is the plan.', {exact:true}).waitFor();
  assert.equal(await chat.locator('#view-session').isVisible(), true);
  await chat.goBack();
  await chat.locator('#view-sessions').waitFor({state:'visible'});
  await chat.goForward();
  if (await chat.locator('#session-open-conversation').isVisible()) await chat.locator('#session-open-conversation').click();
  await chat.locator('#session-transcript').getByText('Here is the plan.', {exact:true}).waitFor();

  assert.equal(await chat.locator('#session-transcript script').count(), 0);
  assert.equal(await chat.locator('#session-statistics .session-stats-grid > div').filter({has:chat.getByText('Total tokens',{exact:true})}).locator('dd').innerText(), '160');
  await chat.locator('#session-load-more').click();
  await chat.locator('#session-transcript').getByText('Final page',{exact:true}).waitFor();
  assert.equal(await chat.locator('#session-load-more').isVisible(), false);
  await chat.locator('.main-content').evaluate(node => {node.scrollTop = 0;});
  await chat.screenshot({path:'/tmp/noai-check/session-detail.png',fullPage:true,animations:'disabled'});
  await chat.locator('#session-back').click();
  await chat.locator('#session-back').click();
  assert.equal(await chat.locator('#sessions-search').inputValue(), 'Design the garden');
  await chat.locator('#sessions-search').fill('');
  await chat.locator('#sessions-harness').selectOption('claude');
  assert.equal(await chat.locator('#sessions-body tr').count(), 14);
  await chat.locator('#sessions-harness').selectOption('');
  await chat.setViewportSize({width:390,height:844});
  await chat.screenshot({path:'/tmp/noai-check/sessions-mobile.png',fullPage:true,animations:'disabled'});
  assert.equal(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: themes, mobile, native IPC fixtures, session continuation, cancellation, drafts, safe rendering, timed-quota wait, restart recovery without duplicate output, provider telemetry, manual plan labels, conversation actions, Activity charts and harness/model filters.');
} finally {
  await browser.close();
}
