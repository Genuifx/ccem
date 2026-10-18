import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check } from '@/lib/lucide-react';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import {
  DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE,
  WORKSPACE_ANNOTATION_COLORS,
  normalizeWorkspaceAnnotationColor,
  normalizeWorkspaceAnnotationHighlightStyle,
  type WorkspaceAnnotationAppearance,
  type WorkspaceAnnotationColor,
  type WorkspaceAnnotationHighlightStyle,
} from './workspaceAnnotationModel';

const STORAGE_KEY = 'ccem:workspace-annotation-appearance:v1';
const LEGACY_STYLE_STORAGE_KEY = 'ccem:workspace-annotation-highlight-style:v1';
const CHANGE_EVENT = 'ccem:workspace-annotation-appearance-change';

let cachedAppearance: WorkspaceAnnotationAppearance | null = null;

function loadAppearance(): WorkspaceAnnotationAppearance {
  if (typeof window === 'undefined') {
    return DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as { style?: unknown; color?: unknown };
      return {
        style: normalizeWorkspaceAnnotationHighlightStyle(parsed.style)
          ?? DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE.style,
        color: normalizeWorkspaceAnnotationColor(parsed.color)
          ?? DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE.color,
      };
    }
    const legacyStyle = normalizeWorkspaceAnnotationHighlightStyle(
      window.localStorage.getItem(LEGACY_STYLE_STORAGE_KEY),
    );
    return {
      ...DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE,
      ...(legacyStyle ? { style: legacyStyle } : {}),
    };
  } catch {
    return DEFAULT_WORKSPACE_ANNOTATION_APPEARANCE;
  }
}

function readAppearance(): WorkspaceAnnotationAppearance {
  cachedAppearance ??= loadAppearance();
  return cachedAppearance;
}

function writeAppearance(next: WorkspaceAnnotationAppearance) {
  cachedAppearance = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persisting a display preference is best-effort.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Last used annotation paint. New annotations inherit it; each saved
 * annotation keeps its own explicit style/color. The transcript and the
 * selection toolbar mount separately, so changes are broadcast through a
 * window event.
 */
export function useWorkspaceAnnotationAppearance(): {
  appearance: WorkspaceAnnotationAppearance;
  setStyle: (style: WorkspaceAnnotationHighlightStyle) => void;
  setColor: (color: WorkspaceAnnotationColor) => void;
} {
  const [appearance, setAppearance] = useState<WorkspaceAnnotationAppearance>(readAppearance);

  useEffect(() => {
    const syncFromMemory = () => setAppearance(readAppearance());
    const syncFromStorage = () => {
      cachedAppearance = null;
      setAppearance(readAppearance());
    };
    window.addEventListener(CHANGE_EVENT, syncFromMemory);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, syncFromMemory);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  const update = useCallback((patch: Partial<WorkspaceAnnotationAppearance>) => {
    const next = { ...readAppearance(), ...patch };
    writeAppearance(next);
    setAppearance(next);
  }, []);

  const setStyle = useCallback(
    (style: WorkspaceAnnotationHighlightStyle) => update({ style }),
    [update],
  );
  const setColor = useCallback(
    (color: WorkspaceAnnotationColor) => update({ color }),
    [update],
  );

  return { appearance, setStyle, setColor };
}

const STYLE_OPTIONS: Array<{
  value: WorkspaceAnnotationHighlightStyle;
  labelKey: string;
}> = [
  { value: 'selection', labelKey: 'workspace.annotationStyleMarker' },
  { value: 'wave', labelKey: 'workspace.annotationStyleWave' },
];

const COLOR_LABEL_KEYS: Record<WorkspaceAnnotationColor, string> = {
  rose: 'workspace.annotationColorRose',
  violet: 'workspace.annotationColorViolet',
  blue: 'workspace.annotationColorBlue',
  green: 'workspace.annotationColorGreen',
  amber: 'workspace.annotationColorAmber',
};

interface WorkspaceAnnotationColorPaletteProps {
  color: WorkspaceAnnotationColor;
  onColorChange: (color: WorkspaceAnnotationColor) => void;
  className?: string;
}

export function WorkspaceAnnotationColorPalette({
  color,
  onColorChange,
  className,
}: WorkspaceAnnotationColorPaletteProps) {
  const { t } = useLocale();
  return (
    <div
      role="group"
      aria-label={t('workspace.annotationColorPalette')}
      className={cn('flex items-center gap-1.5', className)}
    >
      {WORKSPACE_ANNOTATION_COLORS.map((option) => {
        const active = option === color;
        return (
          <button
            key={option}
            type="button"
            data-workspace-annotation-color={option}
            aria-label={t(COLOR_LABEL_KEYS[option])}
            aria-pressed={active}
            onClick={() => onColorChange(option)}
            className={cn(
              `workspace-annotation-color-${option}`,
              'flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-transform',
              active
                ? 'scale-110 border-foreground/50'
                : 'border-transparent hover:scale-110',
            )}
            style={{ backgroundColor: 'hsl(var(--annotation-hsl))' }}
          >
            {active ? (
              <Check className="h-3 w-3" style={{ color: 'var(--annotation-fg)' }} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

interface WorkspaceAnnotationStyleToggleProps {
  style: WorkspaceAnnotationHighlightStyle;
  onStyleChange: (style: WorkspaceAnnotationHighlightStyle) => void;
  className?: string;
}

export function WorkspaceAnnotationStyleToggle({
  style,
  onStyleChange,
  className,
}: WorkspaceAnnotationStyleToggleProps) {
  const { t } = useLocale();
  const styleOptions = useMemo(() => STYLE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  })), [t]);

  return (
    <div
      role="group"
      aria-label={t('workspace.annotationStyleToggle')}
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-border/40 bg-surface p-0.5',
        className,
      )}
    >
      {styleOptions.map((option) => {
        const active = option.value === style;
        return (
          <button
            key={option.value}
            type="button"
            data-workspace-annotation-style={option.value}
            aria-pressed={active}
            title={option.label}
            onClick={() => onStyleChange(option.value)}
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

interface WorkspaceAnnotationAppearanceControlsProps {
  style: WorkspaceAnnotationHighlightStyle;
  color: WorkspaceAnnotationColor;
  onStyleChange: (style: WorkspaceAnnotationHighlightStyle) => void;
  onColorChange: (color: WorkspaceAnnotationColor) => void;
  className?: string;
}

export function WorkspaceAnnotationAppearanceControls({
  style,
  color,
  onStyleChange,
  onColorChange,
  className,
}: WorkspaceAnnotationAppearanceControlsProps) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      <WorkspaceAnnotationColorPalette color={color} onColorChange={onColorChange} />
      <div className="mx-0.5 h-3 w-px bg-border/60" aria-hidden="true" />
      <WorkspaceAnnotationStyleToggle style={style} onStyleChange={onStyleChange} />
    </div>
  );
}
