import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildHelperWithWireMock,
  spawnTrackedHelper,
  send,
  waitForOutput,
} from './claude-command-lifecycle-harness.mjs';

/**
 * The SDK reads input in a separate pump from model/tool execution. In
 * particular, it consumes a priority:next message while the running tool waits
 * at a test-controlled boundary. A sequential for-await mock cannot prove that.
 */
function streamingSdkSource(config) {
  return `const config = ${JSON.stringify(config)};\n` + String.raw`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const probe = (value) => process.stdout.write(JSON.stringify({type:'steer_probe',...value})+'\n');
    export const tool = (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler });
    export const createSdkMcpServer = (settings) => ({ type:'sdk',name:settings.name,instance:{} });
    export async function forkSession() { throw new Error('Unexpected fork in steer test'); }

    class OutputQueue {
      items = [];
      waiting = [];
      closed = false;
      push(value) {
        if (this.closed) return;
        const resolve = this.waiting.shift();
        if (resolve) resolve({value,done:false});
        else this.items.push(value);
      }
      end() {
        this.closed = true;
        for (const resolve of this.waiting.splice(0)) resolve({done:true});
      }
      [Symbol.asyncIterator]() { return this; }
      next() {
        if (this.items.length) return Promise.resolve({value:this.items.shift(),done:false});
        if (this.closed) return Promise.resolve({done:true});
        return new Promise((resolve) => this.waiting.push(resolve));
      }
    }

    export function query({prompt}) {
      const output = new OutputQueue();
      const session_id = 'steer-mock-session';
      let closed = false;
      let root = null;
      let sequence = 0;
      const full = config.capabilities.includes('msg_lifecycle_v1');
      const emit = (frame) => output.push({...frame,session_id});
      const state = (message, value) => {
        if (full) emit({type:'command_lifecycle',command_uuid:message.uuid,state:value});
      };
      const text = (message) => typeof message.message.content === 'string'
        ? message.message.content : message.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const echo = (message) => emit({...message,isReplay:true,origin:{kind:'human'}});
      const assistant = (content) => emit({type:'assistant',uuid:'assistant-'+(++sequence),parent_tool_use_id:null,
        message:{id:'message-'+sequence,role:'assistant',content}});
      const result = (message, content, tokens = 2) => {
        const frame = {type:'result',subtype:'success',result:content,
          uuid:'result-'+(++sequence),user_message_uuid:message.uuid,origin:{kind:'human'},
          usage:{input_tokens:1,output_tokens:tokens,cache_read_input_tokens:0,cache_creation_input_tokens:0},total_cost_usd:0};
        emit(frame);
        if (config.duplicateResults) emit(frame);
      };
      async function gate(stage, id, turn) {
        while (!closed && !turn?.aborted) {
          try { await fs.access(path.join(config.gates,id+'.'+stage)); return true; }
          catch { await sleep(5); }
        }
        return false;
      }
      function start(message) {
        state(message,'queued');
        state(message,'started');
        echo(message);
        emit({type:'system',subtype:'session_state_changed',state:'running'});
      }
      function finish(turn, terminal = 'completed') {
        if (root === turn) root = null;
        if (!turn.rootTerminalSent) {
          turn.rootTerminalSent = true;
          state(turn.message,terminal);
        }
        emit({type:'system',subtype:'session_state_changed',state:'idle'});
        probe({stage:'root_terminal',command_id:turn.message.uuid,state:terminal});
      }
      function consumeChild(child) {
        child.started = true;
        echo(child.message);
        state(child.message,'started');
        probe({stage:'child_executed',command_id:child.message.uuid});
      }
      async function interrupted(turn) {
        finish(turn,'cancelled');
        // An ordinary SDK interrupt does not remove priority:next input.
        // Execute survivors so a helper that ignores the receipt fails tests.
        for (const child of turn.children.filter((item) => !item.cancelled)) {
          consumeChild(child);
          assistant([{type:'text',text:'SURVIVED_STOP '+text(child.message)}]);
          result(child.message,'SURVIVED_STOP');
          state(child.message,'completed');
        }
      }
      async function run(turn) {
        start(turn.message);
        assistant([{type:'tool_use',id:'boundary-'+turn.message.uuid,name:'Read',input:{file_path:'/fixture/tool-boundary'}}]);
        probe({stage:'boundary',command_id:turn.message.uuid});
        if (!await gate('boundary',turn.message.uuid,turn)) {
          if (turn.aborted) await interrupted(turn);
          return;
        }
        emit({type:'user',uuid:'tool-result-'+(++sequence),parent_tool_use_id:null,
          message:{role:'user',content:[{type:'tool_result',tool_use_id:'boundary-'+turn.message.uuid,content:'tool completed'}]}});

        const children = turn.children.filter((child) => !child.cancelled);
        if (['terminal_before_child_result','root_result_before_child'].includes(config.mode) && children.length) {
          if (config.mode === 'root_result_before_child') result(turn.message,'ROOT_RESULT',2);
          turn.rootTerminalSent = true;
          state(turn.message,'completed');
          emit({type:'system',subtype:'session_state_changed',state:'idle'});
          probe({stage:'parent_terminal_sent',command_id:turn.message.uuid});
          if (!await gate('child',turn.message.uuid,turn)) {
            if (turn.aborted) await interrupted(turn);
            return;
          }
          for (const child of children) {
            consumeChild(child);
            assistant([{type:'text',text:'ACK '+text(child.message)}]);
            if (config.mode === 'root_result_before_child') result(child.message,'CHILD_ACK '+text(child.message),7);
            state(child.message,'completed');
          }
          if (root === turn) root = null;
          probe({stage:'child_terminal_sent',command_id:children[0].message.uuid});
          if (config.mode === 'root_result_before_child') return;
          await gate('late_result',turn.message.uuid);
          for (const child of children) result(child.message,'LATE_ACK '+text(child.message),7);
          probe({stage:'late_result_sent',command_id:turn.message.uuid});
          return;
        }

        const refused = config.mode === 'refused_child';
        if (refused) {
          for (const child of children) state(child.message,config.childTerminal);
        } else {
          for (const child of children) consumeChild(child);
        }
        const answer = children.length && !refused ? 'ACK '+children.map((child) => text(child.message)).join(' | ') : 'done '+text(turn.message);
        assistant([{type:'text',text:answer}]);
        if (!refused) for (const child of children) state(child.message,'completed');
        probe({stage:'children_settled',command_id:turn.message.uuid});
        if (!await gate('result',turn.message.uuid,turn)) {
          if (turn.aborted) await interrupted(turn);
          return;
        }
        result(turn.message,answer);
        if (!await gate('terminal',turn.message.uuid,turn)) {
          if (turn.aborted) await interrupted(turn);
          return;
        }
        finish(turn);
      }

      // Independent input pump: deliberately do NOT await run(turn).
      void (async () => {
        emit({type:'system',subtype:'init',capabilities:config.capabilities});
        for await (const message of prompt) {
          if (closed) break;
          probe({stage:'sdk_input',command_id:message.uuid,priority:message.priority,content:text(message)});
          if (root && message.priority === 'next') {
            root.children.push({message,started:false,cancelled:false});
            state(message,'queued');
            continue;
          }
          if (root) {
            probe({stage:'unexpected_overlap',command_id:message.uuid});
            continue;
          }
          const turn = {message,children:[],aborted:false};
          root = turn;
          void run(turn).catch((error) => { probe({stage:'mock_error',error:String(error)}); output.end(); });
        }
      })().catch((error) => { probe({stage:'mock_error',error:String(error)}); output.end(); });

      async function interrupt(cancel_queued) {
        const active = root;
        const survivors = active?.children.filter((child) => !child.started && !child.cancelled) ?? [];
        probe({stage:'interrupt',cancel_queued});
        if (cancel_queued) for (const child of survivors) {
          child.cancelled = true;
          state(child.message,'cancelled');
        }
        if (active) active.aborted = true;
        return {still_queued:cancel_queued ? [] : survivors.map((child) => child.message.uuid),
          ...(cancel_queued ? {cancelled:survivors.map((child) => child.message.uuid)} : {})};
      }
      return {
        [Symbol.asyncIterator]: () => output,
        close() { closed = true; output.end(); },
        interrupt: () => interrupt(false),
        ...(config.controlRequest === false ? {} : {async request(request) {
          if (request.subtype !== 'interrupt') throw new Error('Unexpected mock control '+request.subtype);
          return {subtype:'success',response:await interrupt(request.cancel_queued === true)};
        }}),
        async setModel() {},
        async setPermissionMode() {},
        async reloadPlugins() {},
        async applyFlagSettings() {},
        async getContextUsage() { return {totalTokens:10,maxTokens:200000,percentage:0.005,categories:[]}; },
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {session:{model_usage:{}}}; },
      };
    }
  `;
}

