import { memo } from 'react';
import { BadgeAlert, LoaderCircle } from '@/lib/lucide-react';
import { Claude, Codex, DeepSeek, Gemini, Grok, Minimax, Moonshot, Ollama, OpenAI, OpenCode, OpenRouter, Qwen, XiaomiMiMo, Zhipu } from '@lobehub/icons';
import { cn } from '@/lib/utils';
import type { HistorySessionItem } from '@/features/conversations/types';
import type { Environment, LaunchClient } from '@/store';
import type { WorkspaceSessionDecoration } from './useWorkspaceSessionDecorations';

interface SessionTreeItemIconProps {
  session: HistorySessionItem;
  environment?: Environment;
  decoration?: WorkspaceSessionDecoration;
  isSelected?: boolean;
  className?: string;
}

const TIER_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

function normalizeClient(value: string | undefined): LaunchClient {
  if (value === 'codex') {
    return 'codex';
  }
  if (value === 'opencode') {
    return 'opencode';
  }
  return 'claude';
}

function isTierModelAlias(model?: string): boolean {
  if (!model) {
    return true;
  }
  return TIER_MODEL_ALIASES.has(model.trim().toLowerCase());
}

function hintFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.toLowerCase();
  if (normalized.includes('openrouter.ai')) return 'openrouter';
  if (normalized.includes('openai.com')) return 'gpt';
  if (normalized.includes('bigmodel.cn')) return 'glm';
  if (normalized.includes('moonshot.cn') || normalized.includes('kimi.com')) return 'kimi';
  if (normalized.includes('minimax')) return 'minimax';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('dashscope') || normalized.includes('aliyuncs.com')) return 'qwen';
  if (normalized.includes('11434') || normalized.includes('ollama')) return 'ollama';
  if (normalized.includes('googleapis.com') || normalized.includes('generativelanguage')) return 'gemini';
  if (normalized.includes('xiaomimimo.com')) return 'mimo';
  if (
    normalized.includes('x.ai')
    || normalized.includes('xai.com')
    || normalized.includes('api.x.ai')
  ) {
    return 'grok';
  }
  if (normalized.includes('anthropic.com')) return 'claude';
  return undefined;
}

export function resolveEnvironmentIconHint(environment?: Environment): string | undefined {
  if (!environment) {
    return undefined;
  }

  const modelCandidates = [
    environment.defaultOpusModel,
    environment.runtimeModel,
    environment.defaultSonnetModel,
    environment.defaultHaikuModel,
  ];
  // Tier aliases like "opus" always look like Claude, so prefer concrete model IDs,
  // provider base URL, and env name before falling back to those aliases.
  const concreteModel = modelCandidates.find((model) => model && !isTierModelAlias(model));

  return (
    concreteModel
    || hintFromBaseUrl(environment.baseUrl)
    || environment.name
    || modelCandidates.find(Boolean)
  );
}

export function resolveSessionClient(
  session: Pick<HistorySessionItem, 'source'>,
  decoration?: Pick<WorkspaceSessionDecoration, 'client'>
): LaunchClient {
  return normalizeClient(decoration?.client ?? session.source);
}

const SourceIdentityIcon = memo(function SourceIdentityIcon({
  client,
  className,
}: {
  client: LaunchClient;
  className?: string;
}) {
  if (client === 'codex') {
    return <Codex.Color size={16} className={className} />;
  }
  if (client === 'opencode') {
    return <OpenCode size={16} className={className} />;
  }
  return <Claude.Color size={16} className={className} />;
});

const TREE_ICON_FRAME_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md';
const TREE_ICON_GLYPH_CLASS = 'h-4 w-4 shrink-0';

const ProviderIdentityIcon = memo(function ProviderIdentityIcon({
  hint,
}: {
  hint?: string;
}) {
  const normalized = hint?.toLowerCase() ?? '';

  if (normalized.includes('openrouter')) return <OpenRouter className={TREE_ICON_GLYPH_CLASS} color="#6467F2" />;
  if (normalized.includes('gpt') || normalized.includes('openai')) return <OpenAI className={TREE_ICON_GLYPH_CLASS} color="#10A37F" />;
  if (normalized.includes('grok') || normalized.includes('xai')) {
    return <Grok className={cn(TREE_ICON_GLYPH_CLASS, 'text-black dark:text-white')} />;
  }
  if (normalized.includes('deepseek')) return <DeepSeek className={TREE_ICON_GLYPH_CLASS} color="#4D6BFE" />;
  if (normalized.includes('minimax') || normalized.includes('abab')) return <Minimax className={TREE_ICON_GLYPH_CLASS} color="#F23F5D" />;
  if (normalized.includes('moonshot') || normalized.includes('kimi')) return <Moonshot className={TREE_ICON_GLYPH_CLASS} color="#16191E" />;
  if (normalized.includes('mimo') || normalized.includes('xiaomimimo')) return <XiaomiMiMo.Avatar className={TREE_ICON_GLYPH_CLASS} size={16} shape="square" />;
  if (normalized.includes('qwen') || normalized.includes('qwq') || normalized.includes('dashscope') || normalized.includes('tongyi')) return <Qwen className={TREE_ICON_GLYPH_CLASS} color="#615CED" />;
  if (normalized.includes('glm') || normalized.includes('zhipu') || normalized.includes('chatglm')) return <Zhipu className={TREE_ICON_GLYPH_CLASS} color="#3859FF" />;
  if (normalized.includes('gemini') || normalized.includes('google')) return <Gemini className={TREE_ICON_GLYPH_CLASS} color="#4285F4" />;
  if (normalized.includes('ollama')) return <Ollama className={cn(TREE_ICON_GLYPH_CLASS, 'text-black dark:text-white')} />;
  return <Claude className={TREE_ICON_GLYPH_CLASS} color="#D97757" />;
});

export const SessionTreeItemIcon = memo(function SessionTreeItemIcon({
  session,
  environment,
  decoration,
  isSelected = false,
  className,
}: SessionTreeItemIconProps) {
  if (decoration?.visualState === 'attention') {
    return (
      <span className={cn(TREE_ICON_FRAME_CLASS, 'relative', className)}>
        <span className="absolute inline-flex h-4 w-4 animate-ping rounded-full bg-warning/45 opacity-75" />
        <BadgeAlert className={cn(TREE_ICON_GLYPH_CLASS, 'relative text-warning status-glow-warning')} />
      </span>
    );
  }

  if (decoration?.visualState === 'processing') {
    return (
      <span className={cn(TREE_ICON_FRAME_CLASS, className)}>
        <LoaderCircle
          className={cn(
            TREE_ICON_GLYPH_CLASS,
            'animate-spin',
            isSelected ? 'text-primary' : 'text-muted-foreground'
          )}
        />
      </span>
    );
  }

  const client = resolveSessionClient(session, decoration);
  const providerHint = resolveEnvironmentIconHint(environment);
  if (client !== 'codex' && providerHint) {
    return (
      <span className={cn(TREE_ICON_FRAME_CLASS, className)}>
        <ProviderIdentityIcon hint={providerHint} />
      </span>
    );
  }

  return (
    <span className={cn(TREE_ICON_FRAME_CLASS, className)}>
      <SourceIdentityIcon client={client} className={TREE_ICON_GLYPH_CLASS} />
    </span>
  );
});
