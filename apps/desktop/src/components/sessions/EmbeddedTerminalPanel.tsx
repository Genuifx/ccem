import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Monitor, SquareTerminal } from '@/lib/lucide-react';
import type { Session } from '@/store';
import type { ChannelKind, TmuxAttachTerminalInfo, TmuxAttachTerminalType } from '@/lib/tauri-ipc';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { cn, getProjectName } from '@/lib/utils';
import '@xterm/xterm/css/xterm.css';
import { OpenInTerminalPopoverButton } from './OpenInTerminalPopoverButton';

interface InteractiveOutputChunk {
  session_id: string;
  seq: number;
  occurred_at: string;
  data: string;
}

interface EmbeddedTerminalPanelProps {
  sessions: Session[];
  activeSessionId: string | null;
  terminalOptions?: TmuxAttachTerminalInfo[];
  onSelect: (sessionId: string) => void;
  onOpenInTerminal: (sessionId: string, terminalType?: TmuxAttachTerminalType) => void;
}


const DESKTOP_UI_CHANNEL: ChannelKind = { kind: 'desktop_ui' };

export function EmbeddedTerminalPanel({
  sessions,
  activeSessionId,
  terminalOptions,
  onSelect,
  onOpenInTerminal,
}: EmbeddedTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const lastSeqRef = useRef<number | null>(null);
  const {
    attachChannel,
    detachChannel,
    getInteractiveSessionOutput,
    resizeInteractiveSession,
    writeInteractiveInput,
  } = useTauriCommands();
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeClientLabel = activeSession?.client === 'opencode'
    ? 'OpenCode PTY'
    : activeSession?.client === 'codex'
      ? 'Codex PTY'
      : 'Claude PTY';

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    void attachChannel(activeSessionId, DESKTOP_UI_CHANNEL).catch((error) => {
      console.error('Failed to attach desktop channel for embedded terminal:', error);
    });

    return () => {
      void detachChannel(activeSessionId, DESKTOP_UI_CHANNEL).catch(() => {});
    };
  }, [activeSessionId, attachChannel, detachChannel]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", "Monaco", "Menlo", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      convertEol: false,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#f8fafc',
        black: '#020617',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#ec4899',
        cyan: '#06b6d4',
        white: '#f8fafc',
        brightBlack: '#334155',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#f472b6',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.focus();

    const disposable = terminal.onData((data) => {
      const currentSessionId = activeSessionIdRef.current;
      if (!currentSessionId) {
        return;
      }
      void writeInteractiveInput(currentSessionId, data).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      const currentSessionId = activeSessionIdRef.current;
      if (!currentSessionId) {
        return;
      }
      void resizeInteractiveSession(currentSessionId, terminal.cols, terminal.rows).catch(() => {});
    });
    observer.observe(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      observer.disconnect();
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [resizeInteractiveSession, writeInteractiveInput]);

  useEffect(() => {
    let cancelled = false;
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.reset();
    lastSeqRef.current = null;

    if (!activeSessionId) {
      terminal.writeln('[ccem] Select an embedded session to attach.');
      return;
    }

    const loadSnapshot = async () => {
      const snapshot = await getInteractiveSessionOutput(activeSessionId, null);
      if (cancelled || activeSessionIdRef.current !== activeSessionId) {
        return;
      }

      if (snapshot.gap_detected) {
        terminal.writeln('[ccem] Output gap detected. Showing buffered transcript only.');
      }

      for (const chunk of snapshot.chunks) {
        terminal.write(chunk.data);
        lastSeqRef.current = chunk.seq;
      }

      fitAddonRef.current?.fit();
      void resizeInteractiveSession(activeSessionId, terminal.cols, terminal.rows).catch(() => {});
      terminal.focus();
    };

    void loadSnapshot().catch((error) => {
      if (!cancelled) {
        terminal.writeln(`\r\n[ccem] Failed to load terminal transcript: ${String(error)}\r\n`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, getInteractiveSessionOutput, resizeInteractiveSession]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<InteractiveOutputChunk>('interactive-session-output', (event) => {
        const terminal = terminalRef.current;
        const currentSessionId = activeSessionIdRef.current;
        if (!terminal || !currentSessionId || event.payload.session_id !== currentSessionId) {
          return;
        }
        if (lastSeqRef.current != null && event.payload.seq <= lastSeqRef.current) {
          return;
        }
        lastSeqRef.current = event.payload.seq;
        terminal.write(event.payload.data);
      });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <div className="rounded-2xl border border-black/[0.08] bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.94))] shadow-[0_24px_80px_rgba(15,23,42,0.24)] overflow-hidden">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/80">
              <SquareTerminal className="h-4 w-4" />
              Embedded Terminal
            </div>
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                    isActive
                      ? 'border-cyan-300/60 bg-cyan-300/15 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10'
                  )}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  <span>{getProjectName(session.workingDir)}</span>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                    {session.envName}
                  </span>
                </button>
              );
            })}
          </div>
          <OpenInTerminalPopoverButton
            sessionId={activeSession?.id ?? null}
            terminals={terminalOptions}
            disabled={!activeSession || activeSession.status !== 'running'}
            className="glass-btn-outline border-white/10 text-slate-200 hover:bg-white/10"
            onOpenInTerminal={onOpenInTerminal}
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-white/5 px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">
        <span>
          {activeSessionId
            ? `${sessions.find((session) => session.id === activeSessionId)?.workingDir ?? ''}`
            : 'No interactive session selected'}
        </span>
        <span>{activeClientLabel}</span>
      </div>

      <div
        ref={containerRef}
        className="h-[520px] w-full bg-[#0f172a] px-2 py-2"
        onClick={() => terminalRef.current?.focus()}
      />
    </div>
  );
}
