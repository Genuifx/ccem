// Start this, then open /test/fixtures/plan-content.html?port=<printed port>
// in the canonical Tauri development app. No product sessions are modified.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPlanContentHelper, spawnTrackedHelper, send, waitForOutput, PLAN } from '../../../packages/native-runtime-helper/test/claude-plan-content-harness.mjs';

const built = await buildPlanContentHelper();
const cleanups = [];
const helper = spawnTrackedHelper({ after(fn) { cleanups.push(fn); } }, built);
const runtimeId = `fixture-plan-content-${randomUUID()}`;
const occurred_at = new Date().toISOString();
const events = [{ runtime_id: runtimeId, seq: 1, occurred_at, payload: { type: 'user_prompt', text: '验证完整计划显示与确认', image_count: 0 } }];
let consumed = 0;
let status = 'processing';
function collect() {
  for (const output of helper.outputs.slice(consumed)) {
    if (output.type === 'event') events.push({ runtime_id: runtimeId, seq: events.length + 1, occurred_at: new Date().toISOString(), payload: output.payload });
    if (output.type === 'status') status = output.status;
  }
  consumed = helper.outputs.length;
}
send(helper, { type: 'init', provider: 'claude', env_name: 'fixture', perm_mode: 'dev', working_dir: built.tempDir, initial_prompt: '{}', initial_command_id: 'plan-smoke-1' });
await waitForOutput(helper, o => o.payload?.prompt?.plan_summary === PLAN, 'complete plan');
collect();
const calls = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  try {
    let result;
    collect();
    if (req.method === 'GET') {
      result = { runtimeId, occurred_at, status, events, calls, plan: PLAN, workingDir: built.tempDir };
    } else {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { command, args = {} } = JSON.parse(body);
      calls.push({ command, args });
      if (command === 'respond_native_session_prompt') {
        if (args.runtimeId !== runtimeId || args.toolUseId !== 'exit-plan-1') throw new Error('Wrong fixture target');
        send(helper, { type: 'interactive_prompt_response', tool_use_id: args.toolUseId, prompt_type: args.promptType, answers: args.answers });
        await waitForOutput(helper, o => o.payload?.type === 'interactive_response_result' && o.payload.state === 'applied', 'approval receipt');
        collect();
      }
      if (command === 'get_native_session_events' || command === 'get_native_session_event_page') {
        const snapshot = args.snapshotNewestSeq ?? events.length;
        const after = args.afterSeq ?? args.sinceSeq ?? 0;
        result = { events: events.filter(e => e.seq > after && e.seq <= snapshot), source_available: true, gap_detected: false,
          has_more: false, decode_failure_count: 0, oversized_event_count: 0,
          oldest_available_seq: 1, newest_available_seq: snapshot, snapshot_newest_seq: snapshot };
      } else if (command === 'get_settings') result = { language: 'zh' };
      else if (['get_native_session_input_queue', 'get_session_subagents', 'get_session_file_checkpoints', 'list_workspace_session_references'].includes(command)) result = [];
      else if (command === 'get_workspace_git_snapshot') result = { is_git_repo: false, files: [] };
      else result = null;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const artifactDir = path.resolve(import.meta.dirname, '../../../.artifacts/plan-exit-content');
await fs.mkdir(artifactDir, { recursive: true });
const info = { port: server.address().port, runtimeId, helperPid: helper.helper.pid, serverPid: process.pid };
await fs.writeFile(path.join(artifactDir, 'smoke-server.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
async function shutdown() {
  collect();
  await fs.writeFile(path.join(artifactDir, 'smoke-events.json'), JSON.stringify({ events, calls }, null, 2));
  server.close();
  for (const cleanup of cleanups) await cleanup();
  process.exit();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
