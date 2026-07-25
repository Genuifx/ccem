const DEFAULT_IGNORABLE_RANGES = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
] as const;

function belongsToRange(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>) {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isLookalikeQuote(codePoint: number) {
  return (codePoint >= 0x02b9 && codePoint <= 0x02bd)
    || codePoint === 0x02cb
    || (codePoint >= 0x2018 && codePoint <= 0x201f)
    || (codePoint >= 0x2032 && codePoint <= 0x2037)
    || codePoint === 0xff02
    || codePoint === 0xff07
    || codePoint === 0xff40;
}

function shouldExposeCodePoint(codePoint: number) {
  return belongsToRange(codePoint, DEFAULT_IGNORABLE_RANGES)
    || (codePoint >= 0x0000 && codePoint <= 0x001f)
    || (codePoint >= 0x007f && codePoint <= 0x009f)
    || (codePoint >= 0x2028 && codePoint <= 0x2029)
    || (codePoint >= 0xfff9 && codePoint <= 0xfffb)
    || (codePoint >= 0x275b && codePoint <= 0x275e)
    || (codePoint >= 0x301d && codePoint <= 0x301f)
    || isLookalikeQuote(codePoint);
}

function visibleCodePoint(codePoint: number) {
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
}

/**
 * Produces a display-only permission preview. It never normalizes or mutates
 * the input used to execute the tool.
 */
export function formatPermissionPreview(value: string, maxLength = 160): string {
  if (maxLength <= 0) {
    return '';
  }

  const tokens: string[] = [];
  let displayLength = 0;
  let pendingSpace = false;

  const appendToken = (token: string) => {
    if (displayLength + token.length <= maxLength) {
      tokens.push(token);
      displayLength += token.length;
      return null;
    }

    if (maxLength === 1) {
      return '…';
    }

    const availableLength = maxLength - 1;
    while (tokens.length > 0 && displayLength > availableLength) {
      displayLength -= tokens.pop()!.length;
    }
    while (tokens.at(-1) === ' ') {
      displayLength -= tokens.pop()!.length;
    }
    return `${tokens.join('')}…`;
  };

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (shouldExposeCodePoint(codePoint)) {
      if (pendingSpace && tokens.length > 0) {
        const truncated = appendToken(' ');
        if (truncated) return truncated;
      }
      pendingSpace = false;
      const truncated = appendToken(visibleCodePoint(codePoint));
      if (truncated) return truncated;
      continue;
    }

    if (/\s/u.test(character)) {
      pendingSpace = tokens.length > 0;
      continue;
    }

    if (pendingSpace) {
      const truncated = appendToken(' ');
      if (truncated) return truncated;
      pendingSpace = false;
    }
    const truncated = appendToken(character);
    if (truncated) return truncated;
  }

  return tokens.join('');
}
