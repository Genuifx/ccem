export type ClaudeToolPermissionOptions = {
  toolUseID: string;
  requestId?: string;
  agentID?: string;
};

export function resolveClaudePermissionRequestId(
  options: ClaudeToolPermissionOptions,
  now: () => number = Date.now,
) {
  return typeof options.requestId === 'string' && options.requestId.length > 0
    ? options.requestId
    : `${options.toolUseID}:${now()}`;
}
