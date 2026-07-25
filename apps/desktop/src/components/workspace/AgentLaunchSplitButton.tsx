import { Claude, Codex, OpenCode } from '@lobehub/icons';
import { ChevronDown } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface AgentLaunchSplitButtonProps {
  newSessionLabel: string;
  claudeLabel: string;
  codexLabel: string;
  opencodeLabel: string;
  codexUnavailableLabel: string;
  codexInstalled?: boolean;
  opencodeInstalled?: boolean;
  className?: string;
  onLaunchClaude: () => void;
  onLaunchCodex: () => void;
  onLaunchOpenCode: () => void;
}

export function AgentLaunchSplitButton({
  newSessionLabel,
  claudeLabel,
  codexLabel,
  opencodeLabel,
  codexUnavailableLabel,
  codexInstalled = false,
  opencodeInstalled = false,
  className,
  onLaunchClaude,
  onLaunchCodex,
  onLaunchOpenCode,
}: AgentLaunchSplitButtonProps) {
  return (
    <ButtonGroup className={cn('w-full', className)} aria-label={newSessionLabel}>
      <Button
        data-testid="workspace-launch-claude"
        variant="outline"
        size="sm"
        className="flex-1 gap-2"
        onClick={onLaunchClaude}
        aria-label={`${newSessionLabel}: ${claudeLabel}`}
      >
        <Claude.Color size={14} />
        <span className="text-xs font-semibold">{claudeLabel}</span>
      </Button>

      <ButtonGroupSeparator />

      <div className="flex flex-1 items-stretch">
        <Button
          data-testid="workspace-launch-codex"
          variant="outline"
          size="sm"
          className="flex-1 gap-2 rounded-r-none border-r-0"
          onClick={onLaunchCodex}
          disabled={!codexInstalled}
          aria-label={
            codexInstalled
              ? `${newSessionLabel}: ${codexLabel}`
              : `${codexLabel} ${codexUnavailableLabel}`
          }
        >
          <Codex.Color size={14} />
          <span className="text-xs font-semibold">{codexLabel}</span>
          {!codexInstalled && (
            <span className="text-2xs text-muted-foreground">({codexUnavailableLabel})</span>
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-testid="workspace-launch-menu-trigger"
              variant="outline"
              size="sm"
              className="w-9 rounded-l-none px-0"
              aria-label={opencodeLabel}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem
              data-testid="workspace-launch-opencode"
              disabled={!opencodeInstalled}
              onSelect={() => {
                if (opencodeInstalled) {
                  onLaunchOpenCode();
                }
              }}
              aria-label={
                opencodeInstalled
                  ? `${newSessionLabel}: ${opencodeLabel}`
                  : `${opencodeLabel} ${codexUnavailableLabel}`
              }
            >
              <OpenCode className="mr-2 h-4 w-4" size={16} />
              <span>{opencodeLabel}</span>
              {!opencodeInstalled && (
                <span className="ml-auto text-2xs text-muted-foreground">
                  {codexUnavailableLabel}
                </span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ButtonGroup>
  );
}
