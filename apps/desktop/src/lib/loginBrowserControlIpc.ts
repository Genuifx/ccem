import type {
  LoginBrowserRecentActivity,
  LoginBrowserSessionSnapshot,
  TauriCommands,
} from '@/lib/tauri-ipc';

export const LOGIN_BROWSER_CONTROL_EVENT = 'browser-login-control-changed';

type LoginBrowserControlCommand = Extract<
  keyof TauriCommands,
  | 'browser_login_control_snapshot'
  | 'browser_login_recent_activity'
  | 'browser_login_handoff'
  | 'browser_login_pause'
  | 'browser_login_takeover'
  | 'browser_login_close'
  | 'browser_login_force_stop'
>;

interface TauriEvent<T> {
  payload: T;
}

export interface LoginBrowserControlDependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(
    event: string,
    handler: (event: TauriEvent<T>) => void,
  ) => Promise<() => void>;
}

export interface LoginBrowserControlClient {
  snapshot: () => Promise<LoginBrowserSessionSnapshot | null>;
  recentActivity: () => Promise<LoginBrowserRecentActivity>;
  handoff: () => Promise<LoginBrowserSessionSnapshot>;
  pause: () => Promise<LoginBrowserSessionSnapshot>;
  takeover: () => Promise<LoginBrowserSessionSnapshot>;
  close: (force: boolean) => Promise<void>;
  subscribe: (
    handler: (snapshot: LoginBrowserSessionSnapshot | null) => void,
  ) => Promise<() => void>;
}

export function createLoginBrowserControlClient(
  dependencies: LoginBrowserControlDependencies,
): LoginBrowserControlClient {
  const invokeCommand = <K extends LoginBrowserControlCommand>(
    command: K,
  ): Promise<TauriCommands[K][1]> => dependencies.invoke<TauriCommands[K][1]>(command);

  return {
    snapshot: () => invokeCommand('browser_login_control_snapshot'),
    recentActivity: () => invokeCommand('browser_login_recent_activity'),
    handoff: () => invokeCommand('browser_login_handoff'),
    pause: () => invokeCommand('browser_login_pause'),
    takeover: () => invokeCommand('browser_login_takeover'),
    close: (force) => invokeCommand(
      force ? 'browser_login_force_stop' : 'browser_login_close',
    ),
    subscribe: (handler) => dependencies.listen<LoginBrowserSessionSnapshot | null>(
      LOGIN_BROWSER_CONTROL_EVENT,
      (event) => handler(event.payload),
    ),
  };
}
