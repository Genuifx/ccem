/** Inputs attached to one foreground command; SDK child terminals are not turn terminals. */
export class ClaudeSteering {
  private inputs = new Map<string, { parent: string; terminal: boolean; needsResult: boolean }>();
  private roots = new Map<string, { terminal: boolean; outputTokens: number; hasUsage: boolean; cancelledByStop: boolean }>();
  private results = new Set<string>();
  deferredTerminal: { commandId: string; state: string } | null = null;

  add(id: string, parent: string) {
    this.inputs.set(id, { parent, terminal: false, needsResult: false });
    if (!this.roots.has(parent)) this.roots.set(parent, { terminal: false, outputTokens: 0, hasUsage: false, cancelledByStop: false });
  }

  get(id: string) { return this.inputs.get(id); }

  hasPending(parent: string) {
    return [...this.inputs.values()].some((input) => input.parent === parent && !input.terminal);
  }

  noteRootTerminal(parent: string) {
    const root = this.roots.get(parent);
    if (root) root.terminal = true;
    for (const input of this.inputs.values()) {
      // Still-running children are SDK continuations and may report their
      // result after their terminal frame. Folded children have no own result.
      if (input.parent === parent && !input.terminal) input.needsResult = true;
    }
  }

  noteChildTerminal(id: string, state: string, interruptRequested: boolean) {
    const input = this.inputs.get(id);
    if (!input) return;
    input.terminal = true;
    if (state !== 'completed') input.needsResult = false;
    if (state === 'cancelled' && interruptRequested) this.roots.get(input.parent)!.cancelledByStop = true;
  }

  wasCancelledByStop(parent: string) { return this.roots.get(parent)?.cancelledByStop === true; }

  noteResult(id: string): boolean {
    if (this.results.has(id)) return false;
    this.results.add(id);
    if (this.results.size > 128) this.results.delete(this.results.values().next().value!);
    return true;
  }

  addUsage(parent: string, outputTokens: number): boolean {
    const root = this.roots.get(parent);
    if (!root) return false;
    root.outputTokens += outputTokens;
    root.hasUsage = true;
    return true;
  }

  completedOutputTokens(parent: string): number | null {
    const root = this.roots.get(parent);
    if (!root?.terminal || !root.hasUsage) return null;
    for (const [id, input] of this.inputs) {
      if (input.parent === parent && (!input.terminal || (input.needsResult && !this.results.has(id)))) return null;
    }
    return root.outputTokens;
  }

  clear() {
    this.inputs.clear();
    this.roots.clear();
    this.results.clear();
    this.deferredTerminal = null;
  }

  prune() {
    // Keep recent aliases for result frames that arrive after SDK terminals.
    if (this.inputs.size <= 64) return;
    for (const [id, input] of this.inputs) {
      if (input.terminal && this.roots.get(input.parent)?.terminal
        && (!input.needsResult || this.results.has(id))) this.inputs.delete(id);
      if (this.inputs.size <= 64) break;
    }
    if (this.roots.size > 64) {
      for (const [id, root] of this.roots) {
        if (root.terminal && ![...this.inputs.values()].some((input) => input.parent === id)) this.roots.delete(id);
        if (this.roots.size <= 64) break;
      }
    }
  }
}
