import fs from 'node:fs';
import path from 'node:path';

type PlanWrite = { filePath: string; content?: string };

// Keep only plans whose foreground tool result succeeded in the current turn.
// Never discover a plan by scanning the filesystem: it could belong to another
// session, a background agent, or an earlier prompt.
export class ClaudeTurnPlanTracker {
  private pending = new Map<string, PlanWrite>();
  content: string | undefined;

  reset() {
    this.pending.clear();
    this.content = undefined;
  }

  started(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    workingDir: string,
  ) {
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)
      || typeof input.file_path !== 'string') return;

    const filePath = path.resolve(workingDir, input.file_path);
    if (!/\.md$/i.test(filePath)) return;
    // An agent can enter a linked worktree outside its original cwd. Ownership
    // comes from the successful foreground tool, not a project-root prefix.
    if (!filePath.split(path.sep).some((part) => part === '.plans' || part === 'plans')) return;

    this.pending.set(toolUseId, {
      filePath,
      ...(toolName === 'Write' && typeof input.content === 'string'
        ? { content: input.content }
        : {}),
    });
  }

  completed(toolUseId: string, success: boolean) {
    const write = this.pending.get(toolUseId);
    this.pending.delete(toolUseId);
    if (!write || !success) return;

    // Write already supplies the complete bytes. For a successful Edit, take
    // a snapshot of that exact plan, rather than displaying an obsolete draft.
    try {
      const content = write.content ?? fs.readFileSync(write.filePath, 'utf8');
      this.content = content.trim() ? content : undefined;
    } catch {
      this.content = undefined;
    }
  }
}
