import type {
  EnvConfig,
  EnvPresetMetadata,
  PermissionPreset,
  PermissionModeName,
} from './types.js';

// 环境预设（API 提供商）
export const ENV_PRESETS: Record<
  string,
  Omit<EnvConfig, 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_SUBAGENT_MODEL'>
> = {
  'GLM': {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    ANTHROPIC_MODEL: 'opus'
  },
  'KIMI': {
    ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.7-code',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
    ANTHROPIC_MODEL: 'opus'
  },
  'KimiCodePlan': {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-for-coding',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-for-coding',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-for-coding',
    ANTHROPIC_MODEL: 'opus'
  },
  'MiniMax': {
    ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3[1m]',
    ANTHROPIC_MODEL: 'opus'
  },
  'DeepSeek': {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_MODEL: 'opus'
  },
  'Bailian': {
    ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.7-max',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.7-max',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
    ANTHROPIC_MODEL: 'opus'
  },
  'BailianCodePlan': {
    ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.7-plus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.7-plus',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.7-plus',
    ANTHROPIC_MODEL: 'opus'
  },
  'OpenRouter': {
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.7',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
    ANTHROPIC_MODEL: 'opus'
  },
  'Ollama': {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'gemma4:31b',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'gemma4:26b',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gemma4:e4b',
    ANTHROPIC_MODEL: 'opus'
  },
  'MiMo': {
    ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5',
    ANTHROPIC_MODEL: 'opus'
  },
  'MiMoTokenPlan': {
    ANTHROPIC_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_MODEL: 'opus'
  },
};

