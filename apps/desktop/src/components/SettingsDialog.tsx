import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TerminalOption = "terminal" | "iterm2" | "warp" | "ghostty";

interface TerminalInfo {
  id: TerminalOption;
  name: string;
  description: string;
}

const TERMINAL_OPTIONS: TerminalInfo[] = [
  {
    id: "terminal",
    name: "Terminal.app",
    description: "macOS built-in terminal emulator",
  },
  {
    id: "iterm2",
    name: "iTerm2",
    description: "Feature-rich terminal with split panes and profiles",
  },
  {
    id: "warp",
    name: "Warp",
    description: "Modern terminal with AI-powered features",
  },
  {
    id: "ghostty",
    name: "Ghostty",
    description: "Fast, native terminal built with Zig",
  },
];

const STORAGE_KEY = "ccem-settings";

interface Settings {
  terminal: TerminalOption;
}

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return { terminal: "terminal" };
}

function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [terminal, setTerminal] = React.useState<TerminalOption>("terminal");

  // Load settings from localStorage on mount
  React.useEffect(() => {
    const settings = loadSettings();
    setTerminal(settings.terminal);
  }, []);

  // Save settings when terminal changes
  React.useEffect(() => {
    saveSettings({ terminal });
  }, [terminal]);

  const handleTerminalChange = (value: TerminalOption) => {
    setTerminal(value);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your CCEM Desktop preferences.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Terminal Settings Section */}
          <div className="space-y-3">
            <div>
              <Label className="text-base font-medium">Terminal</Label>
              <p className="text-sm text-muted-foreground">
                Select your preferred terminal emulator for launching Claude Code.
              </p>
            </div>
            <div className="space-y-2">
              {TERMINAL_OPTIONS.map((option) => (
                <label
                  key={option.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    terminal === option.id
                      ? "bg-primary/10 border-primary/30"
                      : "bg-muted/30 border-transparent hover:bg-muted/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="terminal"
                    value={option.id}
                    checked={terminal === option.id}
                    onChange={() => handleTerminalChange(option.id)}
                    className="mt-1 h-4 w-4 text-primary focus:ring-primary"
                  />
                  <div className="flex-1">
                    <span className="font-medium text-foreground">
                      {option.name}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {option.description}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* App Settings Section */}
          <div className="space-y-3">
            <div>
              <Label className="text-base font-medium">App Settings</Label>
              <p className="text-sm text-muted-foreground">
                General application preferences.
              </p>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-transparent opacity-60 cursor-not-allowed">
                <input
                  type="checkbox"
                  disabled
                  className="h-4 w-4 rounded border-muted-foreground"
                />
                <div className="flex-1">
                  <span className="font-medium text-foreground">
                    Start at login
                  </span>
                  <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                    Coming soon
                  </span>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-transparent opacity-60 cursor-not-allowed">
                <input
                  type="checkbox"
                  disabled
                  className="h-4 w-4 rounded border-muted-foreground"
                />
                <div className="flex-1">
                  <span className="font-medium text-foreground">
                    Minimize to tray on close
                  </span>
                  <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                    Coming soon
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* About Section */}
          <div className="space-y-3 pt-2 border-t">
            <div>
              <Label className="text-base font-medium">About</Label>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Version</span>
                <span className="font-medium text-foreground">
                  CCEM Desktop v1.8.0
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Source Code</span>
                <a
                  href="https://github.com/Genuifx/ccem"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub Repository
                </a>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
