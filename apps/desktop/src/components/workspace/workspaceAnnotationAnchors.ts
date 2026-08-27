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
    // cloneContents().textContent concatenates raw text node data, unlike
    // Range.toString() which WebKit augments with synthetic newlines at block
    // boundaries. Offsets must live in the raw-text space so they round-trip
    // through textBoundaryAt / domTextBelow.
    return prefix.cloneContents().textContent?.length ?? null;
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

type ItemIndex = Map<string, HTMLElement>;

function buildItemIndex(root: HTMLElement): ItemIndex {
  const index: ItemIndex = new Map();
  for (const item of transcriptItems(root)) {
    const key = itemKey(item);
    if (key) {
      index.set(key, item);
    }
  }
  return index;
}

function indexedFindItem(index: ItemIndex, key: string): HTMLElement | null {
  return index.get(key) ?? null;
}

function rangeFromAnchor(
  root: HTMLElement,
  anchor: WorkspaceAnnotationAnchor,
  index?: ItemIndex,
): Range | null {
  const startItem = index
    ? indexedFindItem(index, anchor.startItemKey)
    : findItem(root, anchor.startItemKey);
  const endItem = index
    ? indexedFindItem(index, anchor.endItemKey)
    : findItem(root, anchor.endItemKey);
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

// Raw text-node content between the anchor's offsets. This is the canonical
// text space for quotes: WebKit's Range/Selection.toString() inserts
// synthetic newlines at block boundaries which never exist in the DOM, so
// multi-line selections must be captured and re-validated in this space.
export function domTextBetween(
  root: HTMLElement,
  anchor: WorkspaceAnnotationAnchor,
  index?: ItemIndex,
): string | null {
  const startItem = index
    ? indexedFindItem(index, anchor.startItemKey)
    : findItem(root, anchor.startItemKey);
  const endItem = index
    ? indexedFindItem(index, anchor.endItemKey)
    : findItem(root, anchor.endItemKey);
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
    return range.cloneContents().textContent ?? null;
  } catch {
    return null;
  }
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
    const domText = domTextBetween(root, annotation.anchor);
    if (
      anchoredRange
      && domText !== null
      && normalizeWorkspaceSelection(domText) === annotation.quote
    ) {
      return anchoredRange;
    }
    // The annotation was captured with an anchor but that anchor no longer
    // resolves (item unmounted, segment switched, digest collapsed). Falling
    // back to a first-match quote search would highlight an unrelated
    // occurrence of the same text, so the annotation stays unanchored and is
    // still manageable from the composer list instead.
    return null;
  }

  // Legacy annotations stored before anchors existed.
  return rangeForExactQuote(root, annotation.quote);
}

// Batch resolution for the placement pass: builds the transcript item index
// once instead of re-querying the DOM for every annotation.
export function resolveWorkspaceAnnotationRanges(
  root: HTMLElement,
  annotations: ReadonlyArray<Pick<WorkspaceAnnotation, 'quote' | 'anchor'>>,
): Array<Range | null> {
  const index = buildItemIndex(root);
  return annotations.map((annotation) => {
    if (annotation.anchor) {
      const anchoredRange = rangeFromAnchor(root, annotation.anchor, index);
      const domText = domTextBetween(root, annotation.anchor, index);
      if (
        anchoredRange
        && domText !== null
        && normalizeWorkspaceSelection(domText) === annotation.quote
      ) {
        return anchoredRange;
      }
      return null;
    }
    return rangeForExactQuote(root, annotation.quote);
  });
}
