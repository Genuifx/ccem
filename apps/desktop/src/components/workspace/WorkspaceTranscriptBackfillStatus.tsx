import { ErrorBanner } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { AlertTriangle, LoaderCircle } from '@/lib/lucide-react';

export type WorkspaceTranscriptBackfillState = 'idle' | 'loading' | 'partial' | 'error';

interface WorkspaceTranscriptBackfillStatusProps {
  state: WorkspaceTranscriptBackfillState;
  loadingMessage: string;
  errorMessage: string;
  partialMessage: string;
  retryLabel: string;
  onRetry: () => void;
}

export function WorkspaceTranscriptBackfillStatus({
  state,
  loadingMessage,
  errorMessage,
  partialMessage,
  retryLabel,
  onRetry,
}: WorkspaceTranscriptBackfillStatusProps) {
  if (state === 'idle') {
    return null;
  }

  if (state === 'error') {
    return (
      <div className="mb-5">
        <ErrorBanner message={errorMessage} retryLabel={retryLabel} onRetry={onRetry} />
      </div>
    );
  }

  if (state === 'partial') {
    return (
      <div
        role="alert"
        className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-warning/25 bg-warning/8 px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-warning">
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>{partialMessage}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="h-7 shrink-0 border-warning/25 text-warning hover:bg-warning/10 hover:text-warning"
        >
          {retryLabel}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-5 flex items-center gap-2 rounded-lg border border-border/50 bg-surface/55 px-3 py-2 text-xs text-muted-foreground"
    >
      <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span>{loadingMessage}</span>
    </div>
  );
}
