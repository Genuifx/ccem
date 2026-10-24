import { ccemMotion, gsap, shouldReduceMotion } from '@/lib/gsapMotion';

export interface QueuePresenceRow<T extends { id: string }> {
  message: T;
  leaving: boolean;
}

/**
 * Merges the live queue into the rendered rows. Rows that disappeared stay in
 * place, flagged `leaving`, until their exit motion reports completion.
 */
export function mergeQueuePresenceRows<T extends { id: string }>(
  previous: QueuePresenceRow<T>[],
  next: T[],
): QueuePresenceRow<T>[] {
  const nextIds = new Set(next.map((message) => message.id));
  const merged: QueuePresenceRow<T>[] = next.map((message) => ({ message, leaving: false }));
  previous.forEach((row, index) => {
    if (!nextIds.has(row.message.id)) {
      merged.splice(Math.min(index, merged.length), 0, row.leaving ? row : { ...row, leaving: true });
    }
  });

  const unchanged = merged.length === previous.length
    && merged.every((row, index) => (
      row.message === previous[index].message && row.leaving === previous[index].leaving
    ));
  return unchanged ? previous : merged;
}

export interface QueueFlightSource {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  color: string;
  capturedAt: number;
}

/** How long a captured submit may wait for its queue row to appear. */
const QUEUE_FLIGHT_MAX_AGE_MS = 2000;

/** Records where the submitted text sits in the editor, before it is cleared. */
export function captureQueueFlightSource(
  shell: HTMLElement | null,
  text: string,
): QueueFlightSource | null {
  const firstLine = text.trim().split('\n')[0]?.trim();
  const editor = shell?.querySelector<HTMLElement>('.prompt-area-editor');
  if (!firstLine || !editor || typeof document === 'undefined') {
    return null;
  }
  const editorRect = editor.getBoundingClientRect();
  let lineRect: DOMRect | null = null;
  try {
    const range = document.createRange();
    range.selectNodeContents(editor);
    lineRect = range.getClientRects()[0] ?? null;
  } catch {
    lineRect = null;
  }
  const style = getComputedStyle(editor);
  const left = lineRect?.left ?? editorRect.left;
  const top = lineRect?.top ?? editorRect.top;
  return {
    text: firstLine,
    left,
    top,
    width: Math.max(80, editorRect.right - left),
    height: lineRect?.height ?? (parseFloat(style.lineHeight) || 20),
    fontSize: parseFloat(style.fontSize) || 14,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    color: style.color,
    capturedAt: performance.now(),
  };
}

export function isQueueFlightFresh(source: QueueFlightSource | null): source is QueueFlightSource {
  return source != null && performance.now() - source.capturedAt <= QUEUE_FLIGHT_MAX_AGE_MS;
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

/** Keeps a newly entered row in view while its height grows. */
function revealRow(row: HTMLElement) {
  const scroller = row.closest<HTMLElement>('[data-composer-attention-scroll]');
  if (!scroller) {
    return;
  }
  const rowRect = row.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  if (rowRect.bottom > scrollerRect.bottom) {
    scroller.scrollTop += rowRect.bottom - scrollerRect.bottom;
  } else if (rowRect.top < scrollerRect.top) {
    scroller.scrollTop -= scrollerRect.top - rowRect.top;
  }
}

/** Expands a new row from zero height, keeping it scrolled into view. */
export function animateQueueRowEnter(row: HTMLElement, { highlight }: { highlight: boolean }) {
  if (shouldReduceMotion()) {
    revealRow(row);
    return;
  }
  const height = row.offsetHeight;
  gsap.killTweensOf(row);
  gsap.fromTo(
    row,
    { height: 0, autoAlpha: 0 },
    {
      height,
      autoAlpha: 1,
      duration: ccemMotion.duration.base,
      ease: ccemMotion.ease.standard,
      clearProps: 'height,opacity,visibility',
      onUpdate: () => revealRow(row),
      onComplete: () => revealRow(row),
    },
  );
  if (highlight) {
    // CSS owns the tint: GSAP's color parser cannot read `var(--token)` colors.
    row.style.transition = 'none';
    row.style.backgroundColor = 'hsl(var(--primary) / 0.10)';
    window.setTimeout(() => {
      row.style.transition = 'background-color 1.1s ease-out';
      row.style.backgroundColor = '';
      window.setTimeout(() => {
        row.style.transition = '';
      }, 1150);
    }, 380);
  }
}

/** Collapses a dispatched or cancelled row before it unmounts. */
export function animateQueueRowLeave(row: HTMLElement, onComplete: () => void) {
  if (shouldReduceMotion()) {
    onComplete();
    return () => {};
  }
  gsap.killTweensOf(row);
  const duration = ccemMotion.duration.quick + 0.04;
  let finished = false;
  let tween: gsap.core.Tween | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(deadline);
    tween?.kill();
    onComplete();
  };
  // Native webviews can suspend animation frames while backgrounded. Queue
  // ownership has already changed, so removing its row cannot wait on rAF.
  const deadline = window.setTimeout(finish, duration * 1000 + 100);
  tween = gsap.to(row, {
    height: 0,
    autoAlpha: 0,
    x: -6,
    duration,
    ease: ccemMotion.ease.soft,
    onComplete: finish,
  });
  return () => {
    finished = true;
    window.clearTimeout(deadline);
    tween?.kill();
  };
}

/**
 * Flies a copy of the submitted first line from the editor into the queue
 * row's text, tracking the row live so dock entry and row growth stay in sync.
 */
export function runQueueFlight(source: QueueFlightSource, targetText: HTMLElement) {
  if (shouldReduceMotion() || typeof document === 'undefined') {
    return;
  }
  const targetStyle = getComputedStyle(targetText);
  const targetFontSize = parseFloat(targetStyle.fontSize) || 12;

  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.dataset.ccemQueueFlight = '';
  ghost.textContent = source.text;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    margin: '0',
    zIndex: '80',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontFamily: source.fontFamily,
    fontWeight: source.fontWeight,
    color: source.color,
    lineHeight: `${source.height}px`,
    willChange: 'transform, opacity',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ghost);
  gsap.set(targetText, { opacity: 0 });

  const state = { progress: 0 };
  const paint = () => {
    const progress = state.progress;
    const target = targetText.getBoundingClientRect();
    const fontSize = lerp(source.fontSize, targetFontSize, progress);
    const lineHeight = lerp(source.height, target.height || source.height, progress);
    // A shallow arc reads as "lifting" into the dock instead of sliding.
    const lift = Math.sin(progress * Math.PI) * 10;
    ghost.style.fontSize = `${fontSize}px`;
    ghost.style.lineHeight = `${lineHeight}px`;
    ghost.style.width = `${lerp(source.width, target.width, progress)}px`;
    ghost.style.transform = `translate3d(${lerp(source.left, target.left, progress)}px, ${
      lerp(source.top, target.top, progress) - lift
    }px, 0)`;
    const crossfade = Math.max(0, (progress - 0.72) / 0.28);
    ghost.style.opacity = String(1 - crossfade);
    targetText.style.opacity = String(crossfade);
  };
  paint();
  gsap.to(state, {
    progress: 1,
    duration: ccemMotion.duration.handoff,
    ease: 'power3.inOut',
    onUpdate: paint,
    onComplete: () => {
      ghost.remove();
      gsap.set(targetText, { clearProps: 'opacity' });
    },
    onInterrupt: () => {
      ghost.remove();
      gsap.set(targetText, { clearProps: 'opacity' });
    },
  });
}
