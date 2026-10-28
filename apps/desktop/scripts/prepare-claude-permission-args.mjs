import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_PRESETS, normalizePermissionAllowRules } from '../../../packages/core/dist/browser.js';

// Desktop launches the selected executable directly, so preserve the same
// permission arguments as ccem CLI without requiring a matching global CLI.
export const permissionArgs = Object.fromEntries(Object.entries(PERMISSION_PRESETS).map(([name, preset]) => {
  const args = ['--permission-mode', preset.permissionMode];
  const allow = normalizePermissionAllowRules(preset.permissions.allow);
  if (allow.length) args.push('--allowedTools', ...allow);
  if (preset.permissions.deny.length) args.push('--disallowedTools', ...preset.permissions.deny);
  return [name, args];
}));

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/resources/claude-permission-args.json');
const expected = `${JSON.stringify(permissionArgs, null, 2)}\n`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== expected) {
      throw new Error('Claude permission arguments differ from core presets; regenerate prepare-claude-permission-args.mjs');
    }
  } else {
    fs.writeFileSync(target, expected);
  }
}
