// Import through the exact worktree's Tauri MCP webview and call run().
// This proves React lifecycle + actual AppKit routing, NOT physical gestures.
export async function run() {
  const api = window.__overlaySmoke;
  if (!api) throw new Error('Open /test/native-overlay-smoke.html first');
  const receipts = [];
  const check = (condition, label, evidence) => {
    if (!condition) throw new Error(`${label}: ${JSON.stringify(evidence)}`);
    receipts.push({ label, evidence });
  };
  const wait = async (predicate, label, timeout = 5000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const click = id => { const node = document.getElementById(id); if (!node) throw new Error(`Missing ${id}`); node.click(); };
  const point = () => { const b = api.bounds(); return [b.x + b.width * .75, b.y + b.height * .75]; };
  const probe = (p = point()) => api.call('probe', { point: p });
  const modal = value => wait(async () => { const p = await probe(); return p.policy.modal === value && p; }, `modal=${value}`);
  const state = async () => { const status = await api.call('status'); return { ...status, page: JSON.parse(status.title) }; };
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (!document.querySelector('#smoke-start').disabled) {
    click('smoke-start');
    await wait(() => document.querySelector('#smoke-start').disabled, 'CEF ready', 30000);
  }
  await modal(false);
  const baseline = await state();
  await api.call('focus');
  check(!(await probe()).hitMain, 'uncovered browser receives native hit', await probe());

  click('smoke-dialog');
  await wait(() => document.querySelector('#smoke-dialog-content'), 'dialog open');
  const opened = await modal(true);
  check(opened.hitMain && !opened.firstResponder?.includes('RenderWidget'), 'dialog owns native hit and focus', opened);
  await api.call('show');
  check((await probe()).hitMain, 'ordinary show cannot unlock modal browser', await probe());
  click('smoke-nested');
  await wait(() => document.querySelector('#smoke-nested-content'), 'nested dialog open');
  click('smoke-nested-close');
  await wait(() => !document.querySelector('#smoke-nested-content'), 'nested dialog close');
  check((await probe()).policy.modal, 'closing nested dialog keeps parent barrier', await probe());
  click('smoke-dialog-close');
  const restored = await modal(false);
  check(!restored.hitMain && restored.firstResponder?.includes('RenderWidget'), 'last dialog restores browser routing and captured focus', restored);

  click('smoke-review');
  await wait(() => document.querySelector('#workspace-review-popover'), 'review open');
  check((await modal(true)).hitMain, 'production review blocks native browser input', await probe());
  escape();
  await modal(false);

  click('smoke-popover');
  const popover = await wait(() => document.querySelector('#smoke-popover-content'), 'popover open');
  await wait(async () => (await probe()).policy.regions > 0, 'popover geometry');
  const rect = popover.getBoundingClientRect();
  const zoom = api.zoom();
  const inside = [(rect.left + rect.width * .75) * zoom, (rect.top + rect.height / 2) * zoom];
  check((await probe(inside)).hitMain && !(await probe()).hitMain, 'partial overlay splits native input by bounds', { inside: await probe(inside), outside: await probe() });
  const outside = point();
  await window.__TAURI__.event.emit('browser_overlay_pointer_down', { x: outside[0], y: outside[1], button: 0 });
  await wait(() => !document.querySelector('#smoke-popover-content'), 'native outside notification dismisses popover');
  check(true, 'outside notification dismisses actual Radix popover', { visible: (await state()).visible });

  for (const command of ['zoom_out', 'zoom_reset']) {
    window.dispatchEvent(new CustomEvent('ccem-zoom-command', { detail: { command } }));
    await wait(() => api.zoom() === (command === 'zoom_out' ? .9 : 1), command);
    await new Promise(resolve => setTimeout(resolve, 100));
    click('smoke-dialog');
    await wait(() => document.querySelector('#smoke-dialog-content'), 'zoomed dialog');
    check((await modal(true)).hitMain, `native overlay input after ${command}`, { zoom: api.zoom(), native: await probe() });
    click('smoke-dialog-close');
    await modal(false);
  }
  click('smoke-hide');
  await wait(async () => !(await state()).visible, 'inactive browser hidden');
  check((await probe()).hitMain, 'hidden browser no longer receives native input', await probe());
  click('smoke-hide');
  await wait(async () => (await state()).visible, 'browser restored');
  const final = await state();
  check(final.page.boot === baseline.page.boot && final.page.ticks > baseline.page.ticks && final.visible,
    'all overlays retain one continuously running CEF page', { before: baseline, after: final });
  click('smoke-close');
  await wait(() => !document.querySelector('#smoke-start').disabled, 'CEF close acknowledged');
  check((await probe()).hitMain, 'closing CEF immediately releases its native hit region', await probe());
  return { status: 'passed', harness: location.search.includes('timers') ? 'timer-driven-hidden-WK' : 'normal-animation-frames',
    physicalGesturesVerified: false, compositorVerified: false, receipts };
}
