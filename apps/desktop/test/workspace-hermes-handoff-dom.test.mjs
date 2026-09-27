import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let harness, temp, dom, root, mountPoint;
let changes, request, actions, current;
const target = { routeId:'route-1', generation:1, accountRef:'account-1', platform:'feishu', label:'My report bot', chatId:'verified-chat', userId:'me', chatType:'dm', handoffReady:true };
const flush = () => harness.act(async()=>{ await new Promise(resolve=>setTimeout(resolve,0)); });
test.before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-hermes-ui-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'NodeFilter', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent', 'HTMLSelectElement', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  // Radix Switch observes its hidden form input; JSDOM has no layout observer.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Match the repo's DOM harness: Node MessageChannel keeps React's scheduler
  // alive after unmount, whereas a browser channel belongs to the page lifetime.
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
  const output = path.join(temp, 'harness.cjs');
  await build({
    stdin: { contents: `import React, {act, useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {WorkspaceHermesBindDialog,WorkspaceHermesSessionBadge} from '@/components/workspace/WorkspaceHermesBindDialog';
      export {act}; export function mount(container, runtime='native-one') { const root=createRoot(container);
        const render=(runtime)=>React.createElement(WorkspaceHermesBindDialog,{open:true,onOpenChange:()=>{},session:{runtime_id:runtime,display_title:runtime,project_dir:'/tmp'},onLegacyOpen:()=>globalThis.__changed('legacy')});
        root.update=(runtime)=>act(()=>root.render(render(runtime)));
        root.update(runtime); return root; }
      export function mountBadge(container) { const root=createRoot(container);
        act(()=>root.render(React.createElement(WorkspaceHermesSessionBadge,{runtimeId:'native-one',dialogOpen:false,onClick:()=>globalThis.__changed('badge')}))); return root; }`,
      loader: 'tsx', resolveDir: desktop },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css':'empty' },
    plugins: [{ name: 'Hermes DOM boundary', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/lib\/nativeSurfaceOcclusion$/ }, () => ({ path: 'occlusion', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/hooks\/useTauriCommands$/ }, () => ({ path: 'hooks', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({ path: 'motion', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/components\/chat-app\/(telegram|wecom|weixin)\// }, (args) => ({ path: args.path.split('/').at(-1), namespace: 'hermes-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'hermes-stub' }, (args) => {
        if (args.path === 'occlusion') return { contents:'export const useNativeSurfaceOcclusion=(open)=>open;',loader:'js' };
        if (args.path === 'ipc') return { contents: 'export const invoke=(name,args)=>globalThis.__hermesInvoke(name,args); export class Channel { constructor(){throw new Error("Unexpected streaming IPC in Hermes DOM test")} }', loader: 'js' };
        if (args.path === 'locale') return { contents: `export function useLocale(){return {lang:'en',t:(key,params={})=>globalThis.__hermesTranslate?.(key,params)??({'hermes.platformWecom':'WeCom','hermes.platformFeishu':'Feishu'}[key]??key)+Object.values(params).map(value=>' '+value).join('')}}`, loader: 'js' };
        if (args.path === 'hooks') return { contents: `const methods={getPlatformCapabilities:async()=>({tmuxSupported:false,tmuxInstalled:false})}; export function useTauriCommands(){return methods}`, loader: 'js' };
        if (args.path === 'motion') return { contents: `export const ccemMotion={};export const clearMotionProps=()=>{};export const getMotionTargets=()=>[];export const gsap={};export const shouldReduceMotion=()=>true;export const useGSAP=()=>{};`, loader: 'js' };
        return { contents: `import React from 'react'; export function ${args.path}(){return React.createElement('div',{'data-legacy-panel':true,'data-legacy-platform':'${args.path}'},'Existing platform')}`, loader: 'js', resolveDir: desktop };
      });
      builder.onResolve({ filter: /^@\// }, async (args) => {
        const base = path.join(desktop, 'src', args.path.slice(2));
        for (const suffix of ['', '.ts', '.tsx', '/index.tsx']) {
          try { if ((await fs.stat(base + suffix)).isFile()) return { path: base + suffix }; } catch {}
        }
        return { errors: [{ text: `Missing source ${args.path}` }] };
      });
    } }],
  });
  harness = require(output);
});

