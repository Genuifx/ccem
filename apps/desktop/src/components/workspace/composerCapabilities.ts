export type WorkspaceComposerProvider = 'claude' | 'codex';

export interface ComposerCommandDefinition {
  token: string;
  description?: string | null;
  source?: string;
  scope?: string;
  namespace?: string | null;
  path?: string;
  provider?: string;
}

export interface WorkspaceComposerCapabilities {
  provider: WorkspaceComposerProvider;
  label: string;
  planModeKind: 'session_permission' | 'command_prefix';
  planCommandPrefix?: string;
  commands: ComposerCommandDefinition[];
  supportsImages: boolean;
  /**
   * Whether this provider's requests can be split across environments by the
   * CCEM Router (per-provider capability, not a global Claude-only assumption;
   * only Claude's Anthropic-compatible protocol is wired today).
   */
  supportsEnvRouting: boolean;
}

const CCEM_COMMANDS: ComposerCommandDefinition[] = [
  { token: '/ccem-cron' },
];

const CLAUDE_COMMANDS: ComposerCommandDefinition[] = [
  ...CCEM_COMMANDS,
  { token: '/add-dir' },
  { token: '/agents' },
  { token: '/bug' },
  { token: '/clear' },
  { token: '/compact' },
  { token: '/config' },
  { token: '/cost' },
  { token: '/doctor' },
  { token: '/help' },
  { token: '/init' },
  { token: '/login' },
  { token: '/logout' },
  { token: '/memory' },
  { token: '/model' },
  { token: '/permissions' },
  { token: '/pr_comments' },
  { token: '/review' },
  { token: '/status' },
  { token: '/terminal-setup' },
  { token: '/vim' },
];

const CODEX_COMMANDS: ComposerCommandDefinition[] = [
  ...CCEM_COMMANDS,
  { token: '/approval-mode' },
  { token: '/browser' },
  { token: '/cache' },
  { token: '/cd' },
  { token: '/cost' },
  { token: '/diff' },
  { token: '/help' },
  { token: '/init' },
  { token: '/login' },
  { token: '/logout' },
  { token: '/mcp' },
  { token: '/memory' },
  { token: '/mentions' },
  { token: '/model' },
  { token: '/new' },
  { token: '/plan' },
  { token: '/provider' },
  { token: '/quit' },
  { token: '/review' },
  { token: '/status' },
  { token: '/terminal-setup' },
  { token: '/theme' },
  { token: '/tools' },
  { token: '/version' },
];

const CAPABILITIES: Record<WorkspaceComposerProvider, WorkspaceComposerCapabilities> = {
  claude: {
    provider: 'claude',
    label: 'Claude Code',
    planModeKind: 'session_permission',
    commands: CLAUDE_COMMANDS,
    supportsImages: true,
    supportsEnvRouting: true,
  },
  codex: {
    provider: 'codex',
    label: 'Codex',
    planModeKind: 'command_prefix',
    planCommandPrefix: '/plan',
    commands: CODEX_COMMANDS,
    supportsImages: true,
    supportsEnvRouting: false,
  },
};

export function getComposerCapabilities(provider: WorkspaceComposerProvider): WorkspaceComposerCapabilities {
  return CAPABILITIES[provider];
}
