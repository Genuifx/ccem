import { invoke } from '@tauri-apps/api/core';
import { createLoginBrowserLauncherClient } from '@/lib/loginBrowserLauncherIpc';

export const loginBrowserLauncherClient = createLoginBrowserLauncherClient({
  invoke: (command, args) => invoke(command, args),
});
