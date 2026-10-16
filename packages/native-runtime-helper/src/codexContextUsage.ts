import fs from 'node:fs';
import path from 'node:path';
import { getCcemAgentHome } from '../../core/src/agent-home';

export interface CodexContextUsageSnapshot {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  categories: Array<{ name: string; tokens: number }>;
}

const TAIL_BYTES = 512 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageTotalTokens(value: unknown): number | null {
  const usage = asRecord(value);
  if (!usage) return null;

  const total = finiteNumber(usage.total_tokens);
  if (total !== null && total >= 0) {
    return total;
  }

  const input = finiteNumber(usage.input_tokens) ?? 0;
  const output = finiteNumber(usage.output_tokens) ?? 0;
  const totalFromParts = input + output;
  return totalFromParts > 0 ? totalFromParts : null;
}

function usageCategoryTokens(value: unknown, key: string): number {
  const usage = asRecord(value);
  return Math.max(0, finiteNumber(usage?.[key]) ?? 0);
}

export function buildCodexContextUsageFromTokenCount(
  payload: Record<string, unknown>,
  fallbackModel = 'codex',
): CodexContextUsageSnapshot | null {
  if (payload.type !== 'token_count') {
    return null;
  }

  const info = asRecord(payload.info);
  const lastUsage = info ? asRecord(info.last_token_usage) : null;
  if (!info || !lastUsage) {
    return null;
  }

  const maxTokens = finiteNumber(info.model_context_window)
    ?? finiteNumber(payload.model_context_window);
  const usedTokens = usageTotalTokens(lastUsage);
  if (maxTokens === null || maxTokens <= 0 || usedTokens === null) {
    return null;
  }

  const inputTokens = usageCategoryTokens(lastUsage, 'input_tokens');
  const outputTokens = usageCategoryTokens(lastUsage, 'output_tokens');
  const categories = [
    inputTokens > 0 ? { name: 'input', tokens: inputTokens } : null,
    outputTokens > 0 ? { name: 'output', tokens: outputTokens } : null,
  ].filter((category): category is { name: string; tokens: number } => Boolean(category));

  return {
    usedTokens,
    maxTokens,
    percentage: (usedTokens / maxTokens) * 100,
    model: typeof info.model === 'string' && info.model.trim()
      ? info.model.trim()
      : fallbackModel,
    categories,
  };
}

export function resolveCodexSessionsRoot(env: Record<string, string | undefined> = process.env) {
  const codexHome = getCcemAgentHome('codex', env);
  return path.join(codexHome, 'sessions');
}

function looksLikeUuid(value: string) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function scanDirectoryForSessionFile(dir: string, sessionId: string, recursive: boolean): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
      return entryPath;
    }
  }

  if (!recursive) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = scanDirectoryForSessionFile(path.join(dir, entry.name), sessionId, true);
    if (match) {
      return match;
    }
  }

  return null;
}

function recentSessionDirs(root: string, days = 7): string[] {
  const dirs: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    dirs.push(path.join(root, yyyy, mm, dd));
  }
  return dirs;
}

export function findCodexSessionFile(sessionId: string, sessionsRoot = resolveCodexSessionsRoot()) {
  const trimmed = sessionId.trim();
  if (!trimmed || !looksLikeUuid(trimmed)) {
    return null;
  }

  for (const dir of recentSessionDirs(sessionsRoot)) {
    const match = scanDirectoryForSessionFile(dir, trimmed, false);
    if (match) {
      return match;
    }
  }

  return scanDirectoryForSessionFile(sessionsRoot, trimmed, true);
}

function readTailLines(filePath: string): string[] {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, TAIL_BYTES);
  const start = Math.max(0, stat.size - length);
  const fd = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

export function readLatestCodexContextUsageFromSessionFile(filePath: string) {
  let currentModel = 'codex';
  let latest: CodexContextUsageSnapshot | null = null;

  for (const line of readTailLines(filePath)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = asRecord(parsed.payload);
    if (!payload) {
      continue;
    }

    if (parsed.type === 'session_meta' || parsed.type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model.trim() : '';
      if (model) {
        currentModel = model;
      }
      continue;
    }

    if (parsed.type !== 'event_msg') {
      continue;
    }

    const snapshot = buildCodexContextUsageFromTokenCount(payload, currentModel);
    if (snapshot) {
      latest = snapshot;
    }
  }

  return latest;
}

