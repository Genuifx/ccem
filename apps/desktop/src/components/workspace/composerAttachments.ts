import type { SessionPromptAnnotation } from '@/lib/tauri-ipc';

export type ComposerAttachmentSource = 'drop' | 'paste' | 'recent' | 'search';

export interface ComposerFileAttachment {
  id: string;
  kind: 'file';
  source: ComposerAttachmentSource;
  name: string;
  absolutePath: string;
  relativePath: string | null;
  displayPath: string;
  isOutsideWorkspace: boolean;
}

export interface ComposerTextAttachment {
  id: string;
  kind: 'text';
  source: ComposerAttachmentSource;
  name: string;
  content: string;
  lineCount: number;
  charCount: number;
}

export type ComposerImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ComposerImageAttachment {
  id: string;
  kind: 'image';
  source: ComposerAttachmentSource;
  name: string;
  placeholder: string;
  mediaType: ComposerImageMediaType;
  base64Data: string;
  byteSize: number;
  objectUrl: string | null;
}

export type ComposerAttachment = ComposerFileAttachment | ComposerTextAttachment | ComposerImageAttachment;

export interface ComposerSubmitPayload {
  text: string;
  displayText?: string;
  attachments: ComposerAttachment[];
  annotations?: SessionPromptAnnotation[];
}

export interface ComposerRecentFile {
  path: string;
  relativePath: string | null;
  displayPath: string;
  name: string;
  lastUsed: number;
}

export interface ComposerImagePayload {
  mediaType: ComposerImageMediaType;
  base64Data: string;
  placeholder: string;
}

export type ComposerImagePlaceholderPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; text: string };

const RECENT_FILES_LIMIT = 8;
const RECENT_FILES_STORAGE_PREFIX = 'ccem:workspace-composer-recent-files:v1:';
const LARGE_PASTE_CHAR_THRESHOLD = 1200;
const LARGE_PASTE_LINE_THRESHOLD = 14;
const MAX_TEXT_ATTACHMENT_CHARS = 16_000;
const MAX_IMAGE_BYTE_SIZE = 10 * 1024 * 1024;
const USER_REQUEST_CLOSE_TAG = '</user_request>';

const SUPPORTED_IMAGE_TYPES: Record<string, ComposerImageMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

