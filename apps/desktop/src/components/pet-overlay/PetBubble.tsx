import { CheckCircle2, CircleAlert, Loader2, X } from '@/lib/lucide-react';
import type { PetNotificationItem } from '@/types/pet';

interface PetBubbleProps {
  item: PetNotificationItem;
  onDismiss: (item: PetNotificationItem) => void;
  onOpen: (item: PetNotificationItem) => void;
}

function toneClass(tone: PetNotificationItem['tone']): string {
  switch (tone) {
    case 'attention':
      return 'border-amber-300/80 bg-white/95 text-stone-950';
    case 'failed':
      return 'border-red-300/80 bg-white/95 text-stone-950';
    case 'interrupted':
      return 'border-zinc-300/80 bg-white/95 text-stone-950';
    case 'done':
      return 'border-emerald-300/80 bg-white/95 text-stone-950';
    case 'running':
    default:
      return 'border-stone-300/80 bg-white/95 text-stone-950';
  }
}

function StatusIcon({ tone }: { tone: PetNotificationItem['tone'] }) {
  if (tone === 'running') {
    return <Loader2 className="h-3 w-3 animate-spin text-blue-500" aria-hidden="true" />;
  }
  if (tone === 'failed' || tone === 'attention') {
    return <CircleAlert className="h-3 w-3 text-amber-600" aria-hidden="true" />;
  }
  return <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />;
}

export function PetBubble({ item, onDismiss, onOpen }: PetBubbleProps) {
  return (
    <div
      className={[
        'group/pet-bubble pointer-events-auto relative h-[36px] w-[184px] rounded-lg border',
        'overflow-hidden transition duration-150 hover:-translate-y-0.5',
        toneClass(item.tone),
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="h-full w-full px-1.5 py-1 text-left"
      >
        <div className="min-w-0 pr-4">
          <span className="block truncate text-[11px] font-semibold leading-[13px]">{item.title}</span>
        </div>
        <p className="line-clamp-1 text-[10.5px] leading-3 opacity-80">{item.message}</p>
      </button>
      <span
        className="pointer-events-none absolute right-1.5 top-1.5 grid h-3.5 w-3.5 place-items-center"
        aria-hidden="true"
      >
        <StatusIcon tone={item.tone} />
      </span>
      <button
        type="button"
        aria-label="关闭气泡"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss(item);
        }}
        className={[
          'absolute -left-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full',
          'pointer-events-none bg-black/5 text-stone-500 opacity-0 transition hover:bg-black/10 hover:text-stone-900',
          'group-hover/pet-bubble:pointer-events-auto group-hover/pet-bubble:opacity-100 group-focus-within/pet-bubble:pointer-events-auto group-focus-within/pet-bubble:opacity-100',
        ].join(' ')}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
