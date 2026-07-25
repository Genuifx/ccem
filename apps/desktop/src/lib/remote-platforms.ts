import { Building2, MessageCircle, Send, type LucideIcon } from '@/lib/lucide-react';
import type { ChannelKind, ManagedSessionSource } from '@/lib/tauri-ipc';

export type RemotePlatformId = 'telegram' | 'weixin' | 'wecom';

interface RemotePlatformMeta {
  id: RemotePlatformId;
  displayName: string;
  labelKey: string;
  sourceLabelKey: string;
  channelLabelKey: string;
  icon: LucideIcon;
}

const REMOTE_PLATFORM_META: Record<RemotePlatformId, RemotePlatformMeta> = {
  telegram: {
    id: 'telegram',
    displayName: 'Telegram',
    labelKey: 'chatApp.telegram',
    sourceLabelKey: 'sessions.source_telegram',
    channelLabelKey: 'sessions.channel_telegram',
    icon: Send,
  },
  weixin: {
    id: 'weixin',
    displayName: 'Weixin',
    labelKey: 'chatApp.weixin',
    sourceLabelKey: 'sessions.source_weixin',
    channelLabelKey: 'sessions.channel_weixin',
    icon: MessageCircle,
  },
  wecom: {
    id: 'wecom',
    displayName: 'WeCom',
    labelKey: 'chatApp.wecom',
    sourceLabelKey: 'sessions.source_wecom',
    channelLabelKey: 'sessions.channel_wecom',
    icon: Building2,
  },
};

export const REMOTE_PLATFORM_ORDER: RemotePlatformId[] = ['telegram', 'weixin', 'wecom'];

export function getRemotePlatformMeta(platform: RemotePlatformId): RemotePlatformMeta {
  return REMOTE_PLATFORM_META[platform];
}

export function getRemotePlatformFromSource(source: ManagedSessionSource): RemotePlatformId | null {
  switch (source.type) {
    case 'telegram':
      return 'telegram';
    case 'weixin':
      return 'weixin';
    case 'wecom':
      return 'wecom';
    default:
      return null;
  }
}

export function getRemotePlatformFromChannel(kind: ChannelKind | string): RemotePlatformId | null {
  const rawKind = typeof kind === 'string' ? kind : kind.kind;
  switch (rawKind) {
    case 'telegram':
      return 'telegram';
    case 'weixin':
      return 'weixin';
    case 'wecom':
      return 'wecom';
    case 'bot_binding':
      return typeof kind !== 'string' && kind.kind === 'bot_binding' ? kind.platform : null;
    default:
      return null;
  }
}

export function formatRemoteSourceHint(source: ManagedSessionSource): string | null {
  switch (source.type) {
    case 'telegram':
      return `${source.chat_id}/${source.thread_id}`;
    case 'weixin':
      return source.peer_id;
    case 'wecom':
      return `${source.bot_id}/${source.peer_id}`;
    default:
      return null;
  }
}
