import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

// Native-style zoom shortcuts for the whole desktop app:
//   Cmd+= / Cmd++ / Cmd+- / Cmd+0 on macOS
//   Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 elsewhere
//
// Uses Tauri's built-in `webview.setZoom()` (under the hood:
// `plugin:webview|set_webview_zoom`) so the entire webview scales the way a
// browser's Cmd-+/- does, instead of layering CSS hacks. The chosen level is
// persisted to localStorage so it survives reloads. The shortcut listener is
// installed in the capture phase so it wins against inputs, textareas,
// terminals, and other contenteditable surfaces — matching native macOS apps.

export const CCEM_ZOOM_STORAGE_KEY = 'ccem-zoom-level';
export const CCEM_ZOOM_CHANGE_EVENT = 'ccem-zoom-change';
export const CCEM_ZOOM_COMMAND_EVENT = 'ccem-zoom-command';
export type AppZoomCommand = 'zoom_in' | 'zoom_out' | 'zoom_reset';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.3;
const STEP = 0.1;
const DEFAULT_ZOOM = 1.0;

function isMacPlatform(): boolean {
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  return /\b(Mac|iPhone|iPad|iPod)\b/.test(platform) || userAgent.includes('Macintosh');
}

function isZoomModifier(e: KeyboardEvent, isMac: boolean): boolean {
  if (e.altKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function roundZoom(value: number): number {
  // Avoid floating-point drift when stepping by 0.1.
  return Math.round(value * 100) / 100;
}

function readStoredZoom(): number {
  try {
    const raw = localStorage.getItem(CCEM_ZOOM_STORAGE_KEY);
    if (!raw) return DEFAULT_ZOOM;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_ZOOM;
    return clamp(parsed);
  } catch {
    return DEFAULT_ZOOM;
  }
}

async function applyZoom(value: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(value);
  } catch (err) {
    // The webview API can fail outside of a Tauri shell (e.g. browser preview)
    // or if the permission is missing. Don't crash the UI in that case.
    console.warn('[useZoom] setZoom failed', err);
  }
}

function persistZoom(value: number): void {
  try {
    if (value === DEFAULT_ZOOM) {
      localStorage.removeItem(CCEM_ZOOM_STORAGE_KEY);
    } else {
      localStorage.setItem(CCEM_ZOOM_STORAGE_KEY, String(value));
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function emitZoomChange(value: number): void {
  window.dispatchEvent(new CustomEvent(CCEM_ZOOM_CHANGE_EVENT, { detail: { zoom: value } }));
}

function isAppZoomCommand(value: unknown): value is AppZoomCommand {
  return value === 'zoom_in' || value === 'zoom_out' || value === 'zoom_reset';
}

export function dispatchAppZoomCommand(command: AppZoomCommand): void {
  window.dispatchEvent(new CustomEvent(CCEM_ZOOM_COMMAND_EVENT, {
    detail: { command },
  }));
}

export function useZoom(): void {
  useEffect(() => {
    // Restore the persisted zoom on mount.
    const initial = readStoredZoom();
    void applyZoom(initial);
    persistZoom(initial);
    emitZoomChange(initial);

    let current = initial;
    const isMac = isMacPlatform();

    const setZoom = (next: number) => {
      const clamped = roundZoom(clamp(next));
      if (clamped === current) return;
      current = clamped;
      void applyZoom(clamped);
      persistZoom(clamped);
      emitZoomChange(clamped);
    };

    const applyZoomCommand = (command: AppZoomCommand) => {
      switch (command) {
        case 'zoom_in':
          setZoom(current + STEP);
          break;
        case 'zoom_out':
          setZoom(current - STEP);
          break;
        case 'zoom_reset':
          setZoom(DEFAULT_ZOOM);
          break;
      }
    };

    const handler = (e: KeyboardEvent) => {
      if (!isZoomModifier(e, isMac)) return;

      const key = e.key;
      // Cmd+= and Cmd++ (Shift+=) both mean "zoom in" on macOS.
      if (key === '=' || key === '+') {
        e.preventDefault();
        applyZoomCommand('zoom_in');
        return;
      }
      if (key === '-') {
        e.preventDefault();
        applyZoomCommand('zoom_out');
        return;
      }
      if (key === '0') {
        e.preventDefault();
        applyZoomCommand('zoom_reset');
        return;
      }
    };

    const handleZoomCommandEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const command = (event.detail as { command?: unknown } | null)?.command;
      if (!isAppZoomCommand(command)) return;
      applyZoomCommand(command);
    };

    window.addEventListener('keydown', handler, { capture: true });
    window.addEventListener(CCEM_ZOOM_COMMAND_EVENT, handleZoomCommandEvent);
    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
      window.removeEventListener(CCEM_ZOOM_COMMAND_EVENT, handleZoomCommandEvent);
    };
  }, []);
}
