// Headless daemon/CLI integration with a local protocol fixture; never invokes a paid agent.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const {sendRequest} = await import('../bin/noai');
const root = await mkdtemp(path.join(os.tmpdir(), 'noai-native-'));
const fixtures = path.join(root, 'bin');
await mkdir(fixtures);
const fixture = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fixture 1.0'); }
else if (process.argv.includes('app-server')) {
  const readline = await import('node:readline');
  for await (const line of readline.createInterface({input:process.stdin})) {
    const req = JSON.parse(line); if (!req.id) continue;
    let result = {};
    if(req.method==='account/read') result={account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}};
    if(req.method==='account/rateLimits/read') result={accountId:'smoke-account',rateLimits:{primary:{usedPercent:0,resetsAt:0}}};
    if(req.method==='model/list') result={data:[{id:'fixture',model:'fixture',displayName:'Local fixture'}]};
    console.log(JSON.stringify({id:req.id,result}));
  }
} else if (process.argv.includes('exec')) {
  const fs = await import('node:fs'); fs.appendFileSync(process.env.NOAI_FIXTURE_ARGS,JSON.stringify({harness:'codex',args:process.argv.slice(2)})+'\\n');
  let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
  console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
  if (prompt.includes('WAIT_FOR_RESET') && !process.argv.includes('resume')) {
    console.log(JSON.stringify({type:'turn.failed',error:{message:'Usage limit reached. Retry after 1 second'}})); process.exitCode=1;
  } else {
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Native fixture completed safely.'}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'tool-1',type:'command_execution',command:'echo fixture'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:30}}));
  }
} else process.exitCode=1;
`;
await writeFile(path.join(fixtures, 'codex'), fixture, {mode:0o755});
await writeFile(path.join(fixtures, 'claude'), `#!/usr/bin/env node
if(process.argv.includes('--version')) console.log('Claude fixture');
else if(process.argv.includes('auth')) console.log(JSON.stringify({accountUuid:'fixture-claude'}));
else {
  const fs = await import('node:fs'); fs.appendFileSync(process.env.NOAI_FIXTURE_ARGS,JSON.stringify({harness:'claude',args:process.argv.slice(2)})+'\\n');
  for await (const chunk of process.stdin) {}
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Claude fixture completed safely.'}]}}));
}
`, {mode:0o755});
const env = {...process.env, XDG_DATA_HOME:path.join(root,'data'), PATH:`${fixtures}:${process.env.PATH}`, NOAI_FIXTURE_ARGS:path.join(root,'argv.jsonl')};
delete env.OPENROUTER_API_KEY;
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const binary = path.resolve('src-tauri/target/debug/noai');
const app = spawn(binary, ['--daemon'], {env, stdio:['ignore','pipe','pipe']});
let logs=''; app.stderr.on('data', chunk=>logs+=chunk);
const cli = path.resolve('bin/noai');
const command = async (...args) => JSON.parse((await exec(cli,args,{env,timeout:20000})).stdout);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, seconds=100) {
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline) { try { const value=await check(); if(value) return value; } catch {} await sleep(300); }
  throw new Error(`Native check timed out. ${logs}`);
}
let generated;
try {
  await until(async()=>Array.isArray(await command('jobs','list')));
  const future=await command('jobs','create','--title','Future fixture','--prompt','No work yet','--at',new Date(Date.now()+86400000).toISOString(),'--every','2h');
  generated=future.projectPath;
  assert.equal(path.dirname(generated), path.join(os.homedir(),'.noai'));
  assert.match(path.basename(generated),/^[0-9a-f-]{36}$/);
  assert.equal((await stat(generated)).isDirectory(),true);
  assert.equal(future.intervalSeconds,7200);
  assert.equal(future.permissions,'workspace-network');
  const socket = path.join(env.XDG_DATA_HOME,'dev.noai.desktop','control.sock');
  const input = {title:'Edited future',prompt:'Edited prompt',harness:'claude',model:'edited-model',projectPath:generated,startAt:Math.floor(Date.now()/1000)+86400,intervalSeconds:90,autoResume:true,dangerouslyBypassPermissions:false};
  const edit = await sendRequest(socket, {command:'edit',id:future.id,input,expected_last_run_id:null});
  assert.equal(edit.ok,true); assert.equal(edit.data.harness,'claude'); assert.equal(edit.data.model,'edited-model'); assert.equal(edit.data.intervalSeconds,90);

  const changed=await command('jobs','update-auto-resume',future.id,'false');
  assert.equal(changed.autoResume,false);
  await command('jobs','cancel',future.id);
  assert.equal((await sendRequest(socket,{command:'edit',id:future.id,input,expected_last_run_id:null})).ok,false);
  const task=await command('jobs','create','--title','Native resume fixture','--prompt','WAIT_FOR_RESET','--project',root,'--at','now','--dangerously-bypass-permissions','true');
  const done=await until(async()=> (await command('jobs','list')).find(item=>item.id===task.id && item.status==='completed'));
  assert.equal(done.status,'completed');
  const runs=await command('jobs','runs',task.id);
  assert.equal(runs.length,1);
  const waiting = runs[0].events.find(event=>event.type==='waiting');
  assert.ok(waiting.retryAt >= waiting.at + 60);
  assert.ok(runs[0].finishedAt >= waiting.retryAt);
  assert.ok(runs[0].events.some(event=>event.type==='waiting'));
  assert.ok(runs[0].events.some(event=>event.type==='text' && event.text==='Native fixture completed safely.'));
  for (const [harness,bypass] of [['codex',false],['claude',false],['claude',true]]) {
    const other=await command('jobs','create','--title',`${harness} ${bypass}`,'--prompt','Complete fixture','--project',root,'--harness',harness,'--auto-resume','false','--dangerously-bypass-permissions',String(bypass));
    await until(async()=> (await command('jobs','list')).some(item=>item.id===other.id && item.status==='completed'));
  }
  const sandboxed=await command('jobs','create','--title','Sandboxed resume fixture','--prompt','WAIT_FOR_RESET','--project',root,'--permissions','workspace-write');
  await until(async()=> (await command('jobs','list')).some(item=>item.id===sandboxed.id && item.status==='completed'));
  const sandboxedRuns=await command('jobs','runs',sandboxed.id);
  assert.equal(sandboxedRuns[0].permissions,'workspace-write');
  assert.equal(sandboxedRuns[0].dangerouslyBypassPermissions,false);
  const missed=await command('jobs','create','--title','Recover missed limit','--prompt','WAIT_FOR_RESET','--project',root,'--auto-resume','false');
  await until(async()=> (await command('jobs','list')).some(item=>item.id===missed.id && item.status==='needs_attention'));
  const missedRuns=await command('jobs','runs',missed.id);
  await command('jobs','update-auto-resume',missed.id,'true');
  const recovered=await command('jobs','retry',missed.id);
  assert.equal(recovered.lastRunId,missedRuns[0].runId);
  assert.ok(recovered.nextRunAt >= Date.now()/1000+58);
  assert.ok(recovered.pendingResumeId);
  assert.equal(recovered.permissions,'workspace-network');
  assert.equal(recovered.status,'scheduled');
  const recoveredRuns=await command('jobs','runs',missed.id);
  assert.equal(recoveredRuns.length,1);
  assert.equal(recoveredRuns[0].status,'needs_attention');
  assert.deepEqual(recoveredRuns,missedRuns);
  await assert.rejects(command('jobs','retry',missed.id));
  await command('jobs','cancel',missed.id);
  assert.equal((await command('jobs','retry',missed.id)).status,'scheduled');
  await command('jobs','cancel',missed.id);
  await assert.rejects(command('jobs','retry',task.id));
  const args=(await readFile(env.NOAI_FIXTURE_ARGS,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const codex=args.filter(item=>item.harness==='codex');
  assert.equal(codex.length,6);
  for (const run of codex.slice(3,5)) {
    assert.ok(run.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(run.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(!run.args.some(arg=>arg.includes('dangerously')));
  }
  assert.ok(codex[4].args.includes('resume'));
  assert.ok(codex[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(codex[1].args.includes('resume'));
  assert.ok(codex[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!codex[2].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(codex[2].args.includes('sandbox_mode="workspace-write"'));
  assert.ok(codex[2].args.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(codex[2].args.includes('approval_policy="never"'));
  const claude=args.filter(item=>item.harness==='claude');
  assert.ok(claude[0].args.includes('auto'));
  assert.ok(!claude[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(claude[1].args.includes('--dangerously-skip-permissions'));
  assert.ok(!claude[1].args.includes('dontAsk'));
  const metrics = await sendRequest(path.join(env.XDG_DATA_HOME,'dev.noai.desktop','control.sock'),{command:'metrics'});
  assert.equal(metrics.ok,true);
  assert.ok(metrics.data.records.some(row=>row.harness==='codex' && row.usage?.inputTokens===100 && row.usage?.outputTokens===20));
  assert.ok(metrics.data.records.some(row=>row.type==='activity' && row.tool==='command_execution'));
  assert.ok(metrics.data.records.every(row=>row.at>0));
  const journal=JSON.parse(await readFile(path.join(env.XDG_DATA_HOME,'dev.noai.desktop','scheduled-tasks.json'),'utf8'));
  assert.equal(journal.tasks.length,7);
  console.log('Headless native smoke passed (no DISPLAY): CLI socket, UUID folder, future recurrence, persisted settings/cancel, actual CLI fixture run timed auto-resume and normal/bypass argv for both harnesses, recorded token/tool metrics.');
} finally {
  app.kill('SIGTERM');
  await new Promise(resolve=>{if(app.exitCode!==null || app.signalCode!==null)resolve();else app.once('exit',resolve);});
  if(generated) await rmdir(generated); // Only our empty generated workspace, never recursive.
  await rm(root,{recursive:true,force:true});
}
