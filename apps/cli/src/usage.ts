import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import type { TokenUsage, TokenUsageWithCost, UsageStats, ModelPrice, UsageCache, FileMeta, FileStats, FileStatsEntry } from '@ccem/core';

// ESM 兼容：获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ... (保持前面的 import 和常量定义不变) ...

// Claude 项目数据目录
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ccem 数据目录
const CCEM_DIR = path.join(os.homedir(), '.ccem');

// 缓存版本号（修改缓存结构或统计口径时递增）
const CACHE_VERSION = 2;

// 缓存文件路径
const getCachePath = () => path.join(CCEM_DIR, 'usage-cache.json');
const getPricesPath = () => path.join(CCEM_DIR, 'model-prices.json');

// ... (保持 ensureCcemDir 等辅助函数不变) ...

// 确保 ccem 目录存在 (Sync version for cache reading)
function ensureCcemDirSync(): void {
  if (!fs.existsSync(CCEM_DIR)) {
    fs.mkdirSync(CCEM_DIR, { recursive: true });
  }
}

// 确保 ccem 目录存在 (Async version)
async function ensureCcemDir(): Promise<void> {
  try {
    await fsPromises.access(CCEM_DIR);
  } catch {
    await fsPromises.mkdir(CCEM_DIR, { recursive: true });
  }
}

// LiteLLM 价格数据 URL
const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// 获取 ccem 安装目录下的 model-prices.json 路径
const getBundledPricesPath = () => {
  return path.join(__dirname, '..', 'model-prices.json');
};

// ... (保持 DEFAULT_PRICES, normalizeModelName, loadPrices 等函数不变) ...

// 内置默认价格（fallback）
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-5': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6,
    cache_creation_input_token_cost: 6.25e-6,
  },
  'claude-sonnet-4-5': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.3e-6,
    cache_creation_input_token_cost: 3.75e-6,
  },
  'claude-haiku-4-5': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 0.1e-6,
    cache_creation_input_token_cost: 1.25e-6,
  },
};

// 模型名称标准化映射
function normalizeModelName(model: string): string {
  // 移除版本后缀，统一格式
  const normalized = model
    .replace(/-20\d{6}.*$/, '') // 移除日期版本号
    .replace(/-v\d+:\d+$/, '')  // 移除 bedrock 版本号
    .replace(/^anthropic\./, '') // 移除 anthropic. 前缀
    .replace(/^vertex_ai\//, '') // 移除 vertex_ai/ 前缀
    .replace(/@.*$/, '');        // 移除 @ 后缀
  return normalized;
}

// 加载价格数据
let pricesCache: Record<string, ModelPrice> | null = null;

export async function loadPrices(): Promise<Record<string, ModelPrice>> {
  if (pricesCache) return pricesCache;

  await ensureCcemDir();
  const pricesPath = getPricesPath();

  // 尝试从远程获取
  try {
    const response = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      const data = await response.json() as Record<string, Record<string, unknown>>;
      const prices: Record<string, ModelPrice> = {};

      for (const [key, value] of Object.entries(data)) {
        if (value.input_cost_per_token && value.output_cost_per_token) {
          prices[key] = {
            input_cost_per_token: value.input_cost_per_token as number,
            output_cost_per_token: value.output_cost_per_token as number,
            cache_read_input_token_cost: value.cache_read_input_token_cost as number | undefined,
            cache_creation_input_token_cost: value.cache_creation_input_token_cost as number | undefined,
          };
        }
      }

      // 保存到本地
      await fsPromises.writeFile(pricesPath, JSON.stringify(prices, null, 2));
      pricesCache = prices;
      return prices;
    }
  } catch {
    // 远程获取失败，尝试本地
  }

  // 尝试从用户缓存目录加载
  try {
    const content = await fsPromises.readFile(pricesPath, 'utf-8');
    const data = JSON.parse(content);
    pricesCache = data;
    return data;
  } catch {
    // 用户缓存加载失败
  }

  // 尝试从 ccem 安装目录加载内置价格文件
  try {
    const bundledPath = getBundledPricesPath();
    const content = await fsPromises.readFile(bundledPath, 'utf-8');
    const data = JSON.parse(content);
    pricesCache = data;
    return data;
  } catch {
    // 内置价格文件加载失败
  }

  // 使用默认价格
  pricesCache = DEFAULT_PRICES;
  return DEFAULT_PRICES;
}

