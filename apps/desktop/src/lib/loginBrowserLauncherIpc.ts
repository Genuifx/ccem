import type {
  LoginBrowserProfileSummary,
  LoginBrowserRecentActivity,
} from '@/lib/tauri-ipc';

export interface LoginBrowserLauncherDependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export interface LoginBrowserLauncherClient {
  listProfiles: (
    workingDir: string,
  ) => Promise<LoginBrowserProfileSummary[]>;
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
    listProfiles: (workingDir) => dependencies.invoke<LoginBrowserProfileSummary[]>(
      'browser_login_profiles',
      { workingDir },
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
