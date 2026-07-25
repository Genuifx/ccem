export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface SelectedTextSlice {
  node: Text;
  startOffset: number;
  endOffset: number;
}

function selectedTextSlices(range: Range, root: HTMLElement): SelectedTextSlice[] {
  const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const commonAncestor = range.commonAncestorContainer;
  const startText = range.startContainer.nodeType === 3
    ? range.startContainer as Text
    : null;
  const endText = range.endContainer.nodeType === 3
    ? range.endContainer as Text
    : null;
  const textNodes: Text[] = [];

  if (startText && endText) {
    textNodes.push(startText);
    if (startText !== endText) {
      const walker = root.ownerDocument.createTreeWalker(commonAncestor, showText);
      walker.currentNode = startText;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        textNodes.push(node);
        if (node === endText) {
          break;
        }
      }
    }
  } else if (commonAncestor.nodeType === 3) {
    textNodes.push(commonAncestor as Text);
  } else {
    const walker = root.ownerDocument.createTreeWalker(commonAncestor, showText);
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }
  }
  const slices: SelectedTextSlice[] = [];

  for (const node of textNodes) {
    try {
      if (!range.intersectsNode(node)) {
        continue;
      }
    } catch {
      continue;
    }

    const startOffset = node === range.startContainer
      ? Math.max(0, Math.min(range.startOffset, node.data.length))
      : 0;
    const endOffset = node === range.endContainer
      ? Math.max(0, Math.min(range.endOffset, node.data.length))
      : node.data.length;
    if (startOffset >= endOffset) {
      continue;
    }
    slices.push({ node, startOffset, endOffset });
  }

  while (slices[0] && !/\S/.test(slices[0].node.data.slice(
    slices[0].startOffset,
    slices[0].endOffset,
  ))) {
    slices.shift();
  }
  while (slices[slices.length - 1] && !/\S/.test(slices[slices.length - 1].node.data.slice(
    slices[slices.length - 1].startOffset,
    slices[slices.length - 1].endOffset,
  ))) {
    slices.pop();
  }

  const first = slices[0];
  const last = slices[slices.length - 1];
  if (first) {
    first.startOffset += first.node.data
      .slice(first.startOffset, first.endOffset)
      .match(/^\s*/)?.[0].length ?? 0;
  }
  if (last) {
    last.endOffset -= last.node.data
      .slice(last.startOffset, last.endOffset)
      .match(/\s*$/)?.[0].length ?? 0;
  }

  return slices.filter((slice) => slice.startOffset < slice.endOffset);
}

export function visibleTextRangeRects(range: Range, root: HTMLElement): ViewportRect[] {
  const rootRect = root.getBoundingClientRect();
  return selectedTextSlices(range, root).flatMap((slice) => {
    const textRange = root.ownerDocument.createRange();
    textRange.setStart(slice.node, slice.startOffset);
    textRange.setEnd(slice.node, slice.endOffset);

    return Array.from(textRange.getClientRects()).flatMap<ViewportRect>((rect) => {
      const left = Math.max(rect.left, rootRect.left);
      const top = Math.max(rect.top, rootRect.top);
      const right = Math.min(rect.right, rootRect.right);
      const bottom = Math.min(rect.bottom, rootRect.bottom);
      if (right <= left || bottom <= top) {
        return [];
      }
      return [{
        left,
        top,
        width: right - left,
        height: bottom - top,
        right,
        bottom,
      }];
    });
  });
}
