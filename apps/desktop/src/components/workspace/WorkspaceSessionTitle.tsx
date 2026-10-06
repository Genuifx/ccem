import { memo, useRef } from 'react';
import { ccemMotion, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { cn } from '@/lib/utils';

/** Keeps the row's geometry stable while its provisional title is replaced. */
export const WorkspaceSessionTitle = memo(function WorkspaceSessionTitle({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const outgoingRef = useRef<HTMLSpanElement>(null);
  const previousTitleRef = useRef(title);

  useGSAP(() => {
    const previousTitle = previousTitleRef.current;
    previousTitleRef.current = title;
    const current = currentRef.current;
    const outgoing = outgoingRef.current;
    if (!current || !outgoing) return;
    outgoing.textContent = '';
    if (previousTitle === title || shouldReduceMotion() || document.hidden) return;

    outgoing.textContent = previousTitle;
    // Apply the starting frame synchronously; GSAP's lazy render otherwise
    // waits for the next ticker frame and can briefly expose the final text.
    gsap.set(outgoing, { opacity: 1, y: 0 });
    gsap.set(current, { opacity: 0, y: 5 });
    gsap.timeline({
      onComplete: () => { outgoing.textContent = ''; },
    })
      .fromTo(outgoing, { opacity: 1, y: 0 }, {
        opacity: 0, y: -4, duration: ccemMotion.duration.quick, ease: ccemMotion.ease.soft, lazy: false,
      }, 0)
      .fromTo(current, { opacity: 0, y: 5 }, {
        opacity: 1, y: 0, duration: ccemMotion.duration.base, ease: ccemMotion.ease.standard, lazy: false,
      }, 0);
    return () => { outgoing.textContent = ''; };
  }, { scope: rootRef, dependencies: [title], revertOnUpdate: true });

  return (
    <span
      ref={rootRef}
      className={cn('relative block min-w-0 overflow-hidden', className)}
      data-workspace-session-title="true"
      aria-label={title}
    >
      <span ref={currentRef} className="block truncate" data-title-current="true">{title}</span>
      <span
        ref={outgoingRef}
        className="pointer-events-none absolute inset-x-0 top-0 block truncate"
        style={{ opacity: 0 }}
        aria-hidden="true"
        data-title-outgoing="true"
      />
    </span>
  );
});
