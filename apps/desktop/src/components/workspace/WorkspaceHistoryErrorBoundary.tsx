import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';

interface WorkspaceHistoryErrorBoundaryProps {
  children: ReactNode;
  message: string;
  retryLabel: string;
}

interface WorkspaceHistoryErrorBoundaryState {
  hasError: boolean;
}

export class WorkspaceHistoryErrorBoundary extends Component<
  WorkspaceHistoryErrorBoundaryProps,
  WorkspaceHistoryErrorBoundaryState
> {
  state: WorkspaceHistoryErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WorkspaceHistoryErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Failed to render workspace history transcript:', error, info);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-muted-foreground">{this.props.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={this.handleRetry}>
              <RotateCcw className="mr-2 h-4 w-4" />
              {this.props.retryLabel}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
