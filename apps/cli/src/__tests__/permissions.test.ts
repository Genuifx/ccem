import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readSettings,
  writeSettings,
  mergePermissions,
  showCurrentMode,
} from '../permissions.js';
import type { PermissionConfig } from '@ccem/core';

describe('permissions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-perm-test-'));
    // Create .git to make it a project root
    fs.mkdirSync(path.join(tempDir, '.git'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('readSettings', () => {
    it('should return empty object for non-existent file', () => {
      const result = readSettings('/non/existent/path.json');
      expect(result).toEqual({});
    });

    it('should parse valid JSON settings file', () => {
      const settingsPath = path.join(tempDir, 'settings.json');
      const config: PermissionConfig = {
        permissions: {
          allow: ['Read(*)'],
          deny: ['Write(*)'],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(config));

      const result = readSettings(settingsPath);
      expect(result).toEqual(config);
    });

    it('should handle invalid JSON gracefully', () => {
      const settingsPath = path.join(tempDir, 'settings.json');
      fs.writeFileSync(settingsPath, 'invalid json {{{');

      // Should create backup and return empty object
      const result = readSettings(settingsPath);
      expect(result).toEqual({});

      // Check backup was created
      const files = fs.readdirSync(tempDir);
      const backupFile = files.find(f => f.startsWith('settings.json.error.'));
      expect(backupFile).toBeDefined();
    });
  });

  describe('writeSettings', () => {
    it('should write settings to file', () => {
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir);
      const settingsPath = path.join(claudeDir, 'settings.local.json');

      const config: PermissionConfig = {
        permissions: {
          allow: ['Bash(*)'],
          deny: [],
        },
      };

      writeSettings(settingsPath, config);

      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(JSON.parse(content)).toEqual(config);
    });

    it('should create .claude directory if not exists', () => {
      const claudeDir = path.join(tempDir, '.claude');
      const settingsPath = path.join(claudeDir, 'settings.local.json');

      writeSettings(settingsPath, { permissions: { allow: [], deny: [] } });

      expect(fs.existsSync(claudeDir)).toBe(true);
    });
  });

  describe('mergePermissions', () => {
    it('should merge preset permissions with existing and normalize legacy allow rules', () => {
      const existing: PermissionConfig = {
        permissions: {
          allow: ['Read(*)'],
          deny: ['Write(*)'],
        },
      };

      const preset = {
        allow: ['Bash(npm:*)'],
        deny: ['Bash(sudo:*)'],
      };

      const result = mergePermissions(existing, preset);

      expect(result.permissions?.allow).toContain('Read');
      expect(result.permissions?.allow).not.toContain('Read(*)');
      expect(result.permissions?.allow).toContain('Bash(npm:*)');
      expect(result.permissions?.deny).toContain('Write(*)');
      expect(result.permissions?.deny).toContain('Bash(sudo:*)');
    });

    it('should deduplicate permissions', () => {
      const existing: PermissionConfig = {
        permissions: {
          allow: ['Read(*)', 'Bash(npm:*)'],
          deny: [],
        },
      };

      const preset = {
        allow: ['Read', 'Bash(npm:*)', 'Write(*)'],
        deny: [],
      };

      const result = mergePermissions(existing, preset);

      const allowCount = result.permissions?.allow?.filter(p => p === 'Read').length;
      expect(allowCount).toBe(1);
      expect(result.permissions?.allow).toContain('Write');
      expect(result.permissions?.allow).not.toContain('Write(*)');
    });

    it('should handle empty existing permissions', () => {
      const existing: PermissionConfig = {};

      const preset = {
        allow: ['Read(*)'],
        deny: ['Write(*)'],
      };

      const result = mergePermissions(existing, preset);

      expect(result.permissions?.allow).toContain('Read');
      expect(result.permissions?.deny).toContain('Write(*)');
    });

    it('should preserve other config fields', () => {
      const existing: PermissionConfig = {
        permissions: { allow: [], deny: [] },
        someOtherField: 'value',
      };

      const preset = { allow: ['Read(*)'], deny: [] };
      const result = mergePermissions(existing, preset);

      expect((result as any).someOtherField).toBe('value');
    });
  });

  describe('showCurrentMode', () => {
    it('renders very long permission rules completely without stalling', () => {
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir);
      const longRule = `Bash(${`x`.repeat(8_500)}:tail-sentinel)`;
      const allowRules = [
        longRule,
        ...Array.from({ length: 72 }, (_, index) => `Bash(test-command-${index}:${'y'.repeat(40)})`),
      ];
      fs.writeFileSync(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify({ permissions: { allow: allowRules, deny: [] } }),
      );
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      const startedAt = performance.now();
      showCurrentMode();
      const elapsedMs = performance.now() - startedAt;

      const output = consoleLog.mock.calls.flat().join('\n');
      expect(output).toContain('tail-sentinel');
      expect(output).toContain('73. Bash(test-command-71');
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});
