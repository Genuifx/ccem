import path from 'node:path';
import * as fs from 'node:fs/promises';
import type { FileStatsEntry, UsageCache } from '@ccem/core';

/** Only regular transcripts are read. Never prepare, migrate or write a profile. */
export async function discoverClaudeUsageFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 4) await walk(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
      }
    } catch { /* Keep the other profile usable when one directory is unavailable. */ }
  }
  for (const root of roots) {
    const canonical = await fs.realpath(root).catch(() => root);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    await walk(root, 0);
  }
  return files;
}

function logicalPath(file: string, roots: string[]): string {
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return file;
}

function newer(left: FileStatsEntry, right: FileStatsEntry): boolean {
  const time = (row: FileStatsEntry) => Date.parse(row.timestamp) || 0;
  const tokens = (row: FileStatsEntry) => row.usage.inputTokens + row.usage.outputTokens
    + row.usage.cacheReadTokens + row.usage.cacheCreationTokens;
  return time(left) > time(right) || (time(left) === time(right) && tokens(left) > tokens(right));
}

/** Union matching transcript copies, not whole sessions: both can have new turns. */
export function mergeClaudeUsage(files: UsageCache['files'], roots: string[]): FileStatsEntry[] {
  const merged = new Map<string, FileStatsEntry>();
  for (const [file, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const session = logicalPath(file, roots);
    const occurrences = new Map<string, number>();
    for (const [index, row] of data.stats.entries.entries()) {
      let identity: string;
      if (row.messageId) identity = `id:${row.messageId}`;
      else {
        // Token totals alone cannot prove that two idless messages are copies.
        const signature = row.recordFingerprint ?? JSON.stringify([file, index]);
        const occurrence = (occurrences.get(signature) ?? 0) + 1;
        occurrences.set(signature, occurrence);
        identity = `row:${signature}:${occurrence}`;
      }
      const key = JSON.stringify([session, identity]);
      const previous = merged.get(key);
      if (!previous || newer(row, previous)) merged.set(key, row);
    }
  }
  return [...merged.values()];
}
