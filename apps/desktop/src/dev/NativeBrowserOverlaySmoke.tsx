// Vite-only test entry; not imported by the production app. Native commands are
// additionally gated by debug_assertions and CCEM_REACT_OVERLAY_SMOKE=1.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { WorkspaceReviewPopover } from '@/components/workspace/WorkspaceReviewPopover';
import { workspaceReviewTriggerRef } from '@/components/workspace/workspaceReviewAnchor';
import { buildWorkspaceReviewModel } from '@/components/workspace/workspaceReview';
import { initializeNativeBrowserOverlays, useNativeBrowserBackdropRef, useNativeBrowserViewport, waitForNativeBrowserModalSync } from '@/lib/nativeBrowserOverlay';
import { useNativeSurfaceOcclusionParticipant } from '@/lib/nativeSurfaceOcclusion';
import { initializeWebcontentRecovery, invokeBrowserCommand } from '@/lib/webcontentRecovery';
import { readAppZoom, useZoom } from '@/hooks/useZoom';
import { LocaleProvider } from '@/locales';
import type { NativeSessionSummary } from '@/lib/tauri-ipc';
import '@/index.css';

const call = (action: string, args: Record<string, unknown> = {}) => invokeBrowserCommand('browser_overlay_debug', { action, ...args });
const session: NativeSessionSummary = {
  runtime_id: 'overlay-smoke-fixture', provider: 'claude', transport: 'native_sdk',
  project_dir: '/overlay-smoke-fixture', env_name: 'official', perm_mode: 'acceptEdits',
  status: 'ready', created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
  is_active: true, can_handoff_to_terminal: false,
};
const model = buildWorkspaceReviewModel({ session, events: [], messages: [] });

function Smoke() {
  useZoom();
  const frame = useRef<HTMLDivElement>(null);
  const backdrop = useNativeBrowserBackdropRef<HTMLDivElement>();
  const [started, setStarted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [nested, setNested] = useState(false);
  const [review, setReview] = useState(false);
  const [result, setResult] = useState('尚未启动');
  useNativeBrowserViewport(frame, started && visible);
  const bounds = useCallback(() => {
    const rect = frame.current!.getBoundingClientRect();
    const zoom = readAppZoom();
    return { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
  }, []);
  useNativeSurfaceOcclusionParticipant({
    hide: async () => { if (started) { await waitForNativeBrowserModalSync(); await call('occlude'); } },
    restore: async () => { if (started) await call(visible ? 'show' : 'hide'); },
  });
  useEffect(() => {
    Object.assign(window, { __overlaySmoke: { call, bounds, zoom: readAppZoom } });
    if (!started) return;
    const sync = () => { void call('resize', { bounds: bounds() }).catch(console.error); };
    const observer = new ResizeObserver(sync);
    observer.observe(frame.current!);
    window.addEventListener('ccem-zoom-change', sync);
    return () => { observer.disconnect(); window.removeEventListener('ccem-zoom-change', sync); };
  }, [started, bounds]);
  const run = async (action: string) => {
    try {
      const value = await call(action, { bounds: bounds() });
      if (action === 'start') setStarted(true);
      if (action === 'close') setStarted(false);
      setResult(JSON.stringify(value, null, 2));
    } catch (error) { setResult(String(error)); }
  };
  return <div ref={backdrop} className="app-content-shell relative h-screen overflow-hidden p-10">
    <div className="relative z-10 flex flex-wrap gap-3">
      <Button id="smoke-start" onClick={() => void run('start')} disabled={started}>启动 CEF</Button>
      <Button id="smoke-dialog" onClick={() => setDialog(true)}>全局弹框</Button>
      <Button id="smoke-review" ref={workspaceReviewTriggerRef} onClick={() => setReview(true)}>审查</Button>
      <Popover><PopoverTrigger asChild><Button id="smoke-popover">局部浮层</Button></PopoverTrigger>
        <PopoverContent id="smoke-popover-content" side="bottom" align="start" sideOffset={140}><input id="smoke-popover-input" placeholder="浮层输入" className="border p-2" /></PopoverContent>
      </Popover>
      <DropdownMenu><DropdownMenuTrigger asChild><Button id="smoke-menu">菜单</Button></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem onSelect={() => setResult('menu-selected')}>选择成功</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
      <Button id="smoke-toast" onClick={() => toast('React toast', { duration: 5000 })}>通知</Button>
      <Button id="smoke-hide" onClick={async () => { await call(visible ? 'hide' : 'show'); setVisible(!visible); }}>切换浏览器</Button>
      <Button id="smoke-status" onClick={() => void run('status')}>读取状态</Button>
      <Button id="smoke-close" onClick={() => void run('close')}>关闭 CEF</Button>
    </div>
    <pre id="smoke-result" className="relative z-10 mt-6 max-w-[38%] overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
    <section className="workspace-browser-panel absolute bottom-5 right-5 top-36 w-[58%] border border-border bg-card">
      <div className="bg-card p-3">原生 CEF 网页</div>
      <div ref={frame} data-ccem-browser-frame="true" className="absolute inset-x-0 bottom-0 top-12" style={{ visibility: visible ? 'visible' : 'hidden' }} />
    </section>
    <WorkspaceReviewPopover session={session} model={model} isOpen={review} isRefreshingGit={false}
      onOpenChange={setReview} onRefreshGit={() => {}} onLoadDiff={async () => { throw new Error('No fixture diff'); }} />
    <Dialog open={dialog} onOpenChange={setDialog}><DialogContent id="smoke-dialog-content">
      <DialogHeader><DialogTitle>全局 React 弹框</DialogTitle><DialogDescription>网页应保持显示且计时继续。</DialogDescription></DialogHeader>
      <input id="smoke-dialog-input" placeholder="弹框输入" className="border p-2" />
      <Button id="smoke-nested" onClick={() => setNested(true)}>嵌套弹框</Button>
      <Button id="smoke-dialog-close" onClick={() => setDialog(false)}>关闭弹框</Button>
      <Dialog open={nested} onOpenChange={setNested}><DialogContent id="smoke-nested-content"><DialogHeader><DialogTitle>嵌套弹框</DialogTitle><DialogDescription>关闭后父弹框仍阻挡网页输入。</DialogDescription></DialogHeader><Button id="smoke-nested-close" onClick={() => setNested(false)}>关闭内层</Button></DialogContent></Dialog>
    </DialogContent></Dialog>
    <Toaster />
  </div>;
}

if (import.meta.env.DEV) {
  void initializeWebcontentRecovery().then(initializeNativeBrowserOverlays).then(() => {
    createRoot(document.getElementById('root')!).render(<React.StrictMode><LocaleProvider><Smoke /></LocaleProvider></React.StrictMode>);
  });
}
