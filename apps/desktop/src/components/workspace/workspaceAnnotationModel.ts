export const MAX_WORKSPACE_SELECTION_CHARS = 12_000;
export const MAX_WORKSPACE_ANNOTATION_NOTE_CHARS = 4_000;
export const MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS = 60_000;
export const MAX_WORKSPACE_ANNOTATIONS = 20;
const MAX_WORKSPACE_ANNOTATION_ITEM_KEY_CHARS = 512;
const MAX_WORKSPACE_ANNOTATION_ANCHOR_OFFSET = 1_000_000;

export interface WorkspaceAnnotationAnchor {
  startItemKey: string;
  startOffset: number;
  endItemKey: string;
  endOffset: number;
}

export interface WorkspaceAnnotation {
  id: string;
  quote: string;
  note: string;
  createdAt: string;
  anchor?: WorkspaceAnnotationAnchor;
}

export function normalizeWorkspaceSelection(value: string): string | null {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .trim();
  if (!normalized || normalized.length > MAX_WORKSPACE_SELECTION_CHARS) {
    return null;
  }
  return normalized;
}

function isWorkspaceAnnotation(value: unknown): value is WorkspaceAnnotation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<WorkspaceAnnotation>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.quote === 'string'
    && candidate.quote.length > 0
    && candidate.quote.length <= MAX_WORKSPACE_SELECTION_CHARS
    && typeof candidate.note === 'string'
    && candidate.note.trim().length > 0
    && candidate.note.length <= MAX_WORKSPACE_ANNOTATION_NOTE_CHARS
    && typeof candidate.createdAt === 'string'
    && candidate.createdAt.length > 0;
}

function normalizeWorkspaceAnnotationAnchor(value: unknown): WorkspaceAnnotationAnchor | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Partial<WorkspaceAnnotationAnchor>;
  const validItemKey = (itemKey: unknown): itemKey is string => (
    typeof itemKey === 'string'
    && itemKey.length > 0
    && itemKey.length <= MAX_WORKSPACE_ANNOTATION_ITEM_KEY_CHARS
  );
  const validOffset = (offset: unknown): offset is number => (
    typeof offset === 'number'
    && Number.isInteger(offset)
    && offset >= 0
    && offset <= MAX_WORKSPACE_ANNOTATION_ANCHOR_OFFSET
  );

  if (
    !validItemKey(candidate.startItemKey)
    || !validItemKey(candidate.endItemKey)
    || !validOffset(candidate.startOffset)
    || !validOffset(candidate.endOffset)
  ) {
    return undefined;
  }

  return {
    startItemKey: candidate.startItemKey,
    startOffset: candidate.startOffset,
    endItemKey: candidate.endItemKey,
    endOffset: candidate.endOffset,
  };
}

export function normalizeStoredWorkspaceAnnotations(value: unknown): WorkspaceAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const candidates = value
    .filter(isWorkspaceAnnotation)
    .slice(-MAX_WORKSPACE_ANNOTATIONS);
  let retainedChars = 0;
  return candidates
    .filter((annotation) => {
      const nextChars = annotation.quote.length + annotation.note.length;
      if (retainedChars + nextChars > MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS) {
        return false;
      }
      retainedChars += nextChars;
      return true;
    })
    .map((annotation) => {
      const anchor = normalizeWorkspaceAnnotationAnchor(annotation.anchor);
      return {
        id: annotation.id,
        quote: annotation.quote.trim(),
        note: annotation.note.trim(),
        createdAt: annotation.createdAt,
        ...(anchor ? { anchor } : {}),
      };
    });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildComposerPromptWithAnnotations(
  prompt: string,
  annotations: WorkspaceAnnotation[],
): string {
  const validAnnotations = normalizeStoredWorkspaceAnnotations(annotations);
  if (validAnnotations.length === 0) {
    return prompt;
  }

  const annotationBlocks = validAnnotations.flatMap((annotation, index) => [
    `  <annotation index="${index + 1}">`,
    `    <selected_text>${escapeXml(annotation.quote)}</selected_text>`,
    `    <note>${escapeXml(annotation.note)}</note>`,
    '  </annotation>',
  ]);
  const request = prompt.trim();

  return [
    '<workspace_annotations>',
    ...annotationBlocks,
    '  <instruction>Treat these annotations as the user\'s requested changes. Use each note in the context of its selected text.</instruction>',
    '</workspace_annotations>',
    ...(request ? ['', '<user_request>', request, '</user_request>'] : []),
  ].join('\n');
}
