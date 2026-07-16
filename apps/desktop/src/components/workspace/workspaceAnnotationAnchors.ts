import {
  normalizeWorkspaceSelection,
  type WorkspaceAnnotation,
  type WorkspaceAnnotationAnchor,
} from './workspaceAnnotationModel';

const TRANSCRIPT_ITEM_SELECTOR = '[data-transcript-item-key]';

function closestTranscriptItem(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const item = element?.closest<HTMLElement>(TRANSCRIPT_ITEM_SELECTOR) ?? null;
  return item && root.contains(item) ? item : null;
}

function itemKey(item: HTMLElement): string | null {
  return item.dataset.transcriptItemKey?.trim() || null;
}

function characterOffsetWithin(
  item: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(item);
    prefix.setEnd(container, offset);
    return prefix.toString().length;
  } catch {
    return null;
  }
}

function textBoundaryAt(item: HTMLElement, characterOffset: number): {
  node: Text;
  offset: number;
} | null {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let lastTextNode: Text | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    lastTextNode = node;
    const nextConsumed = consumed + node.data.length;
    if (characterOffset <= nextConsumed) {
      return { node, offset: Math.max(0, characterOffset - consumed) };
    }
    consumed = nextConsumed;
  }

  if (lastTextNode && characterOffset === consumed) {
    return { node: lastTextNode, offset: lastTextNode.data.length };
  }
  return null;
}

function transcriptItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TRANSCRIPT_ITEM_SELECTOR));
}

function findItem(root: HTMLElement, key: string): HTMLElement | null {
  return transcriptItems(root).find((item) => itemKey(item) === key) ?? null;
}

function rangeFromAnchor(
  root: HTMLElement,
  anchor: WorkspaceAnnotationAnchor,
): Range | null {
  const startItem = findItem(root, anchor.startItemKey);
  const endItem = findItem(root, anchor.endItemKey);
  if (!startItem || !endItem) {
    return null;
  }

  const start = textBoundaryAt(startItem, anchor.startOffset);
  const end = textBoundaryAt(endItem, anchor.endOffset);
  if (!start || !end) {
    return null;
  }

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

function rangeForExactQuote(root: HTMLElement, quote: string): Range | null {
  for (const item of transcriptItems(root)) {
    const text = item.textContent ?? '';
    const startOffset = text.indexOf(quote);
    if (startOffset < 0) {
      continue;
    }
    const start = textBoundaryAt(item, startOffset);
    const end = textBoundaryAt(item, startOffset + quote.length);
    if (!start || !end) {
      continue;
    }
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }
  return null;
}

export function captureWorkspaceAnnotationAnchor(
  root: HTMLElement,
  range: Range,
): WorkspaceAnnotationAnchor | null {
  const startItem = closestTranscriptItem(root, range.startContainer);
  const endItem = closestTranscriptItem(root, range.endContainer);
  if (!startItem || !endItem) {
    return null;
  }

  const startItemKey = itemKey(startItem);
  const endItemKey = itemKey(endItem);
  const startOffset = characterOffsetWithin(startItem, range.startContainer, range.startOffset);
  const endOffset = characterOffsetWithin(endItem, range.endContainer, range.endOffset);
  if (!startItemKey || !endItemKey || startOffset == null || endOffset == null) {
    return null;
  }

  return { startItemKey, startOffset, endItemKey, endOffset };
}

export function resolveWorkspaceAnnotationRange(
  root: HTMLElement,
  annotation: Pick<WorkspaceAnnotation, 'quote' | 'anchor'>,
): Range | null {
  if (annotation.anchor) {
    const anchoredRange = rangeFromAnchor(root, annotation.anchor);
    if (anchoredRange && normalizeWorkspaceSelection(anchoredRange.toString()) === annotation.quote) {
      return anchoredRange;
    }
  }

  return rangeForExactQuote(root, annotation.quote);
}
