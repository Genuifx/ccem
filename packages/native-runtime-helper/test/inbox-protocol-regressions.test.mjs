import test from 'node:test';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'packages/native-runtime-helper/package.json'));
const { build } = require('esbuild');
const outdir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-inbox-protocol-'));
test.after(() => fs.rm(outdir, { recursive: true, force: true }));
const outfile = path.join(outdir, 'repro-helper.mjs');
const mockClaude = `
import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
export function createSdkMcpServer(config) { return {type:'sdk',name:config.name,instance:{_registeredTools:{}}}; }
export async function forkSession() { return {sessionId:'mock-session'}; }
export function query({prompt}) {
 let closed=false;
 const scenario=process.env.MOCK_SCENARIO;
 const background=scenario.startsWith('background');
 return {close(){closed=true},async interrupt(){},async setPermissionMode(){},async getContextUsage(){return null},async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(){return null},
 async *[Symbol.asyncIterator]() {
  yield {type:'system',subtype:'init',session_id:'mock-legacy',capabilities:background||scenario==='full_no_terminal'?['msg_lifecycle_v1']:[]};
  for await (const msg of prompt) {
   if(closed)return;
   yield {...msg,session_id:'mock-legacy'};
   yield {type:'system',subtype:'session_state_changed',state:'running',session_id:'mock-legacy'};
   if(background){
    yield {type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'task-bg',task_type:'bash',description:'Finished async build'}]};
    yield {type:'result',subtype:'success',result:'done',user_message_uuid:msg.uuid,session_id:'mock-legacy'};
    yield {type:'command_lifecycle',command_uuid:msg.uuid,state:'completed',session_id:'mock-legacy'};
    yield {type:'system',subtype:'session_state_changed',state:'idle',session_id:'mock-legacy'};
    if(scenario === 'background_terminal_live') yield {type:'system',subtype:'task_notification',task_id:'task-bg',status:'completed',summary:'done'};
    if(scenario === 'background_pending') while(!fs.existsSync(process.env.MOCK_RELEASE_FILE)) await sleep(5);
    if(!['background_live','background_terminal_live'].includes(scenario)) yield {type:'system',subtype:'background_tasks_changed',tasks:[]};
    continue;
   }
   const idle={type:'system',subtype:'session_state_changed',state:'idle',user_message_uuid:msg.uuid,session_id:'mock-legacy'};
   const result={type:'result',subtype:'success',result:'done',user_message_uuid:msg.uuid,session_id:'mock-legacy'};
   if(scenario==='result_first'){yield result;yield idle;}
   else if(scenario==='idle_only'){yield idle;yield {...result,user_message_uuid:'old-command'};}
   else if(scenario==='result_only'){yield {...idle,user_message_uuid:'old-command'};yield result;}
   else {yield idle;yield result;yield result;}
  }
 }};
}`;
const mockCodex = `
import fs from 'node:fs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const probe=(payload)=>process.stdout.write(JSON.stringify({type:'mock_probe',...payload})+'\\n');
let active=0;
export class Codex {
 startThread(){return this.resumeThread()}
 resumeThread(){return {async runStreamed(input,{signal}) {
  return {events:(async function*(){
   active++;probe({stage:'started',input,active});
   let aborted=false;
   signal.addEventListener('abort',()=>{aborted=true;probe({stage:'abort_signal',input})},{once:true});
   yield {type:'turn.started'};
   if(input==='A') {
    while(!aborted) await sleep(5);
    while(!fs.existsSync(process.env.MOCK_RELEASE_FILE)) await sleep(5);
   } else { while(!aborted) await sleep(5); }
   active--;probe({stage:'finished',input,aborted,active});
   if(aborted){const e=new Error('abort');e.name='AbortError';throw e}
   yield {type:'turn.completed',usage:{input_tokens:0,output_tokens:0}};
  })()};
 }}}
}`;
await build({entryPoints:[path.join(root,'packages/native-runtime-helper/src/index.ts')],outfile,bundle:true,platform:'node',format:'esm',target:'node20',logLevel:'silent',plugins:[{name:'mock-sdks',setup(b){
 b.onResolve({filter:/^@anthropic-ai\/claude-agent-sdk$/},()=>({path:'claude',namespace:'mock'}));
 b.onResolve({filter:/^@anthropic-ai\/sdk$/},()=>({path:'anthropic',namespace:'mock'}));
 b.onResolve({filter:/^@openai\/codex-sdk$/},()=>({path:'codex',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({loader:'js',contents:a.path==='claude'?mockClaude:a.path==='codex'?mockCodex:'export default class Anthropic {}'}));
}}]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let launchId=0;
function launch(provider,scenario='idle_first', resumedPrompt=null){
 const releaseFile=path.join(outdir, `release-${launchId++}`);
 const child=spawn(process.execPath,[outfile],{stdio:['pipe','pipe','pipe'],env:{...process.env,MOCK_SCENARIO:scenario,MOCK_RELEASE_FILE:releaseFile,CCEM_NATIVE_USAGE_DEADLINE_MS:'30',CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS:'50'}});
 const outputs=[];let buffer='';let stderr='';
 child.stdout.on('data',c=>{buffer+=c;for(;;){const n=buffer.indexOf('\n');if(n<0)break;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(line.trim())outputs.push(JSON.parse(line))}});
 child.stderr.on('data',c=>{stderr+=c});
 const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
 const wait=async pred=>{for(let i=0;i<200;i++){const got=outputs.find(pred);if(got)return got;await sleep(10)}throw Error('wait failed: '+JSON.stringify({outputs,stderr}))};
 const init={type:'init',provider,working_dir:'/tmp',env_name:'default',perm_mode:'dev', ...(resumedPrompt ? {provider_session_id:'mock-resumed-session'} : {})};
 // One stdin chunk deliberately enters prompt while resumed init is yielded
 // at its context-usage await. This is the real reconnect wire ordering.
 if(resumedPrompt) child.stdin.write(JSON.stringify(init)+'\n'+JSON.stringify({type:'prompt',text:resumedPrompt})+'\n');
 else send(init);
 return {child,outputs,send,wait,release:()=>fs.writeFile(releaseFile,'release')};
}

for (const scenario of ['idle_first', 'result_first', 'idle_only', 'result_only']) {
 test(`LegacySerial requires both current-command idle and result: ${scenario}`, async () => {
  const h = launch('claude', scenario);
  try {
   await h.wait(o => o.type === 'status' && o.status === 'ready');
   h.send({type:'prompt', text:'A', command_id:'A'});
   const completes = scenario === 'idle_first' || scenario === 'result_first';
   if (completes) await h.wait(o => o.payload?.stage === 'legacy_turn_terminal');
   else await sleep(150);
   h.send({type:'prompt', text:'B', command_id:'B'});
   if (completes) {
    await h.wait(o => o.payload?.stage === 'legacy_turn_terminal' && o.payload.command_id === 'B');
    assert.equal(h.outputs.filter(o => o.payload?.stage === 'legacy_turn_terminal' && o.payload.command_id === 'A').length, 1);
    assert.equal(h.outputs.some(o => o.payload?.stage === 'command_rejected'), false);
   } else {
    await h.wait(o => o.payload?.stage === 'command_rejected' && o.payload.command_id === 'B');
    assert.equal(h.outputs.some(o => o.payload?.stage === 'legacy_turn_terminal'), false);
   }
  } finally { h.child.kill('SIGTERM'); }
 });
}
for (const scenario of ['background_snapshot', 'background_live', 'background_terminal_live']) {
 test(`full live snapshot controls settings gate: ${scenario}`, async () => {
  const h = launch('claude', scenario);
  try {
   await h.wait(o => o.type === 'status' && o.status === 'ready');
   h.send({type:'prompt', text:'A', command_id:'A'});
   await h.wait(o => o.payload?.stage === 'sdk_command_state' && o.payload.detail === 'completed');
   if (scenario === 'background_snapshot') await h.wait(o => o.payload?.type === 'background_tasks_changed' && o.payload.tasks.length === 0);
   h.send({type:'update_settings', request_id:'env', env_name:'new-env', env_vars:{}});
   const ack = await h.wait(o => o.type === 'settings_update_result' && o.request_id === 'env');
   assert.equal(ack.outcome, scenario === 'background_snapshot' ? 'applied' : 'deferred');
   if (scenario === 'background_snapshot') {
    h.send({type:'prompt', text:'B', command_id:'B'});
    await h.wait(o => o.payload?.stage === 'sdk_command_state' && o.payload.detail === 'completed' && o.payload.command_id === 'B');
    assert.equal(h.outputs.some(o => o.payload?.stage === 'command_rejected'), false);
   }
  } finally { h.child.kill('SIGTERM'); }
 });
}
test('Codex interrupt holds execution slot until abort settles and preserves next controller', async () => {
 const h = launch('codex');
 try {
  await h.wait(o => o.type === 'status' && o.status === 'ready');
  h.send({type:'prompt', text:'A'});
  await h.wait(o => o.type === 'mock_probe' && o.input === 'A' && o.stage === 'started');
  h.send({type:'interrupt_turn'});
  h.send({type:'prompt', text:'B'});
  await h.wait(o => o.type === 'mock_probe' && o.input === 'A' && o.stage === 'abort_signal');
  await sleep(50);
  assert.equal(h.outputs.some(o => o.type === 'mock_probe' && o.input === 'B'), false);
  await h.release();
  await h.wait(o => o.type === 'mock_probe' && o.input === 'B' && o.stage === 'started');
  assert.equal(h.outputs.some(o => o.type === 'mock_probe' && o.active === 2), false);
  const aEnd = h.outputs.findIndex(o => o.type === 'mock_probe' && o.input === 'A' && o.stage === 'finished');
  const bStart = h.outputs.findIndex(o => o.type === 'mock_probe' && o.input === 'B' && o.stage === 'started');
  assert.ok(aEnd >= 0 && aEnd < bStart);
  h.send({type:'interrupt_turn'});
  await h.wait(o => o.type === 'mock_probe' && o.input === 'B' && o.stage === 'abort_signal');
 } finally { h.child.kill('SIGTERM'); }
});

test('pending settings apply after empty snapshot without a task notification', async () => {
 const h=launch('claude','background_pending');
 try {
  await h.wait(o=>o.type==='status' && o.status==='ready');
  h.send({type:'prompt',text:'A',command_id:'A'});
  await h.wait(o=>o.payload?.stage==='sdk_command_state' && o.payload.detail==='completed');
  h.send({type:'update_settings',request_id:'pending-env',env_name:'new-env',env_vars:{}});
  await h.wait(o=>o.type==='settings_update_result' && o.request_id==='pending-env' && o.outcome==='deferred');
  await h.release();
  await h.wait(o=>o.payload?.type==='runtime_settings_changed' && o.payload.request_id==='pending-env' && o.payload.state==='applied');
  h.send({type:'prompt',text:'B',command_id:'B'});
  await h.wait(o=>o.payload?.stage==='command_admitted' && o.payload.command_id==='B');
 } finally {h.child.kill('SIGTERM');}
});
test('FullLifecycle does not release on idle and Result without the authoritative terminal', async () => {
 const h=launch('claude','full_no_terminal');
 try {
  await h.wait(o=>o.type==='status' && o.status==='ready');
  h.send({type:'prompt',text:'A',command_id:'A'});
  await h.wait(o=>o.payload?.stage==='turn_result_observed');
  h.send({type:'prompt',text:'B',command_id:'B'});
  await h.wait(o=>o.payload?.stage==='command_rejected' && o.payload.command_id==='B');
  assert.equal(h.outputs.some(o=>o.payload?.stage==='legacy_turn_terminal'),false);
 } finally {h.child.kill('SIGTERM');}
});

test('resumed Codex init cannot publish ready over a concurrent active prompt', async () => {
 const h=launch('codex','idle_first','B');
 try {
  await h.wait(o=>o.type==='mock_probe' && o.stage==='started' && o.input==='B');
  const statuses=h.outputs.filter(o=>o.type==='status');
  assert.equal(statuses.at(-1)?.status,'processing');
  const processing=h.outputs.findIndex(o=>o.type==='status' && o.status==='processing');
  assert.ok(processing>=0);
  assert.equal(h.outputs.slice(processing).some(o=>o.type==='status' && o.status==='ready'),false,
   'init completion must not erase active-run state used by Stop');
  h.send({type:'interrupt_turn'});
  await h.wait(o=>o.type==='mock_probe' && o.stage==='abort_signal' && o.input==='B');
  await h.wait(o=>o.type==='status' && o.status==='ready');
 } finally {h.child.kill('SIGTERM');}
});
