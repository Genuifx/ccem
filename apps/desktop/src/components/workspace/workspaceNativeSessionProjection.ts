import type { NativeLifecycleProjection } from '@/lib/tauri-ipc';

/**
 * The coordinator projection is authoritative for Claude managed inbox only.
 * Other providers retain their runtime status even if an older backend emits
 * an empty coordinator projection. Older runtimes omit it, in which case the event/status heuristic stays
 * available as an explicit compatibility fallback.
 */
export function selectNativeSessionProcessing(
  lifecycle: NativeLifecycleProjection | null | undefined,
  fallback: () => boolean,
  provider: string = 'claude',
): boolean {
  if (provider === 'claude' && lifecycle != null) {
    return lifecycle.active_command_id != null;
  }

  return fallback();
}
