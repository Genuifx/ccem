import path from 'node:path';

// Tauri's injected invoke is readonly in the real WebView. Substitute only
// the import at build time, preserving the production hook and all UI logic.
export function recoveryIpcPlugin(desktopDir) {
  return {
    name: 'transcript-recovery-ipc',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
        path: 'core', namespace: 'recovery-ipc',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'recovery-ipc' }, () => ({
        loader: 'js', resolveDir: desktopDir, contents: `
          export * from ${JSON.stringify(path.join(desktopDir, 'node_modules/@tauri-apps/api/core.js'))};
          export function invoke(...args) { return globalThis.__transcriptRecoveryInvoke(...args); }
        `,
      }));
    },
  };
}
