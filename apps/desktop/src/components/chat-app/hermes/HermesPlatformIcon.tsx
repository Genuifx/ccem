import { Hash, Mail, MessageCircle } from '@/lib/lucide-react';
import a2a from '@/assets/hermes-platforms/a2a.svg';
import buzz from '@/assets/hermes-platforms/buzz.svg';
import dingtalk from '@/assets/hermes-platforms/dingtalk.svg';
import discord from '@/assets/hermes-platforms/discord.svg';
import feishu from '@/assets/hermes-platforms/feishu.svg';
import googleChat from '@/assets/hermes-platforms/googlechat.svg';
import homeAssistant from '@/assets/hermes-platforms/homeassistant.svg';
import line from '@/assets/hermes-platforms/line.svg';
import matrix from '@/assets/hermes-platforms/matrix.svg';
import mattermost from '@/assets/hermes-platforms/mattermost.svg';
import teams from '@/assets/hermes-platforms/microsoft-teams.svg';
import ntfy from '@/assets/hermes-platforms/ntfy.svg';
import photon from '@/assets/hermes-platforms/photon.png';
import raft from '@/assets/hermes-platforms/raft.svg';
import simplex from '@/assets/hermes-platforms/simplex.svg';
import slack from '@/assets/hermes-platforms/slack.svg';
import telegram from '@/assets/hermes-platforms/telegram.svg';
import twilio from '@/assets/hermes-platforms/twilio.svg';
import wecom from '@/assets/hermes-platforms/wecom.svg';
import whatsapp from '@/assets/hermes-platforms/whatsapp.svg';

// Only these local assets are bundled. Sources and licenses live beside them.
// Channel availability continues to come from Hermes, independently of branding.
const brands: Record<string, { src: string; adaptive?: boolean }> = {
  a2a: { src: a2a },
  buzz: { src: buzz, adaptive: true },
  dingtalk: { src: dingtalk },
  discord: { src: discord },
  feishu: { src: feishu },
  google_chat: { src: googleChat },
  homeassistant: { src: homeAssistant },
  line: { src: line },
  matrix: { src: matrix, adaptive: true },
  mattermost: { src: mattermost },
  ntfy: { src: ntfy },
  photon: { src: photon },
  raft: { src: raft, adaptive: true },
  simplex: { src: simplex, adaptive: true },
  slack: { src: slack },
  sms: { src: twilio },
  teams: { src: teams },
  telegram: { src: telegram },
  wecom: { src: wecom },
  wecom_callback: { src: wecom },
  whatsapp: { src: whatsapp },
};

export function HermesPlatformIcon({ platform, large = false }: { platform: string; large?: boolean }) {
  const brand = Object.prototype.hasOwnProperty.call(brands, platform) ? brands[platform] : undefined;
  const Icon = platform === 'email' ? Mail : platform === 'irc' ? Hash : MessageCircle;
  return <span className={`hermes-platform-icon${large ? ' hermes-platform-icon-large' : ''}`}
    data-platform-icon={platform} aria-hidden="true">
    {brand
      ? <img src={brand.src} alt="" draggable={false}
          className={brand.adaptive ? 'hermes-platform-mark hermes-platform-mark-adaptive' : 'hermes-platform-mark'} />
      : <Icon />}
  </span>;
}
