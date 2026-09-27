export const WORKSPACE_CRON_COMMAND = '/ccem-cron';

export interface WorkspaceCronAgentPrompt {
  prompt: string;
  displayPrompt: string;
}

export function isWorkspaceCronCommand(value: string): boolean {
  return /^\/ccem-cron(?:\s|$)/i.test(value.trimStart());
}

export function getWorkspaceCronRequest(value: string): string | null {
  const trimmed = value.trim();
  const commandPattern = new RegExp(`^${WORKSPACE_CRON_COMMAND}(?:\\s+([\\s\\S]+))?$`, 'i');
  const match = trimmed.match(commandPattern);
  const request = match?.[1]?.trim();
  return request || null;
}

export function buildWorkspaceCronAgentPrompt(
  value: string,
  workingDir?: string | null,
): WorkspaceCronAgentPrompt | null {
  const normalizedWorkingDir = workingDir?.trim();
  if (!normalizedWorkingDir) {
    return null;
  }

  const request = getWorkspaceCronRequest(value);
  if (!request) {
    return null;
  }

  return {
    displayPrompt: `${WORKSPACE_CRON_COMMAND} ${request}`,
    prompt: [
      `用户在 CCEM workspace 中输入了：${WORKSPACE_CRON_COMMAND} ${request}`,
      '',
      '请你作为当前 workspace 的 Claude Code/Codex agent 设置这个 CCEM 定时任务，而不是只给建议或计划。',
      '',
      '执行要求：',
      `- 任务工作目录固定使用：${normalizedWorkingDir}`,
      '- 理解用户的自然语言时间表达，生成标准 5 字段 cron 表达式：分 时 日 月 周。',
      '- 生成简短任务名和可直接执行的任务 prompt。',
      '- 使用 `ccem cron create --from-json - --json` 创建任务；不要直接读写或手工修改 `~/.ccem/cron-tasks.json`。',
      '- 传给 CLI 的 JSON 字段使用：name、cronExpression、prompt、workingDir、envName、executionProfile、maxBudgetUsd、allowedTools、disallowedTools、enabled、timeoutSecs、templateId、wecomNotification、hermesNotification。',
      '- 默认 enabled=true、timeoutSecs=300；executionProfile 根据任务风险选择 conservative、standard 或 autonomous。',
      '- 用户要求推送到机器人（Hermes、企微、飞书、Telegram、Discord、Slack 等）时，先运行 `ccem cron notification-targets --json` 获取当前已配对接收方；按用户指定名称/渠道匹配，存在多个候选时请用户选择，不猜测 chatId、routeId 或 generation。',
      '- 已确认的 Hermes 接收方使用 `hermesNotification: { routeId: 实际返回的routeId, generation: 实际返回的generation }`；这只订阅本任务结果，不要求绑定 workspace。没有推送要求时保持 null。不要编造 subscriptionId。',
      '- 只有用户明确选择旧企微连接时，才使用 `wecomNotification: { enabled: true, botId: null, peerId: null }` 表示配置的旧企微默认目标；明确给了 botId/peerId 时使用对应值。没有默认目标也没有明确目标时请用户确认，不猜测联系人或群。Hermes 查询失败不能自动改用旧目标。',
      '- 创建后使用 `ccem cron list --json` 重新读取验证新任务存在。',
      '- 最后向用户报告创建出的 name、cronExpression、workingDir 和 prompt。',
      '- 如果时间表达、权限、目录或现有任务冲突不确定，先请用户确认；不要强制覆盖任何现有任务。',
      '',
      '用户原始定时需求：',
      request,
    ].join('\n'),
  };
}