export const ENV_PRESET_METADATA: Record<string, EnvPresetMetadata> = {
  'GLM': {
    displayName: { zh: 'GLM', en: 'GLM' },
    description: { zh: '智谱 AI GLM 系列模型', en: 'Zhipu AI GLM Series' },
    credentialUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  'KIMI': {
    displayName: { zh: 'KIMI', en: 'KIMI' },
    description: { zh: '月之暗面 Kimi 对话模型', en: 'Moonshot Kimi' },
    credentialUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  'KimiCodePlan': {
    displayName: { zh: 'Kimi Code Plan', en: 'Kimi Code Plan' },
    description: { zh: 'Kimi Code 订阅套餐入口', en: 'Kimi Code Subscription Plan' },
    credentialUrl: 'https://kimi.com/code',
  },
  'MiniMax': {
    displayName: { zh: 'MiniMax', en: 'MiniMax' },
    description: { zh: 'MiniMax 大模型服务', en: 'MiniMax LLM Service' },
    credentialUrl: 'https://www.minimaxi.com/user-center/basic-information/interface-key',
  },
  'DeepSeek': {
    displayName: { zh: 'DeepSeek', en: 'DeepSeek' },
    description: { zh: 'DeepSeek V4 深度求索', en: 'DeepSeek V4' },
    credentialUrl: 'https://platform.deepseek.com/api_keys',
  },
  'Bailian': {
    displayName: { zh: '百炼', en: 'Bailian' },
    description: { zh: '阿里云百炼按量 Claude Code 接入', en: 'Alibaba Cloud Bailian Claude Code' },
    credentialUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  },
  'BailianCodePlan': {
    displayName: { zh: '百炼 Coding Plan', en: 'Bailian Coding Plan' },
    description: { zh: '阿里云百炼 Coding Plan 套餐入口', en: 'Alibaba Cloud Bailian Coding Plan' },
    credentialUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  },
  'OpenRouter': {
    displayName: { zh: 'OpenRouter', en: 'OpenRouter' },
    description: { zh: 'OpenRouter Anthropic 兼容入口', en: 'OpenRouter Anthropic-compatible routing' },
    credentialUrl: 'https://openrouter.ai/settings/keys',
  },
  'Ollama': {
    displayName: { zh: 'Ollama', en: 'Ollama' },
    description: { zh: '本地运行的开源大模型', en: 'Local open-source LLM runtime' },
    credentialUrl: 'https://ollama.com/',
  },
  'MiMo': {
    displayName: { zh: 'MiMo', en: 'MiMo' },
    description: { zh: '小米 MiMo 大模型按量付费', en: 'Xiaomi MiMo pay-as-you-go API' },
    credentialUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
  },
  'MiMoTokenPlan': {
    displayName: { zh: 'MiMo Token Plan', en: 'MiMo Token Plan' },
    description: { zh: '小米 MiMo Token Plan 订阅套餐', en: 'Xiaomi MiMo Token Plan subscription' },
    credentialUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
  },
};

// 权限预设
export const PERMISSION_PRESETS: Record<PermissionModeName, PermissionPreset> = {
  'yolo': {
    name: 'YOLO 模式',
    description: '全部放开，无任何限制',
    permissionMode: 'bypassPermissions',
    permissions: {
      allow: [
        'Bash',
        'Read',
        'Edit',
        'Write',
        'WebFetch',
        'WebSearch',
        'Glob',
        'Grep',
        'LSP',
        'NotebookEdit'
      ],
      deny: []
    }
  },

  'dev': {
    name: '开发模式',
    description: '日常开发权限，保护敏感文件',
    permissionMode: 'acceptEdits',
    permissions: {
      allow: [
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'LSP',
        'NotebookEdit',
        'Bash(npm:*)',
        'Bash(pnpm:*)',
        'Bash(yarn:*)',
        'Bash(bun:*)',
        'Bash(node:*)',
        'Bash(npx:*)',
        'Bash(git:*)',
        'Bash(tsc:*)',
        'Bash(tsx:*)',
        'Bash(eslint:*)',
        'Bash(prettier:*)',
        'Bash(jest:*)',
        'Bash(vitest:*)',
        'Bash(cargo:*)',
        'Bash(python:*)',
        'Bash(pip:*)',
        'Bash(go:*)',
        'Bash(make:*)',
        'Bash(cmake:*)',
        'Bash(ls:*)',
        'Bash(cat:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(find:*)',
        'Bash(wc:*)',
        'Bash(mkdir:*)',
        'Bash(cp:*)',
        'Bash(mv:*)',
        'Bash(touch:*)',
        'WebSearch'
      ],
      deny: [
        'Read(.env)',
        'Read(.env.*)',
        'Read(**/secrets/**)',
        'Read(**/*.pem)',
        'Read(**/*.key)',
        'Read(**/*credential*)',
        'Bash(rm -rf:*)',
        'Bash(sudo:*)',
        'Bash(chmod:*)',
        'Bash(chown:*)'
      ]
    }
  },

  'readonly': {
    name: '只读模式',
    description: '仅允许读取和搜索，禁止任何修改',
    permissionMode: 'plan',
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'LSP',
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(git diff:*)',
        'Bash(git branch:*)',
        'Bash(git show:*)',
        'Bash(ls:*)',
        'Bash(cat:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(find:*)',
        'Bash(wc:*)',
        'Bash(file:*)',
        'WebSearch'
      ],
      deny: [
        'Edit(*)',
        'Write(*)',
        'NotebookEdit(*)',
        'Bash(rm:*)',
        'Bash(mv:*)',
        'Bash(cp:*)',
        'Bash(mkdir:*)',
        'Bash(touch:*)',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(git checkout:*)',
        'Bash(git reset:*)',
        'Bash(npm install:*)',
        'Bash(pnpm install:*)',
        'Bash(yarn add:*)'
      ]
    }
  },

  'safe': {
    name: '安全模式',
    description: '保守权限，适合不熟悉的代码库',
    permissionMode: 'default',
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'LSP',
        'Bash(git status:*)',
        'Bash(git log:*)',
        'Bash(git diff:*)',
        'Bash(ls:*)',
        'Bash(cat:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(find:*)',
        'Bash(wc:*)'
      ],
      deny: [
        'Read(.env)',
        'Read(.env.*)',
        'Read(**/secrets/**)',
        'Read(**/*.pem)',
        'Read(**/*.key)',
        'Read(**/*credential*)',
        'Read(**/*password*)',
        'Edit(*)',
        'Write(*)',
        'NotebookEdit(*)',
        'Bash(curl:*)',
        'Bash(wget:*)',
        'Bash(ssh:*)',
        'Bash(scp:*)',
        'Bash(rm:*)',
        'Bash(mv:*)',
        'WebFetch(*)'
      ]
    }
  },

  'ci': {
    name: 'CI/CD 模式',
    description: '适合自动化流水线的权限',
    permissionMode: 'default',
    permissions: {
      allow: [
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'LSP',
        'Bash(npm:*)',
        'Bash(pnpm:*)',
        'Bash(yarn:*)',
        'Bash(node:*)',
        'Bash(git:*)',
        'Bash(docker:*)',
        'Bash(make:*)',
        'Bash(cargo:*)',
        'Bash(go:*)',
        'Bash(python:*)',
        'Bash(pip:*)',
        'Bash(pytest:*)',
        'Bash(jest:*)',
        'Bash(vitest:*)'
      ],
      deny: [
        'Read(.env.local)',
        'Read(**/secrets/**)',
        'Bash(sudo:*)',
        'Bash(ssh:*)',
        'Bash(scp:*)',
        'WebFetch(*)',
        'WebSearch'
      ]
    }
  },

  'audit': {
    name: '审计模式',
    description: '仅读取和搜索，用于安全审计',
    permissionMode: 'plan',
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'LSP',
        'Bash(git log:*)',
        'Bash(git blame:*)',
        'Bash(git show:*)',
        'Bash(git diff:*)',
        'Bash(ls:*)',
        'Bash(find:*)',
        'Bash(wc:*)',
        'Bash(file:*)',
        'Bash(stat:*)'
      ],
      deny: [
        'Edit(*)',
        'Write(*)',
        'NotebookEdit(*)',
        'Bash(rm:*)',
        'Bash(mv:*)',
        'Bash(cp:*)',
        'Bash(curl:*)',
        'Bash(wget:*)',
        'Bash(ssh:*)',
        'WebFetch(*)'
      ]
    }
  }
};

