import type {
  LoginBrowserProfileSummary,
  LoginBrowserRecentActivity,
  LoginBrowserSessionSnapshot,
  TauriCommands,
} from '@/lib/tauri-ipc';

export type LoginBrowserProfileMode = NonNullable<
  TauriCommands['browser_login_open'][0]['profileMode']
>;

export interface LoginBrowserLauncherDependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export interface LoginBrowserLauncherClient {
  open: (
    workingDir: string,
    profileMode: LoginBrowserProfileMode,
  ) => Promise<LoginBrowserSessionSnapshot>;
  listProfiles: (
    workingDir: string,
  ) => Promise<LoginBrowserProfileSummary[]>;
  openProfile: (
    workingDir: string,
    profileId: string,
  ) => Promise<LoginBrowserSessionSnapshot>;
  profileRecentActivity: (
    workingDir: string,
    profileId: string,
  ) => Promise<LoginBrowserRecentActivity>;
  resetProfile: (
    workingDir: string,
    profileId: string,
    confirmed: boolean,
  ) => Promise<LoginBrowserProfileSummary>;
  deleteProfile: (
    workingDir: string,
    profileId: string,
    confirmed: boolean,
  ) => Promise<void>;
}

export function createLoginBrowserLauncherClient(
  dependencies: LoginBrowserLauncherDependencies,
): LoginBrowserLauncherClient {
  return {
    open: (workingDir, profileMode) => dependencies.invoke<LoginBrowserSessionSnapshot>(
      'browser_login_open',
      { workingDir, profileMode },
    ),
    listProfiles: (workingDir) => dependencies.invoke<LoginBrowserProfileSummary[]>(
      'browser_login_profiles',
      { workingDir },
    ),
    openProfile: (workingDir, profileId) => dependencies.invoke<LoginBrowserSessionSnapshot>(
      'browser_login_open_profile',
      { workingDir, profileId },
    ),
    profileRecentActivity: (workingDir, profileId) => dependencies.invoke<LoginBrowserRecentActivity>(
      'browser_login_profile_recent_activity',
      { workingDir, profileId },
    ),
    resetProfile: (workingDir, profileId, confirmed) => dependencies.invoke<LoginBrowserProfileSummary>(
      'browser_login_reset_profile',
      { workingDir, profileId, confirmed },
    ),
    deleteProfile: (workingDir, profileId, confirmed) => dependencies.invoke<void>(
      'browser_login_delete_profile',
      { workingDir, profileId, confirmed },
    ),
  };
}
