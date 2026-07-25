import { memo } from 'react';
import { Bot } from '@/lib/lucide-react';
import { Claude, Codex, OpenAI, DeepSeek, Grok, Minimax, Moonshot, Zhipu, Gemini, Ollama, OpenRouter as OpenRouterIcon, Qwen, XiaomiMiMo } from '@lobehub/icons';

interface ModelIconProps {
  model?: string;
  size?: number;
  className?: string;
  /**
   * 为浅色图标添加背景衬托，确保在亮色模式下可见
   */
  withBg?: boolean;
  disableContrastBg?: boolean;
}

export type IconEntry = {
  icon: any;
  color?: string;
  variant?: 'color' | 'avatar';
  /** 图标是否需要深色背景衬托（用于白色/浅色图标） */
  needsContrastBg?: boolean;
};

/** Map a model ID string to the corresponding lobe-icons component + brand color */
export function resolveIcon(model: string | undefined): IconEntry | null {
  if (!model) return null;
  const m = model.toLowerCase();

  if (m.includes('codex')) return { icon: Codex, variant: 'color' };
  if (m.includes('grok') || m.includes('xai')) return { icon: Grok, color: '#000', needsContrastBg: true };
  if (m.includes('claude') || m.includes('anthropic') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return { icon: Claude, color: '#D97757' };
  if (m.includes('gpt') || m.includes('openai') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return { icon: OpenAI, color: '#10A37F' };
  if (m.includes('openrouter')) return { icon: OpenRouterIcon, color: '#6467F2' };
  if (m.includes('deepseek')) return { icon: DeepSeek, color: '#4D6BFE' };
  if (m.includes('minimax') || m.includes('abab')) return { icon: Minimax, color: '#F23F5D' };
  if (m.includes('moonshot') || m.includes('kimi') || m.includes('k3')) return { icon: Moonshot, color: '#16191E', needsContrastBg: true };
  if (m.includes('mimo') || m.includes('xiaomimimo')) return { icon: XiaomiMiMo, variant: 'avatar' };
  if (m.includes('qwen') || m.includes('qwq') || m.includes('dashscope') || m.includes('tongyi')) return { icon: Qwen, color: '#615CED' };
  if (m.includes('glm') || m.includes('zhipu') || m.includes('chatglm')) return { icon: Zhipu, color: '#3859FF' };
  if (m.includes('gemini') || m.includes('google')) return { icon: Gemini, color: '#4285F4' };
  if (m.includes('ollama')) return { icon: Ollama, color: '#fff', needsContrastBg: true };

  return null;
}

export const ModelIcon = memo(function ModelIcon({
  model,
  size = 14,
  className,
  withBg,
  disableContrastBg,
}: ModelIconProps) {
  const entry = resolveIcon(model);

  if (!entry) {
    return <Bot className={className} style={{ width: size, height: size }} />;
  }

  if (entry.variant === 'color') {
    return <entry.icon.Color className={className} size={size} />;
  }

  if (entry.variant === 'avatar') {
    const AvatarIcon = entry.icon.Avatar;
    return <AvatarIcon className={className} size={size} shape="square" />;
  }

  const style = entry.color ? { color: entry.color } : undefined;
  const IconComponent = entry.icon;

  // 为需要对比背景的图标添加自适应背景容器
  // 亮色模式：白色背景 + 黑色图标；暗色模式：透明背景 + 白色图标
  if (!disableContrastBg && (entry.needsContrastBg || withBg)) {
    const padding = Math.max(2, Math.floor(size * 0.15));
    const borderRadius = Math.max(4, Math.floor(size * 0.25));
    return (
      <span
        className="inline-flex items-center justify-center bg-white dark:bg-transparent"
        style={{ padding, borderRadius }}
      >
        <IconComponent
          className={entry.needsContrastBg ? 'text-black dark:text-white' : className}
          size={size}
          style={entry.needsContrastBg ? undefined : style}
        />
      </span>
    );
  }

  return <IconComponent className={className} size={size} style={style} />;
});
