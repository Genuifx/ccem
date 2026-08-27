import process from 'node:process';

const SHADOWED_CAN_USE_TOOL_WARNING_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const BYPASS_PERMISSIONS_WARNING_MESSAGE = "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.";

function isBypassPermissionsShadowWarning(args: unknown[]) {
  const [warning, typeOrOptions, positionalCode] = args;
  const message = typeof warning === 'string'
    ? warning
    : warning instanceof Error
      ? warning.message
      : '';
  const warningCode = typeOrOptions && typeof typeOrOptions === 'object'
    && 'code' in typeOrOptions
    && typeof typeOrOptions.code === 'string'
    ? typeOrOptions.code
    : typeof positionalCode === 'string'
      ? positionalCode
      : warning instanceof Error
        && 'code' in warning
        && typeof warning.code === 'string'
        ? warning.code
        : undefined;

  return warningCode === SHADOWED_CAN_USE_TOOL_WARNING_CODE
    && message === BYPASS_PERMISSIONS_WARNING_MESSAGE;
}

type ClaudePermissionOptions = {
  permissionMode?: unknown;
  canUseTool?: unknown;
};

export function withSuppressedClaudeBypassShadowWarning<T>(
  options: ClaudePermissionOptions,
  createQuery: () => T,
): T {
  if (options.permissionMode !== 'bypassPermissions' || typeof options.canUseTool !== 'function') {
    return createQuery();
  }

  const originalEmitWarning = process.emitWarning;
  const filteredEmitWarning = ((...args: unknown[]) => {
    if (isBypassPermissionsShadowWarning(args)) {
      return;
    }
    Reflect.apply(originalEmitWarning, process, args);
  }) as typeof process.emitWarning;

  // The SDK performs this options-shape check synchronously while query() is
  // created. Keep canUseTool for interactive tools and runtime mode changes;
  // only hide the known false-positive diagnostic during that narrow window.
  process.emitWarning = filteredEmitWarning;
  try {
    return createQuery();
  } finally {
    if (process.emitWarning === filteredEmitWarning) {
      process.emitWarning = originalEmitWarning;
    }
  }
}