const LEGACY_ALLOW_ALL_RULE = /^([A-Za-z][A-Za-z0-9_]*?)\(\*\)$/;

export const normalizePermissionAllowRule = (rule: string): string => {
  const trimmed = rule.trim();
  const match = trimmed.match(LEGACY_ALLOW_ALL_RULE);
  return match ? match[1] : trimmed;
};

export const normalizePermissionAllowRules = (rules: string[]): string[] => {
  const normalized = rules
    .map(normalizePermissionAllowRule)
    .filter((rule) => rule.length > 0);
  return [...new Set(normalized)];
};

// 获取所有权限模式名称
export const getPermissionModeNames = (): PermissionModeName[] => {
  return Object.keys(PERMISSION_PRESETS) as PermissionModeName[];
};

// 权限模式图标
const MODE_ICONS: Record<PermissionModeName, string> = {
  yolo: '🔓',
  dev: '💻',
  readonly: '👀',
  safe: '🛡️',
  ci: '🔧',
  audit: '🔍'
};

/**
 * 获取权限模式图标
 */
export const getModeIcon = (modeName: PermissionModeName): string => {
  return MODE_ICONS[modeName] || '📋';
};

/**
 * 简化工具列表显示
 * 将 Bash(npm:*), Bash(git:*) 等合并为 Bash(npm/git/...)
 */
const summarizeTools = (tools: string[], maxLength: number = 50): string => {
  if (tools.length === 0) return '无';

  // 分组 Bash 命令
  const bashTools: string[] = [];
  const otherTools: string[] = [];

  tools.forEach(tool => {
    const bashMatch = tool.match(/^Bash\(([^:]+):\*\)$/);
    if (bashMatch) {
      bashTools.push(bashMatch[1]);
    } else if (tool.startsWith('Bash(')) {
      // Keep other scoped Bash rules visible as-is.
      otherTools.push(tool);
    } else {
      otherTools.push(tool);
    }
  });

  const parts: string[] = [];

  // 添加其他工具
  otherTools.forEach(tool => {
    parts.push(tool);
  });

  // 合并 Bash 命令
  if (bashTools.length > 0) {
    if (bashTools.length <= 3) {
      parts.push(`Bash(${bashTools.join('/')})`);
    } else {
      parts.push(`Bash(${bashTools.slice(0, 3).join('/')}...)`);
    }
  }

  // 截断过长的结果
  let result = parts.join(', ');
  if (result.length > maxLength) {
    // 找到合适的截断点
    const truncated = result.substring(0, maxLength);
    const lastComma = truncated.lastIndexOf(', ');
    if (lastComma > 0) {
      result = truncated.substring(0, lastComma) + '...';
    } else {
      result = truncated + '...';
    }
  }

  return result;
};

/**
 * 生成权限模式的详细描述（用于交互菜单）
 */
export const formatPermissionDescription = (modeName: PermissionModeName): string => {
  const preset = PERMISSION_PRESETS[modeName];

  const allowSummary = summarizeTools(preset.permissions.allow);
  const denySummary = preset.permissions.deny.length > 0
    ? summarizeTools(preset.permissions.deny)
    : '无限制';

  return `✅ ${allowSummary}\n     ❌ ${denySummary}`;
};
