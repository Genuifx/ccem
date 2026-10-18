import { ensureCcemAgentHome } from '../../core/src/agent-home';
import { claudePluginRevision } from '../../core/src/agent-plugin-links';

type Revision = string | null | undefined;
type PluginQuery = {
  applyFlagSettings(settings: Record<string, never>): Promise<unknown>;
  reloadPlugins(): Promise<unknown>;
};

function preparePlugins(): Revision {
  const home = ensureCcemAgentHome('claude');
  return claudePluginRevision(home);
}

/** Each query keeps its own disk baseline; imports never interrupt or replace it. */
export class ClaudePluginRefresh {
  private readonly revisions = new WeakMap<PluginQuery, Revision>();
  private readonly pending = new WeakMap<PluginQuery, Promise<void>>();
  private readonly prepare: () => Revision;
  private readonly warn: (message: string) => void;
  private readonly timeoutMs: number;

  constructor(options: { prepare?: () => Revision; warn?: (message: string) => void; timeoutMs?: number } = {}) {
    this.prepare = options.prepare ?? preparePlugins;
    this.warn = options.warn ?? console.warn;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private deferred(error: unknown) {
    this.warn(`Claude plugin refresh deferred: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Call synchronously immediately before query(), so later imports cannot become its baseline. */
  prepareQuery(): Revision {
    try { return this.prepare(); } catch (error) {
      this.deferred(error);
      return undefined;
    }
  }

  trackQuery(query: PluginQuery, revision: Revision) {
    this.revisions.set(query, revision);
  }

  beforePrompt(query: PluginQuery, isCurrentAndIdle: () => boolean): Promise<void> {
    const pending = this.pending.get(query);
    if (pending) return pending;
    if (!isCurrentAndIdle()) return Promise.resolve();

    const refresh = this.refresh(query, isCurrentAndIdle);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.deferred(new Error(`plugin controls did not settle within ${this.timeoutMs}ms; continuing the prompt`));
        resolve();
      }, this.timeoutMs);
    });
    const operation = Promise.race([refresh, deadline]).finally(() => clearTimeout(timer));
    this.pending.set(query, operation);
    // SDK controls have no timeout/cancellation API. Stop waiting, but retain
    // the real in-flight operation so later prompts cannot stack more reloads.
    void refresh.finally(() => {
      if (this.pending.get(query) === operation) this.pending.delete(query);
    });
    return operation;
  }

  private async refresh(query: PluginQuery, isCurrentAndIdle: () => boolean) {
    try {
      const revision = this.prepare();
      if (revision === undefined || revision === this.revisions.get(query) || !isCurrentAndIdle()) return;
      // reloadPlugins alone can see stale user settings. An empty flag patch
      // invalidates that cascade without overriding local plugin disables.
      await query.applyFlagSettings({});
      if (!isCurrentAndIdle()) return;
      await query.reloadPlugins();
      if (isCurrentAndIdle()) this.revisions.set(query, revision);
    } catch (error) {
      // Keep the previous revision so a later safe prompt retries the refresh.
      this.deferred(error);
    }
  }
}
