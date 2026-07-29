// 环境配置类型
export interface EnvConfig {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  CCEM_LIMIT_WRITE_TOOLS?: boolean;
}

export interface EnvPresetMetadata {
  displayName: {
    zh: string;
    en: string;
  };
  description: {
    zh: string;
    en: string;
  };
  credentialUrl?: string;
}

// Claude Code 权限配置类型
export interface PermissionConfig {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown; // 保留其他配置字段
}

// 权限模式名称
export type PermissionModeName = 'yolo' | 'dev' | 'readonly' | 'safe' | 'ci' | 'audit';

// Claude Code 官方 permission mode
export type OfficialPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

// 权限预设类型
export interface PermissionPreset {
  name: string;
  description: string;
  permissionMode: OfficialPermissionMode;
  permissions: {
    allow: string[];
    deny: string[];
  };
}

// Token 使用量
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// 带费用的 Token 使用量
export interface TokenUsageWithCost extends TokenUsage {
  cost: number;
}

// 使用统计
export interface UsageStats {
  today: TokenUsageWithCost;
  week: TokenUsageWithCost;
  total: TokenUsageWithCost;
  dailyHistory: Record<string, TokenUsageWithCost>; // key: YYYY-MM-DD
  byModel: Record<string, TokenUsageWithCost>;
  lastUpdated: string;
}

// 模型价格
export interface ModelPrice {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

// 文件元数据
export interface FileMeta {
  mtime: number;  // 文件修改时间
  size: number;   // 文件大小
}

// 单个文件的统计条目
export interface FileStatsEntry {
  timestamp: string;
  model: string;
  usage: TokenUsageWithCost;
}

// 单个文件的统计
export interface FileStats {
  entries: FileStatsEntry[];
}

// 使用缓存（文件级）
export interface UsageCache {
  version: number;  // 缓存版本号
  files: Record<string, {  // key = 文件路径
    meta: FileMeta;
    stats: FileStats;
  }>;
  lastUpdated: string;
}
