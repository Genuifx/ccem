import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';

export type WorkspaceAnnotationHighlightStyle = 'selection' | 'wave';

const STORAGE_KEY = 'ccem:workspace-annotation-highlight-style:v1';
const CHANGE_EVENT = 'ccem:workspace-annotation-highlight-style-change';

function readStyle(): WorkspaceAnnotationHighlightStyle {
  if (typeof window === 'undefined') {
    return 'selection';
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'wave' ? 'wave' : 'selection';
  } catch {
    return 'selection';
  }
}

/**
 * Global annotation highlight preference. The transcript and the composer
 * annotation list mount separately, so the change is broadcast through a
 * window event and persisted to localStorage.
 */
export function useWorkspaceAnnotationHighlightStyle(): [
  WorkspaceAnnotationHighlightStyle,
  (style: WorkspaceAnnotationHighlightStyle) => void,
] {
  const [style, setStyle] = useState<WorkspaceAnnotationHighlightStyle>(readStyle);

  useEffect(() => {
    const sync = () => setStyle(readStyle());
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const update = useCallback((next: WorkspaceAnnotationHighlightStyle) => {
    setStyle(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting a display preference is best-effort.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [style, update];
}

export function WorkspaceAnnotationStyleToggle({ className }: { className?: string }) {
  const { t } = useLocale();
  const [style, setStyle] = useWorkspaceAnnotationHighlightStyle();
  const options = useMemo(() => ([
    { value: 'selection' as const, label: t('workspace.annotationStyleSelection') },
    { value: 'wave' as const, label: t('workspace.annotationStyleWave') },
  ]), [t]);

  return (
    <div
      role="group"
      aria-label={t('workspace.annotationStyleLabel')}
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-border/40 bg-surface p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = style === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.label}
            onClick={() => setStyle(option.value)}
            className={cn(
              'h-5 rounded-full px-2 text-[10px] font-medium transition-colors',
              active
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
