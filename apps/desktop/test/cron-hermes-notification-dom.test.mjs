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
let changes, request;
const target = { routeId:'route-1', generation:1, accountRef:'account-1', platform:'feishu', label:'My report bot', chatId:'verified-chat', userId:'me', chatType:'dm' };
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
      import {HermesNotificationPicker} from '@/components/cron/HermesNotificationPicker';
      export {act}; export function mount(container, initial=null) { const root=createRoot(container);
        function Controlled(){ const [value,setValue]=useState(initial); return React.createElement(HermesNotificationPicker,{value,onChange:(v)=>{globalThis.__changed(v);setValue(v)}}); }
        act(()=>root.render(React.createElement(Controlled))); return root; }`,
      loader: 'tsx', resolveDir: desktop },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css':'empty' },
    plugins: [{ name: 'Hermes DOM boundary', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/hooks\/useTauriCommands$/ }, () => ({ path: 'hooks', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({ path: 'motion', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/components\/chat-app\/(telegram|wecom|weixin)\// }, (args) => ({ path: args.path.split('/').at(-1), namespace: 'hermes-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'hermes-stub' }, (args) => {
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

test.beforeEach(() => {
  changes=[];
  request=async()=>[target];
  globalThis.__hermesInvoke=async(name)=>{assert.equal(name,'hermes_notification_targets'); return request();};
  globalThis.__changed=(v)=>changes.push(v);
  mountPoint=document.createElement('main');document.body.append(mountPoint);
});
test.afterEach(async()=>{if(root) await harness.act(async()=>root.unmount());root=null;document.body.innerHTML='';});
test.after(async()=>{dom.window.close();stopEsbuild();await fs.rm(temp,{recursive:true,force:true});});
async function openPicker(){
 await harness.act(async()=>{const button=document.querySelector('[role=combobox]');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));});
 await flush();
}
async function choose(text){
 const item=[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes(text));
 assert.ok(item,`Missing option ${text}`);
 await harness.act(async()=>{item.focus();item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
 await flush();
}
test('chooses a paired bot without any workspace field and can turn delivery off',async()=>{
 root=harness.mount(mountPoint);await flush();
 await openPicker();await choose('My report bot');
 assert.deepEqual(changes,[{routeId:'route-1',generation:1}]);
 assert.match(document.querySelector('[role=combobox]').textContent,/My report bot/);
 await openPicker();await choose('cron.hermesOff');
 assert.equal(changes.at(-1),null);
});
test('preserves a stale saved target instead of silently selecting another bot',async()=>{
 root=harness.mount(mountPoint,{routeId:'route-1',generation:0,subscriptionId:'old-grant'});await flush();
 assert.match(document.body.textContent,/cron.hermesStaleTarget/);
 assert.equal(changes.length,0);
 await openPicker();await choose('My report bot');
 assert.deepEqual(changes,[{routeId:'route-1',generation:1}]);
});
test('load failure retains selection, and refresh recovers without granting notification',async()=>{
 request=async()=>{throw new Error('offline');};
 root=harness.mount(mountPoint,{routeId:'route-1',generation:1,subscriptionId:'grant'});await flush();
 assert.match(document.body.textContent,/cron.hermesLoadFailed/);assert.equal(changes.length,0);
 request=async()=>[target];
 await harness.act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='cron.hermesRefresh').click());await flush();
 assert.match(document.querySelector('[role=combobox]').textContent,/My report bot/);assert.equal(changes.length,0);
});
test('empty pairing list gives a usable off option and a pairing entry hint',async()=>{
 request=async()=>[];root=harness.mount(mountPoint);await flush();
 assert.match(document.body.textContent,/cron.hermesNoTargets/);
 await openPicker();assert.equal(document.querySelectorAll('[role=option]').length,1);
});
