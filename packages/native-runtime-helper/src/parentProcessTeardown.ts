type KillProcess = (pid: number, signal: 'SIGKILL') => boolean;

/**
 * Kill the dedicated Unix process group when the desktop parent closes helper stdin.
 * Returns false for Windows or standalone helper invocations that do not own such a group.
 */
export function terminateOwnedProcessGroupOnParentClose(
  platform = process.platform,
  pid = process.pid,
  killProcess: KillProcess = process.kill.bind(process),
) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    killProcess(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
