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

interface ItemTextIndex {
  nodes: Text[];
  starts: number[];
  indicesByNode: Map<Text, number>;
  total: number;
}

type ItemTextIndexCache = Map<HTMLElement, ItemTextIndex>;

function buildItemTextIndex(item: HTMLElement): ItemTextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const indicesByNode = new Map<Text, number>();
  let total = 0;
  const walker = item.ownerDocument.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    indicesByNode.set(node, nodes.length);
    nodes.push(node);
    starts.push(total);
    total += node.data.length;
  }
  return { nodes, starts, indicesByNode, total };
}

function itemTextIndex(item: HTMLElement, cache?: ItemTextIndexCache): ItemTextIndex {
  if (!cache) {
    return buildItemTextIndex(item);
  }
  const cached = cache.get(item);
  if (cached) {
    return cached;
  }
  const built = buildItemTextIndex(item);
  cache.set(item, built);
  return built;
}

// One TreeWalker-free lookup per boundary: the item's text nodes and cumulative
// offsets are indexed once per placement pass, then offsets resolve by binary
// search instead of walking the item again for every annotation.
function textBoundaryAt(
  item: HTMLElement,
  characterOffset: number,
  cache?: ItemTextIndexCache,
): {
  node: Text;
  offset: number;
} | null {
  const index = itemTextIndex(item, cache);
  if (characterOffset < 0 || characterOffset > index.total || index.nodes.length === 0) {
    return null;
  }

  let low = 0;
  let high = index.nodes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const end = index.starts[mid] + index.nodes[mid].data.length;
    if (characterOffset <= end) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (found < 0) {
    if (characterOffset === index.total) {
      const last = index.nodes.length - 1;
      return { node: index.nodes[last], offset: index.nodes[last].data.length };
    }
    return null;
  }

  const node = index.nodes[found];
  return { node, offset: Math.max(0, characterOffset - index.starts[found]) };
}

function textBetweenBoundaries(
  index: ItemTextIndex,
  start: { node: Text; offset: number },
  end: { node: Text; offset: number },
): string | null {
  if (start.node === end.node) {
    return start.node.data.slice(start.offset, end.offset);
  }
  const startNodeIndex = index.indicesByNode.get(start.node);
  const endNodeIndex = index.indicesByNode.get(end.node);
  if (startNodeIndex == null || endNodeIndex == null || startNodeIndex > endNodeIndex) {
    return null;
  }
  const parts: string[] = [start.node.data.slice(start.offset)];
  for (let nodeIndex = startNodeIndex + 1; nodeIndex < endNodeIndex; nodeIndex += 1) {
    parts.push(index.nodes[nodeIndex].data);
  }
  parts.push(end.node.data.slice(0, end.offset));
  return parts.join('');
}

function transcriptItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TRANSCRIPT_ITEM_SELECTOR));
}

function findItem(root: HTMLElement, key: string): HTMLElement | null {
  return transcriptItems(root).find((item) => itemKey(item) === key) ?? null;
}

type ItemIndex = Map<string, HTMLElement>;

function buildItemIndex(
  root: HTMLElement,
  items: HTMLElement[] = transcriptItems(root),
): ItemIndex {
  const index: ItemIndex = new Map();
  for (const item of items) {
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
  textCache?: ItemTextIndexCache,
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

  const start = textBoundaryAt(startItem, anchor.startOffset, textCache);
  const end = textBoundaryAt(endItem, anchor.endOffset, textCache);
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

function rangeForExactQuote(
  root: HTMLElement,
  quote: string,
  items?: HTMLElement[],
  textCache?: ItemTextIndexCache,
): Range | null {
  for (const item of items ?? transcriptItems(root)) {
    const text = item.textContent ?? '';
    const startOffset = text.indexOf(quote);
    if (startOffset < 0) {
      continue;
    }
    const start = textBoundaryAt(item, startOffset, textCache);
    const end = textBoundaryAt(item, startOffset + quote.length, textCache);
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
  textCache?: ItemTextIndexCache,
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

  const start = textBoundaryAt(startItem, anchor.startOffset, textCache);
  const end = textBoundaryAt(endItem, anchor.endOffset, textCache);
  if (!start || !end) {
    return null;
  }

  // Single-item selections are the common case and can be read straight from
  // the text-node index, avoiding the DOM fragment allocation that dominates
  // repeated placement passes. Cross-item selections keep the Range path so
  // any text between the two items has the exact same semantics.
  if (startItem === endItem) {
    return textBetweenBoundaries(itemTextIndex(startItem, textCache), start, end);
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
  const items = transcriptItems(root);
  const index = buildItemIndex(root, items);
  const textCache: ItemTextIndexCache = new Map();
  return annotations.map((annotation) => {
    if (annotation.anchor) {
      const anchoredRange = rangeFromAnchor(root, annotation.anchor, index, textCache);
      const domText = domTextBetween(root, annotation.anchor, index, textCache);
      if (
        anchoredRange
        && domText !== null
        && normalizeWorkspaceSelection(domText) === annotation.quote
      ) {
        return anchoredRange;
      }
      return null;
    }
    return rangeForExactQuote(root, annotation.quote, items, textCache);
  });
}