// 获取模型价格
export function getModelPrice(model: string, prices: Record<string, ModelPrice>): ModelPrice {
  // 直接匹配
  if (prices[model]) return prices[model];

  // 标准化后匹配
  const normalized = normalizeModelName(model);
  if (prices[normalized]) return prices[normalized];

  // 模糊匹配
  for (const [key, value] of Object.entries(prices)) {
    if (key.includes(normalized) || normalized.includes(normalizeModelName(key))) {
      return value;
    }
  }

  // 默认价格
  if (model.includes('opus')) return DEFAULT_PRICES['claude-opus-4-5'];
  if (model.includes('sonnet')) return DEFAULT_PRICES['claude-sonnet-4-5'];
  if (model.includes('haiku')) return DEFAULT_PRICES['claude-haiku-4-5'];

  return DEFAULT_PRICES['claude-sonnet-4-5']; // 默认使用 sonnet 价格
}

// 计算费用
export function calculateCost(usage: TokenUsage, price: ModelPrice): number {
  return (
    usage.inputTokens * price.input_cost_per_token +
    usage.outputTokens * price.output_cost_per_token +
    usage.cacheReadTokens * (price.cache_read_input_token_cost || 0) +
    usage.cacheCreationTokens * (price.cache_creation_input_token_cost || 0)
  );
}

// 创建空的 TokenUsage
function emptyUsage(): TokenUsageWithCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
  };
}

// 合并 TokenUsage
function mergeUsage(a: TokenUsageWithCost, b: TokenUsageWithCost): TokenUsageWithCost {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cost: a.cost + b.cost,
  };
}

// 获取文件元数据 (Async)
async function getFileMetaAsync(filePath: string): Promise<FileMeta | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    return {
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

// 加载缓存 (Sync - for initial render)
function loadCacheSync(): UsageCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;

    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as UsageCache;

    // 检查缓存版本
    if (data.version !== CACHE_VERSION) return null;

    return data;
  } catch {
    return null;
  }
}

// 加载缓存 (Async)
async function loadCacheAsync(): Promise<UsageCache | null> {
  try {
    const cachePath = getCachePath();
    const content = await fsPromises.readFile(cachePath, 'utf-8');
    const data = JSON.parse(content) as UsageCache;

    // 检查缓存版本
    if (data.version !== CACHE_VERSION) return null;

    return data;
  } catch {
    return null;
  }
}

// 从缓存快速聚合统计（不重新解析文件）
export function getUsageStatsFromCache(): UsageStats | null {
  const cache = loadCacheSync();
  if (!cache) return null;

  // 从缓存中聚合统计
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  const stats: UsageStats = {
    today: emptyUsage(),
    week: emptyUsage(),
    total: emptyUsage(),
    dailyHistory: {},
    byModel: {},
    lastUpdated: now.toISOString(),
  };

  for (const fileData of Object.values(cache.files)) {
    for (const entry of fileData.stats.entries) {
      const entryTime = new Date(entry.timestamp);
      const dateKey = entry.timestamp.split('T')[0]; // YYYY-MM-DD

      stats.total = mergeUsage(stats.total, entry.usage);

      // Daily History
      if (!stats.dailyHistory[dateKey]) {
        stats.dailyHistory[dateKey] = emptyUsage();
      }
      stats.dailyHistory[dateKey] = mergeUsage(stats.dailyHistory[dateKey], entry.usage);

      const normalizedModel = normalizeModelName(entry.model);
      if (!stats.byModel[normalizedModel]) {
        stats.byModel[normalizedModel] = emptyUsage();
      }
      stats.byModel[normalizedModel] = mergeUsage(stats.byModel[normalizedModel], entry.usage);

      if (entryTime >= todayStart) {
        stats.today = mergeUsage(stats.today, entry.usage);
      }

      if (entryTime >= weekStart) {
        stats.week = mergeUsage(stats.week, entry.usage);
      }
    }
  }

  return stats;
}

