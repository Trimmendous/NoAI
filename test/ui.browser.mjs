// Synthetic-only end-to-end fixture. Run with NOAI_PLAYWRIGHT=/path/to/playwright/index.mjs
// and a preview already listening on NOAI_PREVIEW_URL (default :1437).
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.NOAI_PLAYWRIGHT || 'playwright');
const browser=await chromium.launch({headless:true});
const out=process.env.NOAI_SCREENSHOTS || '/tmp/noai-ui-check';await mkdir(out,{recursive:true});
const page=await browser.newPage({viewport:{width:1360,height:1050}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000), records=[];
 for(let day=0;day<50;day++)for(let n=0;n<3;n++) {
  const at=now-day*86400-n*3600;
  records.push({id:`u-${day}-${n}`,at,runId:`run-${day}`,sessionId:`session-${day}`,harness:day%3?'codex':'claude',model:day%3?'Example Model A':'Example Model B',type:'usage',usage:{kind:'tokens',scope:'turn',inputTokens:10000+day*930+n*2300,cacheReadTokens:8000+day*600,outputTokens:3500+n*500}});
  records.push({id:`t-${day}-${n}`,at,runId:`run-${day}`,sessionId:`session-${day}`,harness:day%3?'codex':'claude',model:day%3?'Example Model A':'Example Model B',type:'activity',tool:['Read','Shell','Edit'][n]});
 }
 const sessions=Array.from({length:58},(_,i)=>({id:`session-${i}`,sessionId:`session-${i}`,harness:i%3?'codex':'claude',model:i%3?'Example Model A':'Example Model B',title:`Example project review ${String(i).padStart(2,'0')}`,projectPath:'/example/project',startedAt:now-i*86400-7200,updatedAt:now-i*86400,messageCount:130}));
 const tasks=Array.from({length:13},(_,i)=>({id:`task-${i}`,title:`Example maintenance ${i}`,prompt:'Review the example project and explain the changes.',harness:'codex',model:'Example Model A',projectPath:'/example/project',status:'completed',createdAt:now-86400,permissions:'workspace-network',autoResume:true,lastRunId:`job-${i}-0`}));
 const runs=id=>Array.from({length:2},(_,i)=>({taskId:id,runId:`job-${id.split('-')[1]}-${i}`,harness:'codex',model:'Example Model A',projectPath:'/example/project',startedAt:now-86400*(i+1),finishedAt:now-86400*(i+1)+3600,status:i?'failed':'completed',events:[{type:'usage',at:now-86400*(i+1)+3500,eventId:0,usage:{kind:'tokens',scope:'turn',inputTokens:120000,cacheReadTokens:90000,outputTokens:9000}},...Array.from({length:55},(_,n)=>({type:n%4===0?'thinking':n%4===1?'activity':'text',at:now-86400*(i+1)+n*10,eventId:n+1,text:n%4===1?'Read':`Synthetic ${n%4===0?'recorded thinking':'assistant response'} ${n}. This is an example explanation for layout testing.\n\nThe preview uses invented fixture content, not private history.`}))]}));
 window.__fixture={metricsCalls:0};
 window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(command,args)=>{
  switch(command){
   case 'load_workspace':return null;
   case 'runtime_status':return {platform:'linux',harnesses:[{id:'codex',installed:true}]};
   case 'get_activity_metrics':window.__fixture.metricsCalls++;if(window.__fixture.failMetrics || location.search.includes('failMetrics'))throw new Error('Example read failure');return {records,importStatus:{files:50,errors:0}};
   case 'list_local_sessions':return {sessions,errors:0};
   case 'get_local_session':return {records:records.filter(r=>r.sessionId===args.id),messages:Array.from({length:100},(_,n)=>({role:n%5===0?'tool':n%2?'user':'assistant',at:now-n*60,activities:n===2?[{kind:'thinking',text:'Synthetic recorded thinking'},{kind:'tool',text:'Synthetic tool output'}]:[],text:`Synthetic message ${n}. Here is an example of a readable conversation.\n\nA second paragraph gives this bubble enough space for checking long transcripts.`})),nextOffset:null};
   case 'list_scheduled_tasks':return tasks;
   case 'get_scheduled_task_runs':return runs(args.id);
   case 'get_resume_jobs':case 'get_active_runs':case 'get_provider_usage':case 'get_harness_models':return [];
   case 'connect_events':case 'set_background_mode':case 'save_workspace':return null;
   default:throw new Error(`Unexpected fixture command: ${command}`);
  }
 }}};
});
const go=async view=>{await page.locator(`.primary-nav [data-view="${view}"]`).evaluate(el=>el.click());};
async function sticky(selector) {
 await page.locator('.main-content').evaluate(el=>el.scrollTop=el.scrollHeight);
 await page.waitForTimeout(80);
 const box=await page.locator(selector).boundingBox();const port=await page.locator('.main-content').boundingBox();
 assert.ok(box&&box.y>=port.y&&box.y<port.y+100,`${selector} must stay at scrollport top: ${JSON.stringify(box)}`);
 const hit=await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
 assert.ok(hit,`${selector} is not obscured`);
}
try {
 await page.goto(process.env.NOAI_PREVIEW_URL || 'http://127.0.0.1:1437');
 await page.waitForFunction(()=>document.querySelector('#metrics-chart svg'));
 assert.ok(await page.locator('#view-home').isVisible());
 const calls=await page.evaluate(()=>window.__fixture.metricsCalls);
 for(const range of ['24h','31d','all','7d'])await page.selectOption('#metrics-range',range);
 await page.selectOption('#metrics-style','line');assert.equal(await page.locator('#metrics-chart polyline').count(),3);
 await page.selectOption('#metrics-style','bar');assert.ok(await page.locator('#metrics-chart rect').count()>0);
 assert.equal(await page.evaluate(()=>window.__fixture.metricsCalls),calls,'Chart controls must not rescan history');
 await page.locator('#metrics-chart rect').first().focus();assert.match(await page.locator('.chart-readout').first().innerText(),/Cached input/);
 await page.selectOption('#metrics-value','cost');assert.match(await page.locator('#metrics-chart').innerText(),/Cost unavailable/);
 await page.selectOption('#metrics-value','total');await page.locator('.main-content').evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:`${out}/home-light.png`});
 await go('sessions');await page.locator('#sessions-next').click();
 await page.locator('.main-content').evaluate(el=>el.scrollTop=400);const scroll=await page.locator('.main-content').evaluate(el=>el.scrollTop);
 await page.locator('.session-title-link').nth(5).click();await page.waitForFunction(()=>document.querySelector('#session-statistics svg'));
 await sticky('#session-back');await page.locator('.main-content').evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:`${out}/session-light.png`});
 await page.locator('#session-open-conversation').click();await sticky('#session-back');
 assert.equal(await page.locator('#session-transcript .job-copy').count(),100);
 assert.equal(await page.locator('#session-transcript summary').filter({hasText:'Recorded thinking'}).count(),1);
 await page.screenshot({path:`${out}/session-conversation.png`});
 await page.locator('#session-back').click();assert.ok(await page.locator('#session-open-conversation').isVisible());
 await page.locator('#session-back').click();assert.equal(await page.locator('#sessions-page').innerText(),'2 / 3');
 assert.ok(Math.abs(await page.locator('.main-content').evaluate(el=>el.scrollTop)-scroll)<2);
 await go('jobs');await page.locator('.job-title-button').first().click();
 await page.waitForFunction(()=>document.querySelector('#job-content svg'));
 await page.selectOption('.job-run-picker select',{index:1});assert.match(await page.locator('.job-overview').innerText(),/Failed/);
 await sticky('#job-back');await page.locator('.main-content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`${out}/job-light.png`});
 await page.getByRole('button',{name:'Open conversation',exact:true}).filter({visible:true}).click();await sticky('#job-conversation-back');
 await page.screenshot({path:`${out}/job-conversation.png`});
 await page.locator('#job-conversation-back').click();assert.equal(await page.locator('.job-run-picker select').inputValue(),'job-0-1');
 for(const theme of ['dark','light']) {
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await page.locator('#theme-toggle').click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);
  await page.setViewportSize({width:390,height:844});
  await sticky('#job-back');
  await page.locator('.main-content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`${out}/job-${theme}-narrow.png`});
  await page.getByRole('button',{name:'Open conversation',exact:true}).filter({visible:true}).click();await sticky('#job-conversation-back');await page.locator('#job-conversation-back').click();
  await go('home');await page.locator('.main-content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`${out}/home-${theme}-narrow.png`});
  await page.locator('#metrics-chart').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/chart-${theme}-narrow.png`});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await go('jobs');await page.locator('.job-title-button').first().click();
 }
 await go('home');
 await page.evaluate(()=>window.__fixture.failMetrics=true);await page.locator('#metrics-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#metrics-status').textContent.includes('Cannot refresh'));
 assert.ok(await page.locator('#metrics-totals').isVisible());
 // Test the reusable USD chart separately with explicit synthetic recorded costs.
 await page.evaluate(async()=>{
   const {renderUsageChart}=await import('/js/components/usage-chart.js');
   renderUsageChart(document.querySelector('#metrics-chart'),{costReports:2,points:[{at:100,cost:0,costReports:1,usageReports:1},{at:200,cost:0,costReports:0,usageReports:1},{at:300,cost:.125,costReports:1,usageReports:2}],step:3600},{metric:'cost',style:'line'});
 });
 assert.equal(await page.locator('#metrics-chart circle').count(),2,'Unknown cost bucket stays a gap');
 assert.equal(await page.locator('#metrics-chart polyline').count(),2,'Line does not bridge unknown cost');
 assert.match(await page.locator('#metrics-chart table').textContent(),/Unavailable/);
 await page.goto((process.env.NOAI_PREVIEW_URL || 'http://127.0.0.1:1437')+'?failMetrics');
 await page.waitForFunction(()=>document.querySelector('#metrics-status').textContent.includes('Cannot refresh'));
 assert.equal(await page.locator('#metrics-totals').isVisible(),false,'Failed first load must not show zero totals');
 assert.deepEqual(errors,[]);console.log('Browser checks passed: default Home, chart toggles, no rescans, cost unavailable, session pagination/scroll restoration, job/run selection, long transcripts, sticky Back, light/dark, 390px layout.');
} finally {await browser.close();}