const binding = {id:'grant-one',runtimeId:'native-one',routeId:'route-1',generation:1,title:'Current session',modelEnv:'api-one',model:'claude-test',lastDecision:null,error:null};
const initial = () => ({binding:null,bindingValid:false,deliveryStatus:null,targets:[target],models:[{envName:'api-one',model:'claude-test'}],defaultModelEnv:'api-one'});
test.beforeEach(() => {
  changes=[];actions=[];current=initial();
  request=async(action)=>{
    if(action==='bindSession')current={...current,binding,bindingValid:true,deliveryStatus:'pending'};
    if(action==='detachSession')current={...current,binding:null,bindingValid:false,deliveryStatus:null};
    return current;
  };
  globalThis.__hermesInvoke=async(name,args)=>{assert.equal(name,'hermes_action'); actions.push(args);return request(args.action,args.payload);};
  globalThis.__changed=(v)=>changes.push(v);
  mountPoint=document.createElement('main');document.body.append(mountPoint);
});
test.afterEach(async()=>{if(root) await harness.act(async()=>root.unmount());root=null;document.body.innerHTML='';});
test.after(async()=>{dom.window.close();stopEsbuild();await fs.rm(temp,{recursive:true,force:true});});
const button=(key)=>[...document.querySelectorAll('button')].find(el=>el.textContent===key);
async function click(key){assert.ok(button(key),key);await harness.act(async()=>button(key).click());await flush();}
async function choose(selector,text){
 await harness.act(async()=>{const el=document.querySelector(selector);el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));});await flush();
 const item=[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes(text));assert.ok(item,text);
 await harness.act(async()=>{item.focus();item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});await flush();
}
test('attaches the current session to a paired channel and detaches the exact grant',async()=>{
 root=harness.mount(mountPoint);await flush();
 assert.equal(button('workspace.hermesHandoffStart').disabled,false);
 await click('workspace.hermesHandoffStart');
 assert.deepEqual(actions.find(a=>a.action==='bindSession').payload,{runtimeId:'native-one',routeId:'route-1',generation:1,modelEnv:'api-one'});
 assert.match(document.querySelector('[data-hermes-current-binding]').textContent,/My report bot/);
 assert.equal(button('workspace.hermesHandoffChange').disabled,true);
 await click('workspace.hermesHandoffDetach');
 assert.deepEqual(actions.find(a=>a.action==='detachSession').payload,{runtimeId:'native-one',bindingId:'grant-one'});
 assert.equal(document.querySelector('[data-hermes-current-binding]'),null);
});
test('requires an explicit model when the current environment is not compatible',async()=>{
 current.defaultModelEnv='official';root=harness.mount(mountPoint);await flush();
 assert.equal(button('workspace.hermesHandoffStart').disabled,true);
 await choose('#hermes-handoff-model','api-one');
 assert.equal(button('workspace.hermesHandoffStart').disabled,false);
});
test('keeps revoked binding visible and never auto selects its new generation',async()=>{
 current={...initial(),binding,bindingValid:false,targets:[{...target,generation:2}]};
 root=harness.mount(mountPoint);await flush();
 assert.match(document.body.textContent,/workspace.hermesHandoffRevoked/);
 assert.equal(button('workspace.hermesHandoffChange').disabled,true);
 await choose('#hermes-handoff-target','My report bot');
 assert.equal(button('workspace.hermesHandoffChange').disabled,false);
});
test('failed detach preserves active binding and the original grant',async()=>{
 current={...initial(),binding,bindingValid:true};request=async(action)=>{if(action==='detachSession')throw Error('offline');return current;};
 root=harness.mount(mountPoint);await flush();await click('workspace.hermesHandoffDetach');
 assert.ok(document.querySelector('[data-hermes-current-binding]'));
 assert.match(document.querySelector('[role=alert]').textContent,/workspace.hermesHandoffError/);
});
test('late response for a different session cannot enable a stale handoff',async()=>{
 let resolveOld;request=async(action,payload)=>payload.runtimeId==='native-one'?new Promise(r=>{resolveOld=r}):{...initial(),targets:[]};
 root=harness.mount(mountPoint);await flush();root.update('native-two');await flush();
 await harness.act(async()=>resolveOld(initial()));await flush();
 assert.equal(button('workspace.hermesHandoffStart').disabled,true);
 assert.match(document.body.textContent,/cron.hermesNoTargets/);
});
test('offline runtime blocks new handoff and legacy task card remains reachable',async()=>{
 current.targets=[{...target,handoffReady:false}];root=harness.mount(mountPoint);await flush();
 assert.equal(button('workspace.hermesHandoffStart').disabled,true);
 await click('workspace.hermesHandoffLegacy');assert.deepEqual(changes,['legacy']);
});
test('polling never overlaps an unresolved status request',async()=>{
 const original=window.setInterval;let tick;
 window.setInterval=(cb)=>{tick=cb;return 123456;};
 try {
  root=harness.mount(mountPoint);await flush();
  let resolvePoll;request=()=>new Promise(resolve=>{resolvePoll=resolve;});
  await harness.act(async()=>{tick();tick();});await flush();
  assert.equal(actions.length,2);
  await harness.act(async()=>resolvePoll({...initial(),binding,bindingValid:true}));await flush();
  assert.ok(document.querySelector('[data-hermes-current-binding]'));
 } finally {window.setInterval=original;}
});
test('manual refresh preserves the unsaved recipient and model, including after a failed read',async()=>{
 current={...initial(),binding,bindingValid:true,
  targets:[target,{...target,routeId:'route-2',label:'Second bot'}],
  models:[...initial().models,{envName:'api-two',model:'other-model'}]};
 root=harness.mount(mountPoint);await flush();
 await choose('#hermes-handoff-target','Second bot');await choose('#hermes-handoff-model','api-two');
 const refresh=()=>harness.act(async()=>document.querySelector('[aria-label="cron.hermesRefresh"]').click());
 await refresh();await flush();
 assert.match(document.querySelector('#hermes-handoff-target').textContent,/Second bot/);
 assert.match(document.querySelector('#hermes-handoff-model').textContent,/api-two/);
 request=async()=>{throw Error('offline');};await refresh();await flush();
 assert.match(document.querySelector('#hermes-handoff-target').textContent,/Second bot/);
 assert.match(document.querySelector('#hermes-handoff-model').textContent,/api-two/);
 request=async()=>current;await click('workspace.hermesHandoffChange');
 assert.deepEqual(actions.find(a=>a.action==='bindSession').payload,{runtimeId:'native-one',routeId:'route-2',generation:1,modelEnv:'api-two'});
});
test('pairing and model removal require explicit reselection without discarding the other draft field',async()=>{
 const original=window.setInterval;let tick;window.setInterval=(cb)=>{tick=cb;return 123456;};
 try {
  root=harness.mount(mountPoint);await flush();
  current={...initial(),targets:[{...target,generation:2}]};
  await harness.act(async()=>tick());await flush();
  assert.equal(button('workspace.hermesHandoffStart').disabled,true);
  assert.match(document.body.textContent,/cron.hermesStaleTarget/);
  assert.match(document.querySelector('#hermes-handoff-target').textContent,/workspace.hermesHandoffChoose/);
  assert.match(document.querySelector('#hermes-handoff-model').textContent,/api-one/);
  await choose('#hermes-handoff-target','My report bot');
  assert.equal(button('workspace.hermesHandoffStart').disabled,false);
  current={...current,models:[{envName:'api-two',model:'other-model'}]};
  await harness.act(async()=>tick());await flush();
  assert.equal(button('workspace.hermesHandoffStart').disabled,true);
  assert.match(document.body.textContent,/workspace.hermesHandoffModelUnavailable/);
  assert.match(document.querySelector('#hermes-handoff-model').textContent,/workspace.hermesHandoffChooseModel/);
  await choose('#hermes-handoff-model','api-two');
  assert.equal(button('workspace.hermesHandoffStart').disabled,false);
 } finally {window.setInterval=original;}
});
test('recovery by polling initializes once and later refresh preserves the edited model',async()=>{
 const original=window.setInterval;let tick;window.setInterval=(cb)=>{tick=cb;return 123456;};
 try {
  request=async()=>{throw Error('first read failed');};
  root=harness.mount(mountPoint);await flush();
  assert.ok(document.querySelector('[role=alert]'));
  current={...initial(),models:[...initial().models,{envName:'api-two',model:'other-model'}]};
  request=async()=>current;await harness.act(async()=>tick());await flush();
  assert.equal(document.querySelector('[role=alert]'),null);
  assert.equal(button('workspace.hermesHandoffStart').disabled,false);
  await choose('#hermes-handoff-model','api-two');
  await harness.act(async()=>document.querySelector('[aria-label="cron.hermesRefresh"]').click());await flush();
  assert.match(document.querySelector('#hermes-handoff-model').textContent,/api-two/);
 } finally {window.setInterval=original;}
});
test('a changed model in the same API environment can update the handoff',async()=>{
 current={...initial(),binding,bindingValid:true,models:[{envName:'api-one',model:'replacement-model'}]};
 request=async(action)=>{if(action==='bindSession')current={...current,binding:{...binding,model:'replacement-model'}};return current;};
 root=harness.mount(mountPoint);await flush();
 assert.equal(button('workspace.hermesHandoffChange').disabled,false);
 await click('workspace.hermesHandoffChange');
 assert.equal(actions.filter(a=>a.action==='bindSession').length,1);
 assert.equal(button('workspace.hermesHandoffChange').disabled,true);
});
test('composer badge surfaces model errors, offline bots and unknown delivery then recovers',async()=>{
 const original=window.setInterval;let tick;window.setInterval=(cb)=>{tick=cb;return 123456;};
 try {
  current={...initial(),binding:{...binding,error:'model_request_failed'},bindingValid:true};
  root=harness.mountBadge(mountPoint);await flush();
  const badge=()=>document.querySelector('[data-hermes-session-badge]');
  assert.match(badge().textContent,/workspace.hermesHandoffNeedsAttention/);
  assert.equal(badge().title,'workspace.hermesHandoffModelError');
  await harness.act(async()=>badge().click());assert.deepEqual(changes,['badge']);
  current={...current,binding,targets:[{...target,handoffReady:false}]};
  await harness.act(async()=>tick());await flush();
  assert.equal(badge().title,'workspace.hermesHandoffNotReady');
  current={...current,targets:[target],deliveryStatus:'unknown'};
  await harness.act(async()=>tick());await flush();
  assert.equal(badge().title,'cron.hermesDelivery_unknown');
  current={...current,deliveryStatus:'sent'};
  await harness.act(async()=>tick());await flush();
  assert.equal(badge().title,'workspace.hermesHandoffActive');
  assert.match(badge().textContent,/My report bot/);
  assert.doesNotMatch(badge().textContent,/workspace.hermesHandoffNeedsAttention/);
 } finally {window.setInterval=original;}
});