const IMAGE_PLACEHOLDER_RE = /\[Image #\d+\]/g;

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeComposerPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function getComposerPathName(path: string): string {
  const normalized = normalizeComposerPath(path);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function getRelativeComposerPath(path: string, workingDir?: string | null): string | null {
  if (!workingDir) {
    return null;
  }

  const normalizedPath = normalizeComposerPath(path);
  const normalizedWorkingDir = normalizeComposerPath(workingDir);
  if (normalizedPath === normalizedWorkingDir) {
    return getComposerPathName(normalizedPath);
  }

  const prefix = `${normalizedWorkingDir}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }

  return normalizedPath.slice(prefix.length);
}

export function createComposerFileAttachment(
  path: string,
  workingDir?: string | null,
  source: ComposerAttachmentSource = 'drop',
): ComposerFileAttachment {
  const normalizedPath = normalizeComposerPath(path);
  const relativePath = getRelativeComposerPath(normalizedPath, workingDir);

  return {
    id: makeId('attachment-file'),
    kind: 'file',
    source,
    name: getComposerPathName(normalizedPath),
    absolutePath: normalizedPath,
    relativePath,
    displayPath: relativePath ?? normalizedPath,
    isOutsideWorkspace: relativePath == null,
  };
}

export function createComposerTextAttachment(
  content: string,
  name?: string,
  source: ComposerAttachmentSource = 'paste',
): ComposerTextAttachment {
  const trimmedContent = content.trimEnd();
  const limitedContent = trimmedContent.length > MAX_TEXT_ATTACHMENT_CHARS
    ? `${trimmedContent.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n...[truncated]`
    : trimmedContent;
  const lineCount = limitedContent.split('\n').length;

  return {
    id: makeId('attachment-text'),
    kind: 'text',
    source,
    name: name ?? 'Pasted text',
    content: limitedContent,
    lineCount,
    charCount: limitedContent.length,
  };
}

export function isLargeComposerPaste(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const lineCount = trimmed.split('\n').length;
  return trimmed.length >= LARGE_PASTE_CHAR_THRESHOLD || lineCount >= LARGE_PASTE_LINE_THRESHOLD;
}

export function getSupportedImageMediaType(mimeType: string): ComposerImageMediaType | null {
  return SUPPORTED_IMAGE_TYPES[mimeType] ?? null;
}

export function createComposerImagePlaceholder(index: number): string {
  return `[Image #${Math.max(1, index)}]`;
}

export function splitComposerImagePlaceholders(text: string): ComposerImagePlaceholderPart[] {
  if (!text) {
    return [];
  }

  const parts: ComposerImagePlaceholderPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(IMAGE_PLACEHOLDER_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push({ kind: 'text', text: text.slice(cursor, start) });
    }
    parts.push({ kind: 'image', text: match[0] });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ kind: 'text', text: text.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}

export function getNextComposerImagePlaceholderIndex(attachments: ComposerAttachment[]): number {
  const usedIndexes = attachments
    .filter((attachment): attachment is ComposerImageAttachment => attachment.kind === 'image')
    .map((attachment) => /\[Image #(\d+)\]/.exec(attachment.placeholder)?.[1])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return usedIndexes.length > 0 ? Math.max(...usedIndexes) + 1 : 1;
}

export function validateComposerImageFile(file: File): { valid: true } | { valid: false; errorKey: string } {
  if (!SUPPORTED_IMAGE_TYPES[file.type]) {
    return { valid: false, errorKey: 'workspace.composerImageUnsupported' };
  }
  if (file.size > MAX_IMAGE_BYTE_SIZE) {
    return { valid: false, errorKey: 'workspace.composerImageTooLarge' };
  }
  return { valid: true };
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

export async function createComposerImageAttachment(
  file: File,
  name?: string,
  source: ComposerAttachmentSource = 'paste',
  placeholder = createComposerImagePlaceholder(1),
): Promise<ComposerImageAttachment> {
  const base64Data = await readFileAsBase64(file);
  const objectUrl = URL.createObjectURL(file);
  const mediaType = SUPPORTED_IMAGE_TYPES[file.type] ?? 'image/png';

  return {
    id: makeId('attachment-image'),
    kind: 'image',
    source,
    name: name ?? (file.name || 'image'),
    placeholder,
    mediaType,
    base64Data,
    byteSize: file.size,
    objectUrl,
  };
}

export function revokeComposerImageUrls(attachments: ComposerAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.objectUrl) {
      URL.revokeObjectURL(attachment.objectUrl);
    }
  }
}

export function getComposerImageAttachmentSrc(attachment: ComposerImageAttachment): string | null {
  const base64Data = attachment.base64Data.trim();
  if (base64Data) {
    return `data:${attachment.mediaType};base64,${base64Data}`;
  }
  return attachment.objectUrl;
}

export function extractComposerImagePayloads(attachments: ComposerAttachment[]): ComposerImagePayload[] {
  return attachments
    .filter((a): a is ComposerImageAttachment => a.kind === 'image')
    .map((a) => ({ mediaType: a.mediaType, base64Data: a.base64Data, placeholder: a.placeholder }));
}

function missingComposerImagePlaceholders(
  text: string,
  attachments: ComposerAttachment[],
): string[] {
  const trimmedText = text.trim();
  return attachments
    .filter((attachment): attachment is ComposerImageAttachment => attachment.kind === 'image')
    .map((attachment) => attachment.placeholder.trim())
    .filter((placeholder) => placeholder && !trimmedText.includes(placeholder));
}

export function ensureComposerImagePlaceholders(
  text: string,
  attachments: ComposerAttachment[],
): string {
  const trimmedText = text.trim();
  const missingPlaceholders = missingComposerImagePlaceholders(trimmedText, attachments);

  if (missingPlaceholders.length === 0) {
    return trimmedText;
  }

  return [
    trimmedText,
    missingPlaceholders.join('\n'),
  ].filter(Boolean).join('\n');
}

export function mergeComposerAttachments(
  previous: ComposerAttachment[],
  next: ComposerAttachment[],
): ComposerAttachment[] {
  const merged = [...previous];

  for (const attachment of next) {
    if (attachment.kind === 'file') {
      const existingIndex = merged.findIndex((candidate) =>
        candidate.kind === 'file' && candidate.absolutePath === attachment.absolutePath,
      );
      if (existingIndex >= 0) {
        merged.splice(existingIndex, 1);
      }
      merged.push(attachment);
      continue;
    }

    if (attachment.kind === 'image') {
      merged.push(attachment);
      continue;
    }

    const existingIndex = merged.findIndex((candidate) =>
      candidate.kind === 'text'
      && candidate.name === attachment.name
      && candidate.content === attachment.content,
    );
    if (existingIndex === -1) {
      merged.push(attachment);
    }
  }

  return merged;
}

function storageKey(workingDir?: string | null): string | null {
  if (!workingDir) {
    return null;
  }

  return `${RECENT_FILES_STORAGE_PREFIX}${normalizeComposerPath(workingDir)}`;
}

export function loadComposerRecentFiles(workingDir?: string | null): ComposerRecentFile[] {
  const key = storageKey(workingDir);
  if (!key || typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is ComposerRecentFile =>
      Boolean(entry)
      && typeof entry.path === 'string'
      && typeof entry.displayPath === 'string'
      && typeof entry.name === 'string'
      && typeof entry.lastUsed === 'number',
    );
  } catch {
    return [];
  }
}

export function saveComposerRecentFile(
  workingDir: string | null | undefined,
  attachment: ComposerFileAttachment,
): ComposerRecentFile[] {
  const key = storageKey(workingDir);
  if (!key || typeof window === 'undefined') {
    return [];
  }

  const nextEntry: ComposerRecentFile = {
    path: attachment.absolutePath,
    relativePath: attachment.relativePath,
    displayPath: attachment.displayPath,
    name: attachment.name,
    lastUsed: Date.now(),
  };

  const existing = loadComposerRecentFiles(workingDir)
    .filter((entry) => entry.path !== attachment.absolutePath);
  const next = [nextEntry, ...existing].slice(0, RECENT_FILES_LIMIT);

  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    return next;
  }

  return next;
}

function wrapAttachmentContent(content: string): string {
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}text\n${content}\n${fence}`;
}

function appendSectionsToText(text: string, sections: string[]): string {
  return [
    text.trim(),
    ...sections,
  ].filter(Boolean).join('\n\n').trim();
}

function appendSectionsToUserRequest(text: string, sections: string[]): string {
  const trimmedText = text.trim();
  const closeIndex = trimmedText.lastIndexOf(USER_REQUEST_CLOSE_TAG);
  if (!trimmedText.includes('<user_request>') || closeIndex === -1) {
    return appendSectionsToText(trimmedText, sections);
  }

  return [
    appendSectionsToText(trimmedText.slice(0, closeIndex), sections),
    trimmedText.slice(closeIndex).trimStart(),
  ].filter(Boolean).join('\n');
}

export function buildComposerPromptText(
  text: string,
  attachments: ComposerAttachment[],
): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) {
    return trimmedText;
  }

  const fileAttachments = attachments.filter((attachment): attachment is ComposerFileAttachment => attachment.kind === 'file');
  const textAttachments = attachments.filter((attachment): attachment is ComposerTextAttachment => attachment.kind === 'text');
  const sections: string[] = [];
  const missingImagePlaceholders = missingComposerImagePlaceholders(trimmedText, attachments);

  if (missingImagePlaceholders.length > 0) {
    sections.push(missingImagePlaceholders.join('\n'));
  }

  if (fileAttachments.length > 0) {
    sections.push([
      'Attached files:',
      ...fileAttachments.map((attachment) =>
        attachment.relativePath
          ? `- @${attachment.relativePath} (${attachment.absolutePath})`
          : `- ${attachment.absolutePath}`,
      ),
    ].join('\n'));
  }

  if (textAttachments.length > 0) {
    sections.push([
      'Attached text snippets:',
      ...textAttachments.map((attachment) => [
        `- ${attachment.name} (${attachment.lineCount} lines)`,
        wrapAttachmentContent(attachment.content),
      ].join('\n')),
    ].join('\n\n'));
  }

  return appendSectionsToUserRequest(trimmedText, sections);
}

export function buildComposerPromptPreview(
  text: string,
  attachments: ComposerAttachment[],
): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) {
    return trimmedText;
  }

  const fileCount = attachments.filter((attachment) => attachment.kind === 'file').length;
  const textCount = attachments.filter((attachment) => attachment.kind === 'text').length;
  const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length;
  const summaryLines = [
    fileCount > 0 ? `Files attached: ${fileCount}` : null,
    textCount > 0 ? `Text snippets attached: ${textCount}` : null,
    imageCount > 0 ? `Images attached: ${imageCount}` : null,
  ].filter((line): line is string => Boolean(line));

  if (!trimmedText) {
    return summaryLines.join('\n');
  }

  return [
    trimmedText,
    '',
    ...summaryLines,
  ].join('\n');
}
