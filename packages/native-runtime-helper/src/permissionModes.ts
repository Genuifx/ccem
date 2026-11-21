export type ClaudePermissionMode =
  | 'default'
  | 'manual'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export type ClaudePermissionSettings = {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions: boolean;
};

type ClaudePermissionModeOptions = {
  allowDangerouslySkipPermissions?: boolean;
};

function withClaudePermissionOptions(
  settings: ClaudePermissionSettings,
  options?: ClaudePermissionModeOptions,
): ClaudePermissionSettings {
  return {
    ...settings,
    allowDangerouslySkipPermissions:
      settings.allowDangerouslySkipPermissions || options?.allowDangerouslySkipPermissions === true,
  };
}

export function normalizeClaudePermissionMode(
  permMode: string,
  options?: ClaudePermissionModeOptions,
): ClaudePermissionSettings {
  let settings: ClaudePermissionSettings;
  switch (permMode) {
    case 'yolo':
    case 'bypassPermissions':
      settings = {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      };
      break;
    case 'dev':
    case 'acceptEdits':
      settings = {
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      };
      break;
    case 'readonly':
    case 'audit':
    case 'plan':
      settings = {
        permissionMode: 'plan',
        allowDangerouslySkipPermissions: false,
      };
      break;
    case 'safe':
    case 'ci':
    case 'default':
    case 'manual':
      settings = {
        permissionMode: permMode === 'manual' ? 'manual' : 'default',
        allowDangerouslySkipPermissions: false,
      };
      break;
    case 'dontAsk':
      settings = {
        permissionMode: 'dontAsk',
        allowDangerouslySkipPermissions: false,
      };
      break;
    case 'auto':
      settings = {
        permissionMode: 'auto',
        allowDangerouslySkipPermissions: false,
      };
      break;
    default:
      settings = {
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      };
      break;
  }

  return withClaudePermissionOptions(settings, options);
}

export function normalizeCodexSandboxMode(permMode: string) {
  if (permMode === 'yolo' || permMode === 'danger-full-access') {
    return {
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: true,
    };
  }

  if (
    permMode === 'readonly'
    || permMode === 'audit'
    || permMode === 'plan'
    || permMode === 'read-only'
  ) {
    return {
      sandboxMode: 'read-only' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: false,
    };
  }

  // safe, ci, dev, default, and unknown modes
  // safe/ci: conservative — limit network to prevent untrusted fetches
  if (permMode === 'safe' || permMode === 'ci') {
    return {
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'on-request' as const,
      networkAccessEnabled: false,
    };
  }

  // dev, default, and unknown modes — allow network for development workflow
  return {
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    networkAccessEnabled: true,
  };
}

export type AgyAcpMode = 'default' | 'accept-edits' | 'plan' | 'auto';

export type AgyPermissionSettings = {
  acpMode: AgyAcpMode;
  dangerouslySkipPermissions: boolean;
};

export function normalizeAgyPermissionMode(permMode: string): AgyPermissionSettings {
  switch (permMode) {
    case 'yolo':
    case 'bypassPermissions':
    case 'danger-full-access':
      return {
        acpMode: 'auto',
        dangerouslySkipPermissions: true,
      };
    case 'plan':
    case 'readonly':
    case 'audit':
    case 'read-only':
      return {
        acpMode: 'plan',
        dangerouslySkipPermissions: false,
      };
    case 'dev':
    case 'acceptEdits':
    case 'accept-edits':
      return {
        acpMode: 'accept-edits',
        dangerouslySkipPermissions: false,
      };
    case 'auto':
      return {
        acpMode: 'auto',
        dangerouslySkipPermissions: false,
      };
    case 'safe':
    case 'ci':
    case 'default':
    case 'manual':
    default:
      return {
        acpMode: 'default',
        dangerouslySkipPermissions: false,
      };
  }
}