// 保存缓存 (Async)
async function saveCacheAsync(cache: UsageCache): Promise<void> {
  try {
    await ensureCcemDir();
    await fsPromises.writeFile(getCachePath(), JSON.stringify(cache, null, 2));
  } catch {
    // 保存失败，忽略
  }
}

// 解析单个 JSONL 文件
interface JSONLEntry {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

async function parseJSONLFileAsync(filePath: string, prices: Record<string, ModelPrice>, signal?: AbortSignal): Promise<FileStats> {
  const entries: FileStatsEntry[] = [];
  const messageEntryIndexes = new Map<string, number>();

  try {
    // 使用流式读取，避免一次性读取大文件占用过多内存和阻塞事件循环
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineCount = 0;

    // 使用 for await...of 遍历每一行
    for await (const line of rl) {
      lineCount++;

      // 每处理 100 行检查一次 abort 信号，避免检查过于频繁
      if (lineCount % 100 === 0) {
        if (signal?.aborted) {
          rl.close();
          fileStream.destroy();
          throw new Error('Aborted');
        }
        // 每 1000 行让出一次主线程，避免 UI 卡顿
        if (lineCount % 1000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as JSONLEntry;

        // 只处理 assistant 消息
        if (entry.type !== 'assistant' || !entry.message?.usage) continue;

        const model = entry.message.model || 'unknown';
        const rawUsage = entry.message.usage;

        const usage: TokenUsage = {
          inputTokens: rawUsage.input_tokens || 0,
          outputTokens: rawUsage.output_tokens || 0,
          cacheReadTokens: rawUsage.cache_read_input_tokens || 0,
          cacheCreationTokens: rawUsage.cache_creation_input_tokens || 0,
        };

        const price = getModelPrice(model, prices);
        const cost = calculateCost(usage, price);

        const statsEntry: FileStatsEntry = {
          timestamp: entry.timestamp || new Date().toISOString(),
          model,
          usage: { ...usage, cost },
        };

        // 多个 content block / 流式快照会重复携带同一响应的 usage。
        // 与 Desktop 一致，保留最后一次快照，避免重复累加或保留早期零值。
        const messageId = entry.message.id;
        if (typeof messageId === 'string' && messageId.length > 0) {
          const index = messageEntryIndexes.get(messageId);
          if (index !== undefined) {
            entries[index] = statsEntry;
          } else {
            messageEntryIndexes.set(messageId, entries.length);
            entries.push(statsEntry);
          }
        } else {
          entries.push(statsEntry);
        }
      } catch {
        // 跳过无效行
      }
    }
  } catch (err) {
    if ((err as Error).message === 'Aborted') {
      throw err;
    }
    // 其他错误忽略（文件读取失败等）
  }

  return { entries };
}

// 获取所有 JSONL 文件 (Async)
async function getAllJSONLFilesAsync(): Promise<string[]> {
// ... (保持不变) ...
  const files: string[] = [];

  try {
    const projectsDirExists = await fsPromises.access(CLAUDE_PROJECTS_DIR).then(() => true).catch(() => false);
    if (!projectsDirExists) return files;

    const projects = await fsPromises.readdir(CLAUDE_PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
      try {
        const stat = await fsPromises.stat(projectPath);

        if (stat.isDirectory()) {
          const projectFiles = await fsPromises.readdir(projectPath);
          for (const file of projectFiles) {
            if (file.endsWith('.jsonl')) {
              files.push(path.join(projectPath, file));
            }
          }
        }
      } catch {
        // 忽略无法访问的目录
      }
    }
  } catch {
    // 目录读取失败
  }

  return files;
}

// 获取使用统计（带增量缓存）- 完全 Async
export async function getUsageStats(signal?: AbortSignal): Promise<UsageStats> {
  if (signal?.aborted) throw new Error('Aborted');

  const prices = await loadPrices();
  if (signal?.aborted) throw new Error('Aborted');

  const files = await getAllJSONLFilesAsync();
  if (signal?.aborted) throw new Error('Aborted');

  const cache = await loadCacheAsync();

  // 构建新的缓存
  const newCache: UsageCache = {
    version: CACHE_VERSION,
    files: {},
    lastUpdated: new Date().toISOString(),
  };

  // 收集所有 entries（从缓存或重新解析）
  const allEntries: FileStatsEntry[] = [];

  // 限制并发数，避免阻塞事件循环
  const CONCURRENCY_LIMIT = 5;

  // 将文件分块
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
    chunks.push(files.slice(i, i + CONCURRENCY_LIMIT));
  }

  // 分块串行处理，块内并行
  for (const chunk of chunks) {
    // 检查取消信号
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    const chunkPromises = chunk.map(async (file) => {
      const meta = await getFileMetaAsync(file);
      if (!meta) return null;

      // 检查缓存是否有效
      const cachedFile = cache?.files[file];
      const cacheValid = cachedFile &&
        cachedFile.meta.mtime === meta.mtime &&
        cachedFile.meta.size === meta.size;

      let fileStats: FileStats;

      if (cacheValid) {
        // 使用缓存
        fileStats = cachedFile.stats;
      } else {
        // 重新解析
        fileStats = await parseJSONLFileAsync(file, prices, signal);
        // 让出时间片，避免 JSON.parse 连续占用 CPU
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // 返回结果而不是直接修改外部变量
      return {
        file,
        meta,
        stats: fileStats
      };
    });

    const chunkResults = await Promise.all(chunkPromises);

    // 处理结果
    for (const result of chunkResults) {
      if (!result) continue;

      newCache.files[result.file] = {
        meta: result.meta,
        stats: result.stats,
      };

      allEntries.push(...result.stats.entries);
    }
  }

  // 保存缓存 (Async, no await needed for return)
  if (!signal?.aborted) {
    saveCacheAsync(newCache).catch(() => {});
  }

  // 聚合统计
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // 本周日开始

  const stats: UsageStats = {
    today: emptyUsage(),
    week: emptyUsage(),
    total: emptyUsage(),
    dailyHistory: {},
    byModel: {},
    lastUpdated: now.toISOString(),
  };

  for (const entry of allEntries) {
    const entryTime = new Date(entry.timestamp);
    const dateKey = entry.timestamp.split('T')[0]; // YYYY-MM-DD

    // 总计
    stats.total = mergeUsage(stats.total, entry.usage);

    // Daily History
    if (!stats.dailyHistory[dateKey]) {
      stats.dailyHistory[dateKey] = emptyUsage();
    }
    stats.dailyHistory[dateKey] = mergeUsage(stats.dailyHistory[dateKey], entry.usage);

    // 按模型
    const normalizedModel = normalizeModelName(entry.model);
    if (!stats.byModel[normalizedModel]) {
      stats.byModel[normalizedModel] = emptyUsage();
    }
    stats.byModel[normalizedModel] = mergeUsage(stats.byModel[normalizedModel], entry.usage);

    // 今日
    if (entryTime >= todayStart) {
      stats.today = mergeUsage(stats.today, entry.usage);
    }

    // 本周
    if (entryTime >= weekStart) {
      stats.week = mergeUsage(stats.week, entry.usage);
    }
  }

  return stats;
}

// 格式化 token 数量
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + 'M';
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + 'K';
  }
  return n.toString();
}

// 格式化费用
export function formatCost(n: number): string {
  if (n >= 1) {
    return '$' + n.toFixed(2);
  }
  if (n >= 0.01) {
    return '$' + n.toFixed(2);
  }
  return '$' + n.toFixed(4);
}

// 获取总 token 数
export function getTotalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}
