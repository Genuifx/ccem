import { ccemMotion, gsap, shouldReduceMotion } from '@/lib/gsapMotion';

/**
 * Container transform between the centered compose card and the live
 * session's bottom-docked composer. The compose view unmounts in the same
 * commit the live view mounts, so the source card is snapshotted (cloned)
 * before the switch and morphed onto the target card's box afterwards.
 */
interface LaunchSource {
  runtimeId: string;
  card: HTMLElement;
  cardRect: DOMRect;
  heading: HTMLElement | null;
  headingRect: DOMRect | null;
  capturedAt: number;
}

const LAUNCH_SOURCE_MAX_AGE_MS = 1500;
const SHELL_CARD_SELECTOR = '[data-composer-shell-card]';

let pendingSource: LaunchSource | null = null;

/** Snapshots the compose card (and its heading) right before the view switches to live. */
export function captureComposerLaunchSource(
  root: HTMLElement | null,
  runtimeId: string,
): void {
  pendingSource = null;
  const card = root?.querySelector<HTMLElement>(SHELL_CARD_SELECTOR);
  if (!card || shouldReduceMotion()) {
    return;
  }
  const heading = root?.querySelector<HTMLElement>('[data-compose-heading]') ?? null;
  pendingSource = {
    runtimeId,
    card: card.cloneNode(true) as HTMLElement,
    cardRect: card.getBoundingClientRect(),
    heading: heading ? (heading.cloneNode(true) as HTMLElement) : null,
    headingRect: heading?.getBoundingClientRect() ?? null,
    capturedAt: performance.now(),
  };
}

function placeGhost(node: HTMLElement, rect: DOMRect): HTMLElement {
  node.removeAttribute('data-composer-shell-card');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('inert', '');
  Object.assign(node.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '60',
  });
  document.body.appendChild(node);
  return node;
}

/**
 * Plays the morph onto the live composer under `root` when a fresh capture
 * exists for this runtime. The ghost owns its own teardown: it is detached
 * from React, so an effect re-run (StrictMode, visibility flap) must not cut
 * the motion short.
 */
export function playComposerLaunchTransition(
  root: HTMLElement | null,
  runtimeId: string,
): void {
  const source = pendingSource;
  if (!source || source.runtimeId !== runtimeId) {
    return;
  }
  pendingSource = null;
  const target = root?.querySelector<HTMLElement>(SHELL_CARD_SELECTOR);
  if (!target || performance.now() - source.capturedAt > LAUNCH_SOURCE_MAX_AGE_MS) {
    return;
  }
  const to = target.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) {
    return;
  }

  const duration = ccemMotion.duration.handoff;
  const ghost = placeGhost(source.card, source.cardRect);
  ghost.style.overflow = 'hidden';
  const ghostContent = Array.from(ghost.children) as HTMLElement[];
  const heading = source.heading && source.headingRect
    ? placeGhost(source.heading, source.headingRect)
    : null;

  const timeline = gsap.timeline({
    onComplete: () => {
      gsap.set(target, { clearProps: 'opacity' });
      ghost.remove();
      heading?.remove();
    },
  });
  timeline
    .set(target, { opacity: 0 })
    .to(ghost, {
      left: to.left,
      top: to.top,
      width: to.width,
      height: to.height,
      duration,
      ease: 'power3.inOut',
    }, 0)
    .to(ghostContent, { opacity: 0, duration: duration * 0.35, ease: ccemMotion.ease.soft }, 0)
    .to(target, { opacity: 1, duration: ccemMotion.duration.quick, ease: ccemMotion.ease.soft }, duration * 0.8)
    .to(ghost, { opacity: 0, duration: ccemMotion.duration.quick, ease: ccemMotion.ease.soft }, duration * 0.85);
  if (heading) {
    timeline.to(heading, { opacity: 0, y: -12, duration: duration * 0.5, ease: ccemMotion.ease.soft }, 0);
  }
}
