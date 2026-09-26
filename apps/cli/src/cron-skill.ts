export const CCEM_CRON_SKILL_CONTENT = `# ccem-cron

Manage scheduled tasks for Claude Code/Codex through the structured \`ccem cron\` CLI. Do not edit \`~/.ccem/cron-tasks.json\` directly.

## Instructions

Determine the user's intent from their message:

- **List/view**: user says "list", "show", "view", "查看", "列出"
- **Delete/remove**: user says "delete", "remove", "删除", "移除"
- **Create**: default for anything else

## Creating A Task

If the request is specific enough, create the task directly. Ask a follow-up only when the schedule, action, or working directory is genuinely ambiguous.

- Task name: derive a short descriptive label.
- Prompt: derive a directly executable Claude/Codex instruction from the user's request.
- Schedule: derive a standard 5-field \`cronExpression\`.
- Working directory: default to the current directory via \`pwd\`.
- Timeout: default to 300 seconds unless the task clearly needs longer.
- Execution profile: use \`conservative\`, \`standard\`, or \`autonomous\` based on risk.

- Hermes result delivery: when the user asks to send results to a bot, run \`ccem cron notification-targets --json\`. Select the paired recipient matching the user's request; ask when multiple recipients match. Never invent chat IDs or silently fall back to another channel on lookup failure.
- Set \`hermesNotification: { routeId, generation }\` using that exact returned target. This grants only this task's completion notifications and does not require workspace access. Without an explicit notification request leave it null. Do not supply subscriptionId.

Common cron patterns:

\`\`\`text
Every minute:          * * * * *
Every 30 minutes:      */30 * * * *
Every hour:            0 * * * *
Every day at 9am:      0 9 * * *
Every day at midnight: 0 0 * * *
Weekdays at 9am:       0 9 * * 1-5
Every Monday 8am:      0 8 * * 1
Every 1st of month:    0 0 1 * *
\`\`\`

Create the task with the CLI and JSON input:

\`\`\`bash
ccem cron create --from-json - --json <<'JSON'
{
  "name": "TASK_NAME_HERE",
  "cronExpression": "CRON_EXPR_HERE",
  "prompt": "PROMPT_HERE",
  "workingDir": "ABSOLUTE_WORKING_DIR_HERE",
  "envName": null,
  "executionProfile": "conservative",
  "maxBudgetUsd": null,
  "allowedTools": [],
  "disallowedTools": [],
  "enabled": true,
  "timeoutSecs": 300,
  "templateId": null
}
JSON
\`\`\`

Replace the placeholder values with real values. The CLI owns validation, ID generation, defaults, and persistence.

Confirm creation by reading back the structured task list:

\`\`\`bash
ccem cron list --json
\`\`\`

## Listing Tasks

\`\`\`bash
ccem cron list
\`\`\`

Use \`ccem cron list --json\` when you need exact fields.

## Deleting A Task

1. List all tasks first so the user can identify which one to delete.
2. Ask the user to confirm by exact name or ID.
3. Delete through the CLI:

\`\`\`bash
ccem cron delete "TASK_ID_OR_EXACT_NAME"
\`\`\`

## Safety Rules

- Do not directly read, write, or hand-edit \`~/.ccem/cron-tasks.json\`.
- Use \`ccem cron create/list/delete\` as the stable contract.
- Never construct JSON by string concatenation; pass valid JSON to \`--from-json\`.
- After creating or deleting a task, read back with \`ccem cron list --json\` and report the actual stored task.
- Ask for confirmation first only when the request is ambiguous or destructive.
`;
