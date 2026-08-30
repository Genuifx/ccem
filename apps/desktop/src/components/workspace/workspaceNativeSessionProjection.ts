import type { NativeLifecycleProjection } from '@/lib/tauri-ipc';

/**
 * The coordinator projection is authoritative whenever the backend provides
 * one. Older runtimes omit it, in which case the event/status heuristic stays
 * available as an explicit compatibility fallback.
 */
export function selectNativeSessionProcessing(
  lifecycle: NativeLifecycleProjection | null | undefined,
  fallback: () => boolean,
): boolean {
  if (lifecycle != null) {
    return lifecycle.active_command_id != null;
  }

  return fallback();
}
