import { forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { domToPng } from 'modern-screenshot';
import { invoke } from '@tauri-apps/api/core';
import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';

/**
 * Off-screen node used to render a transcript message's markdown for image export.
 * Mounted on demand (only while exporting). Portaled to <body> so the message
 * meta bar's flex layout and hover opacity transition cannot affect the export.
 *
 * Positioning note: keep the node at on-screen coordinates (0,0) hidden behind
 * app content via a negative z-index. modern-screenshot renders fully
 * transparent images for elements placed at negative offsets (e.g.
 * `left: -10000px`), and it copies `opacity`/`visibility` into the export.
 */
export const TRANSCRIPT_IMAGE_EXPORT_WIDTH = 720;

export const TranscriptImageExportNode = forwardRef<
  HTMLDivElement,
  { content: string }
>(function TranscriptImageExportNode({ content }, ref) {
  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0"
      style={{
        width: TRANSCRIPT_IMAGE_EXPORT_WIDTH,
        flexShrink: 0,
        zIndex: -1,
        backgroundColor: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      <div style={{ padding: '20px 24px' }}>
        <MarkdownRenderer
          content={content}
          className="text-[14px] leading-7"
          codeTone="reading"
        />
      </div>
    </div>,
    document.body,
  );
});

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Renders the node to PNG and writes it to the clipboard.
 * Native path first (copy_image_to_clipboard), Web ClipboardItem as fallback.
 */
export async function copyTranscriptNodeToClipboard(node: HTMLElement): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const dataUrl = await domToPng(node, { scale: 2 });
  const base64Png = dataUrl.split(',')[1] ?? '';
  try {
    await invoke('copy_image_to_clipboard', { base64Png });
  } catch (nativeError) {
    if (!navigator.clipboard?.write || !window.ClipboardItem) {
      throw nativeError;
    }
    const blob = await dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
  }
}
