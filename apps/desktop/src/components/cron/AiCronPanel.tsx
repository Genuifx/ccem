import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/ui/EmptyState';
import { useTauriEvent } from '@/hooks/useTauriEvents';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { useAppStore } from '@/store';
import { emit } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { Sparkles, Loader2, Bot, Wrench, FolderOpen, FileText, Pencil, Check, X, AlertTriangle, Settings } from '@/lib/lucide-react';

interface StreamMessage {
  type: 'thinking' | 'tool' | 'result' | 'error';
  content: string;
}

interface GeneratedTask {
  name: string;
  cronExpression: string;
  prompt: string;
  workingDir: string;
}

interface AiCronPanelProps {
  open: boolean;
  onClose: () => void;
  onTaskCreated: () => void;
  onEdit: (task: GeneratedTask) => void;
}

export function AiCronPanel({ open, onClose, onTaskCreated, onEdit }: AiCronPanelProps) {
  const { t } = useLocale();
  const defaultWorkingDir = useAppStore((state) => state.defaultWorkingDir);
  const { addCronTask, generateCronTaskStream } = useTauriCommands();
  const [query, setQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const isGeneratingRef = useRef(false);
  const [streamMessages, setStreamMessages] = useState<StreamMessage[]>([]);
  const [generatedTask, setGeneratedTask] = useState<GeneratedTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const tryParseResult = useCallback((text: string) => {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.name && parsed.cronExpression && parsed.prompt) {
          setGeneratedTask(parsed);
        }
      } catch {
        // Not valid JSON yet
      }
    }
  }, []);

  useTauriEvent<string>('cron-ai-stream', (line) => {
    if (!isGeneratingRef.current) return;

    try {
      const data = JSON.parse(line);

      if (data.type === 'error') {
        setError(data.error || t('cron.aiError'));
        return;
      }

      if (data.type === 'assistant' && data.message?.content) {
        for (const block of data.message.content) {
          if (block.type === 'text' && block.text) {
            setStreamMessages(prev => [...prev, { type: 'thinking', content: block.text }]);
          } else if (block.type === 'tool_use') {
            setStreamMessages(prev => [...prev, { type: 'tool', content: t('skills.toolRunning') }]);
          }
        }
      } else if (data.type === 'content_block_delta' && data.delta?.text) {
        setStreamMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.type === 'thinking') {
            return [...prev.slice(0, -1), { ...last, content: last.content + data.delta.text }];
          }
          return [...prev, { type: 'thinking', content: data.delta.text }];
        });
      } else if (data.type === 'result') {
        const resultText = data.result || '';
        if (data.is_error) {
          setError(resultText);
        } else {
          tryParseResult(resultText);
        }
      }
    } catch {
      if (line.trim().startsWith('{')) {
        tryParseResult(line.trim());
      }
    }

    scrollToBottom();
  });

  useTauriEvent('cron-ai-done', () => {
    if (isGeneratingRef.current) {
      isGeneratingRef.current = false;
      setIsGenerating(false);
      setStreamMessages(prev => {
        if (prev.length > 0) {
          return [...prev, { type: 'result' as const, content: t('cron.aiComplete') }];
        }
        return prev;
      });
    }
  });

  const handleGenerate = async () => {
    if (!query.trim() || isGenerating) return;

    isGeneratingRef.current = true;
    setIsGenerating(true);
    setStreamMessages([]);
    setGeneratedTask(null);
    setError(null);

    try {
      await generateCronTaskStream(query.trim());
    } catch (err) {
      setError(String(err));
      isGeneratingRef.current = false;
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleConfirm = async () => {
    if (!generatedTask || isCreating) return;
    setIsCreating(true);
    try {
      await addCronTask({
        name: generatedTask.name,
        cronExpression: generatedTask.cronExpression,
        prompt: generatedTask.prompt,
        workingDir: generatedTask.workingDir,
      });
      toast.success(t('cron.aiCreated'));
      setGeneratedTask(null);
      setStreamMessages([]);
      setQuery('');
      onClose();
      onTaskCreated();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsCreating(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative rounded-2xl w-[calc(100%-1.5rem)] sm:w-[calc(100%-2rem)] md:w-[calc(100%-2.5rem)] lg:w-[calc(100%-3rem)] xl:w-[calc(100%-4rem)] 2xl:w-[calc(100%-5rem)] mx-auto max-w-md sm:max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl 2xl:max-w-4xl max-h-[min(90vh,900px)] overflow-hidden shadow-elevation-4 border border-[hsl(var(--glass-border-light)/0.25)]"
        style={{ background: 'hsl(var(--surface-overlay))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with gradient accent */}
        <div className="relative px-5 pt-5 pb-4">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-purple-500/5" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('cron.aiCreate')}</h2>
                <p className="text-2xs text-muted-foreground mt-0.5">{t('cron.aiPlaceholder')}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 pb-5 space-y-3 overflow-y-auto max-h-[calc(min(85vh,900px)-80px)]">
          {/* Working directory hint */}
          {!defaultWorkingDir && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="text-amber-700 dark:text-amber-400 flex-1 text-xs">{t('cron.needWorkingDir')}</span>
              <button
                onClick={() => { emit('navigate-to-settings'); onClose(); }}
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 hover:underline shrink-0"
              >
                <Settings className="w-3 h-3" />
                {t('cron.goToSettings')}
              </button>
            </div>
          )}

          {/* Input bar */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Bot className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary/60" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('cron.aiPlaceholder')}
                className="w-full h-10 pl-9 pr-4 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-foreground text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all"
                disabled={isGenerating}
              />
            </div>
            <Button
              onClick={handleGenerate}
              disabled={!query.trim() || isGenerating}
              className="h-10 px-4 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
            >
              {isGenerating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
            </Button>
          </div>

          {/* Error */}
          {error && (
            <ErrorBanner
              message={error}
              onRetry={() => { setError(null); handleGenerate(); }}
              retryLabel={t('common.retry')}
            />
          )}

          {/* Stream output */}
          {streamMessages.length > 0 && (
            <div className="rounded-xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06] p-3.5 max-h-44 overflow-y-auto">
              <div className="space-y-2 text-sm">
                {streamMessages.map((msg, i) => (
                  <div key={i} className="flex items-start gap-2">
                    {msg.type === 'thinking' && (
                      <>
                        <Bot className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                        <span className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{msg.content}</span>
                      </>
                    )}
                    {msg.type === 'tool' && (
                      <>
                        <Wrench className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
                        <span className="text-amber-600 dark:text-amber-500">{msg.content}</span>
                      </>
                    )}
                    {msg.type === 'result' && (
                      <>
                        <Sparkles className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                        <span className="text-emerald-600 dark:text-emerald-500 font-medium">{msg.content}</span>
                      </>
                    )}
                  </div>
                ))}
                <div ref={streamEndRef} />
              </div>
            </div>
          )}

          {/* Generated task preview */}
          {generatedTask && (
            <div className="rounded-xl border border-primary/20 bg-primary/[0.03] dark:bg-primary/[0.06] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">{generatedTask.name}</h4>
                <code className="text-2xs px-2 py-0.5 rounded-md bg-primary/10 text-primary font-mono">{generatedTask.cronExpression}</code>
              </div>
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <FileText className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary/50" />
                <p className="line-clamp-2 leading-relaxed">{generatedTask.prompt}</p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-primary/50" />
                <span className="truncate font-mono">{generatedTask.workingDir}</span>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-primary/10">
                <Button variant="outline" size="sm" className="rounded-lg" onClick={() => { onEdit(generatedTask); onClose(); }}>
                  <Pencil className="w-3.5 h-3.5 mr-1.5" />
                  {t('cron.aiEdit')}
                </Button>
                <Button size="sm" className="rounded-lg shadow-sm" onClick={handleConfirm} disabled={isCreating}>
                  {isCreating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                  {t('cron.aiConfirm')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
