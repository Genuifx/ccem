import { describe, it, expect } from 'vitest';
import {
  ENV_PRESETS,
  ENV_PRESET_METADATA,
  PERMISSION_PRESETS,
  getPermissionModeNames,
  getModeIcon,
  formatPermissionDescription,
  normalizePermissionAllowRule,
  normalizePermissionAllowRules,
} from '../presets.js';
import type { PermissionModeName } from '../types.js';

describe('presets', () => {
  describe('ENV_PRESETS', () => {
    it('should have GLM preset with correct structure', () => {
      expect(ENV_PRESETS.GLM).toBeDefined();
      expect(ENV_PRESETS.GLM.ANTHROPIC_BASE_URL).toContain('bigmodel.cn');
      expect(ENV_PRESETS.GLM.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]');
      expect(ENV_PRESETS.GLM.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
      expect(ENV_PRESETS.GLM.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
      expect(ENV_PRESETS.GLM.ANTHROPIC_MODEL).toBeDefined();
    });

    it('should have KIMI preset with correct structure', () => {
      expect(ENV_PRESETS.KIMI).toBeDefined();
      expect(ENV_PRESETS.KIMI.ANTHROPIC_BASE_URL).toContain('moonshot.cn');
      expect(ENV_PRESETS.KIMI.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.7-code');
      expect(ENV_PRESETS.KIMI.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.7-code');
      expect(ENV_PRESETS.KIMI.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.7-code');
    });

    it('should have MiniMax preset with correct structure', () => {
      expect(ENV_PRESETS.MiniMax).toBeDefined();
      expect(ENV_PRESETS.MiniMax.ANTHROPIC_BASE_URL).toContain('minimaxi.com');
      expect(ENV_PRESETS.MiniMax.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M3[1m]');
      expect(ENV_PRESETS.MiniMax.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M3[1m]');
      expect(ENV_PRESETS.MiniMax.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M3[1m]');
    });

    it('should have DeepSeek preset with correct structure and 1M context', () => {
      expect(ENV_PRESETS.DeepSeek).toBeDefined();
      expect(ENV_PRESETS.DeepSeek.ANTHROPIC_BASE_URL).toContain('deepseek.com');
      expect(ENV_PRESETS.DeepSeek.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]');
      expect(ENV_PRESETS.DeepSeek.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]');
      expect(ENV_PRESETS.DeepSeek.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash');
    });

    it('should include new preset providers', () => {
      expect(ENV_PRESETS.Bailian).toBeDefined();
      expect(ENV_PRESETS.BailianCodePlan).toBeDefined();
      expect(ENV_PRESETS.OpenRouter).toBeDefined();
    });

    it('should keep highlighted provider presets aligned with official defaults', () => {
      expect(ENV_PRESETS.KimiCodePlan.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/');
      expect(ENV_PRESETS.KimiCodePlan.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-for-coding');
      expect(ENV_PRESETS.KimiCodePlan.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding');
      expect(ENV_PRESETS.KimiCodePlan.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-for-coding');

      expect(ENV_PRESETS.Bailian.ANTHROPIC_BASE_URL).toBe(
        'https://dashscope.aliyuncs.com/apps/anthropic',
      );
      expect(ENV_PRESETS.Bailian.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('qwen3.7-max');
      expect(ENV_PRESETS.Bailian.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen3.7-max');
      expect(ENV_PRESETS.Bailian.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3.6-flash');

      expect(ENV_PRESETS.BailianCodePlan.ANTHROPIC_BASE_URL).toBe(
        'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      );
      expect(ENV_PRESETS.BailianCodePlan.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('qwen3.7-plus');
      expect(ENV_PRESETS.BailianCodePlan.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen3.7-plus');
      expect(ENV_PRESETS.BailianCodePlan.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3.7-plus');

      expect(ENV_PRESETS.OpenRouter.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4.7');
      expect(ENV_PRESETS.OpenRouter.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        'anthropic/claude-sonnet-4.6',
      );
      expect(ENV_PRESETS.OpenRouter.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
        'anthropic/claude-haiku-4.5',
      );

      expect(ENV_PRESETS.MiMoTokenPlan.ANTHROPIC_BASE_URL).toBe(
        'https://token-plan-cn.xiaomimimo.com/anthropic',
      );
      expect(ENV_PRESETS.MiMoTokenPlan.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('mimo-v2.5-pro');
      expect(ENV_PRESETS.MiMoTokenPlan.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('mimo-v2.5-pro');
      expect(ENV_PRESETS.MiMoTokenPlan.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('mimo-v2.5-pro');
    });

    it('should not include auth tokens in presets', () => {
      for (const preset of Object.values(ENV_PRESETS)) {
        expect((preset as any).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect((preset as any).CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      }
    });

    it('should define metadata for every preset', () => {
      expect(Object.keys(ENV_PRESET_METADATA)).toEqual(Object.keys(ENV_PRESETS));
      for (const [name, meta] of Object.entries(ENV_PRESET_METADATA)) {
        expect(meta.displayName.zh).toBeTruthy();
        expect(meta.displayName.en).toBeTruthy();
        expect(meta.description.zh).toBeTruthy();
        expect(meta.description.en).toBeTruthy();
        expect(meta.credentialUrl).toBeTruthy();
        expect(ENV_PRESETS[name]).toBeDefined();
      }
    });
  });

  describe('PERMISSION_PRESETS', () => {
    const expectedModes: PermissionModeName[] = ['yolo', 'dev', 'readonly', 'safe', 'ci', 'audit'];

    it('should have all expected permission modes', () => {
      for (const mode of expectedModes) {
        expect(PERMISSION_PRESETS[mode]).toBeDefined();
      }
    });

    it('should have valid structure for each preset', () => {
      for (const [modeName, preset] of Object.entries(PERMISSION_PRESETS)) {
        expect(preset.name).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.permissionMode).toBeTruthy();
        expect(Array.isArray(preset.permissions.allow)).toBe(true);
        expect(Array.isArray(preset.permissions.deny)).toBe(true);
      }
    });

    it('should use bare tool names for full-tool allow rules', () => {
      const legacyWildcardAllow = /^[A-Za-z][A-Za-z0-9_]*\(\*\)$/;
      for (const preset of Object.values(PERMISSION_PRESETS)) {
        for (const rule of preset.permissions.allow) {
          expect(rule).not.toMatch(legacyWildcardAllow);
        }
      }
    });

    it('should have yolo mode with bypassPermissions', () => {
      expect(PERMISSION_PRESETS.yolo.permissionMode).toBe('bypassPermissions');
      expect(PERMISSION_PRESETS.yolo.permissions.allow.length).toBeGreaterThan(0);
      expect(PERMISSION_PRESETS.yolo.permissions.deny.length).toBe(0);
    });

    it('should have dev mode with acceptEdits', () => {
      expect(PERMISSION_PRESETS.dev.permissionMode).toBe('acceptEdits');
      expect(PERMISSION_PRESETS.dev.permissions.deny).toContain('Bash(sudo:*)');
    });

    it('should have readonly mode with plan permissionMode', () => {
      expect(PERMISSION_PRESETS.readonly.permissionMode).toBe('plan');
      expect(PERMISSION_PRESETS.readonly.permissions.deny).toContain('Edit(*)');
      expect(PERMISSION_PRESETS.readonly.permissions.deny).toContain('Write(*)');
    });

    it('should have audit mode that denies modifications', () => {
      expect(PERMISSION_PRESETS.audit.permissionMode).toBe('plan');
      expect(PERMISSION_PRESETS.audit.permissions.deny).toContain('Edit(*)');
    });
  });

  describe('normalizePermissionAllowRule', () => {
    it('should convert legacy wildcard-all allow rules to bare tool names', () => {
      expect(normalizePermissionAllowRule('Read(*)')).toBe('Read');
      expect(normalizePermissionAllowRule('Bash(*)')).toBe('Bash');
      expect(normalizePermissionAllowRule('WebFetch(*)')).toBe('WebFetch');
    });

    it('should keep scoped allow rules unchanged', () => {
      expect(normalizePermissionAllowRule('Bash(npm:*)')).toBe('Bash(npm:*)');
      expect(normalizePermissionAllowRule('WebFetch(domain:example.com)')).toBe(
        'WebFetch(domain:example.com)',
      );
    });

    it('should deduplicate normalized allow rules', () => {
      expect(normalizePermissionAllowRules(['Read(*)', 'Read', '  ', 'Bash(npm:*)'])).toEqual([
        'Read',
        'Bash(npm:*)',
      ]);
    });
  });

  describe('getPermissionModeNames', () => {
    it('should return all permission mode names', () => {
      const names = getPermissionModeNames();
      expect(names).toContain('yolo');
      expect(names).toContain('dev');
      expect(names).toContain('readonly');
      expect(names).toContain('safe');
      expect(names).toContain('ci');
      expect(names).toContain('audit');
      expect(names.length).toBe(6);
    });
  });

  describe('getModeIcon', () => {
    it('should return correct icons for each mode', () => {
      expect(getModeIcon('yolo')).toBe('🔓');
      expect(getModeIcon('dev')).toBe('💻');
      expect(getModeIcon('readonly')).toBe('👀');
      expect(getModeIcon('safe')).toBe('🛡️');
      expect(getModeIcon('ci')).toBe('🔧');
      expect(getModeIcon('audit')).toBe('🔍');
    });
  });

  describe('formatPermissionDescription', () => {
    it('should format yolo mode description', () => {
      const description = formatPermissionDescription('yolo');
      expect(description).toContain('✅');
      expect(description).toContain('❌');
    });

    it('should format dev mode description', () => {
      const description = formatPermissionDescription('dev');
      expect(description).toContain('✅');
      expect(description).toContain('❌');
    });
  });
});