export async function startSteerHelper(t, options = {}, env = {}) {
  const gates = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-steer-gates-'));
  t.after(() => fs.rm(gates, { recursive: true, force: true }));
  const built = await buildHelperWithWireMock({
    sdkContents: streamingSdkSource({
      gates,
      mode: options.mode ?? 'fold',
      capabilities: options.capabilities ?? ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
      duplicateResults: options.duplicateResults ?? false,
      controlRequest: options.controlRequest ?? true,
      childTerminal: options.childTerminal ?? 'refused',
    }),
  });
  const session = { ...spawnTrackedHelper(t, built, env), gates };
  send(session, { type:'init',provider:'claude',env_name:'default',perm_mode:'dev',working_dir:gates });
  await waitForOutput(session, (output) => output.type === 'status' && output.status === 'ready', 'initial ready');
  return session;
}

export async function releaseGate(session, commandId, ...stages) {
  await Promise.all(stages.map((stage) => fs.writeFile(path.join(session.gates, `${commandId}.${stage}`), 'ready')));
}

export async function startRoot(session, commandId = 'root-one') {
  send(session, {type:'prompt',text:'Run the boundary '+commandId,command_id:commandId,client_message_ids:['client-'+commandId]});
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'boundary-'+commandId, 'running root tool boundary');
}

export function steer(session, overrides = {}) {
  send(session, {type:'steer_prompt',text:'STEER_ACK_4729',command_id:'steer-one',expected_command_id:'root-one',
    expected_query_generation:1,client_message_ids:['client-steer-one'],...overrides});
}

export function isProbe(output, stage, commandId) {
  return output.type === 'steer_probe' && output.stage === stage
    && (commandId === undefined || output.command_id === commandId);
}
