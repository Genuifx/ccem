// Pass this function directly to Playwright page.evaluate(). It uses only
// browser globals; importing this module never opens an app or browser.
export function installEditorStyleMutationProbe() {
  window.__workspaceInputStyleProbe?.stop();
  const generation = (window.__workspaceInputStyleProbeGeneration ?? 0) + 1;
  window.__workspaceInputStyleProbeGeneration = generation;
  let active = true;
  const counts = { supported: typeof MutationObserver !== 'undefined',
    heightStyleMutations: 0, heightAutoMutations: 0, styleMutationRecords: 0,
    editorCount: 0, generation,
    meaning: 'Actual inline height transitions; repeated same-value setter attempts are not counted.' };
  const heightOf = (style) => /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style ?? '')?.[1].trim() ?? '';
  function consume(records) {
    if (!active || window.__workspaceInputStyleProbeGeneration !== generation) return;
    // MutationRecord provides the old value only. The next record for this
    // editor holds the result of the current mutation, even when JS sets
    // height=auto and height=<px> in the same task. The last result is live style.
    const nextStyle = new Map();
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record.attributeName !== 'style') continue;
      const resultingStyle = nextStyle.has(record.target)
        ? nextStyle.get(record.target) : record.target.getAttribute('style');
      const previousHeight = heightOf(record.oldValue);
      const resultingHeight = heightOf(resultingStyle);
      counts.styleMutationRecords++;
      if (previousHeight !== resultingHeight) {
        counts.heightStyleMutations++;
        if (resultingHeight === 'auto') counts.heightAutoMutations++;
      }
      nextStyle.set(record.target, record.oldValue);
    }
  }
  const observer = counts.supported ? new MutationObserver(consume) : null;
  for (const editor of document.querySelectorAll('[data-perf-session] [contenteditable="true"]')) {
    observer?.observe(editor, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    counts.editorCount++;
  }
  const sample = () => {
    if (observer) consume(observer.takeRecords());
    return { ...counts };
  };
  window.__workspaceInputStyleProbe = {
    sample,
    stop() {
      const result = sample();
      active = false;
      observer?.disconnect();
      return result;
    },
  };
  return sample();
}
