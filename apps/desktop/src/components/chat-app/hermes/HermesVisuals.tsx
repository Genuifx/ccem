import { Check, Discord, MessageCircle, Slack, Telegram, Wechat } from '@/lib/lucide-react';
import { useLocale } from '@/locales';

export function HermesPlatformIcon({ platform, large = false }: { platform: string; large?: boolean }) {
  const Icon = { wecom: Wechat, telegram: Telegram, discord: Discord, slack: Slack }[platform] ?? MessageCircle;
  return <span className={`hermes-platform-icon${large ? ' hermes-platform-icon-large' : ''}`} data-platform-icon={platform} aria-hidden="true">
    {platform === 'feishu' ? <span className="hermes-feishu-mark">飞</span> : <Icon />}
  </span>;
}

export function HermesSteps({ current }: { current: 1 | 2 | 3 }) {
  const { t } = useLocale();
  return <ol className="hermes-steps" aria-label={t('hermes.connectionSteps')}>
    {['hermes.stepPlatform', 'hermes.stepConnect', 'hermes.stepAuthorize'].map((key, index) => <li key={key}
      data-step-state={index + 1 === current ? 'current' : index + 1 < current ? 'complete' : 'upcoming'}
      aria-current={index + 1 === current ? 'step' : undefined}>
      <span className="hermes-step-number" aria-hidden="true">{index + 1 < current ? <Check /> : index + 1}</span>
      <span>{t(key)}</span>
    </li>)}
  </ol>;
}

export function workspaceName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
