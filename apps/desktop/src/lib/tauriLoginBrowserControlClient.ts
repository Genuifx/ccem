import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createLoginBrowserControlClient } from '@/lib/loginBrowserControlIpc';

export const loginBrowserControlClient = createLoginBrowserControlClient({
  invoke: (command, args) => invoke(command, args),
  listen: (event, handler) => listen(event, handler),
});
