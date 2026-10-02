import chalk from 'chalk';
import Table from 'cli-table3';
import type { Command } from 'commander';
import {
  createCronTaskWithNotifications,
  getCronNotificationTargets,
  deleteCronTask,
  formatCronTaskTableRows,
  listCronTasksViaDesktop,
  parseCronCreateJson,
  parseStringList,
  triggerCronTask,
} from './cron.js';

export function registerCronCommands(program: Command): void {
  // cron 命令组（结构化管理 CCEM 定时任务）
  const cronCmd = program
    .command('cron')
    .description('Manage CCEM cron tasks');

  cronCmd
    .command('list')
    .description('List CCEM cron tasks')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const tasks = await listCronTasksViaDesktop();
        if (options.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }

        if (tasks.length === 0) {
          console.log(chalk.yellow('No cron tasks found.'));
          return;
        }

        const table = new Table({
          head: ['Name', 'Schedule', 'Enabled', 'Working Dir', 'Env', 'Timeout'],
        });
        table.push(...formatCronTaskTableRows(tasks));
        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  cronCmd
    .command('notification-targets')
    .description('List paired Hermes recipients for task result notifications (Desktop must be running)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const targets = await getCronNotificationTargets();
        if (options.json) { console.log(JSON.stringify(targets, null, 2)); return; }
        const table = new Table({ head: ['Bot', 'Platform', 'Chat', 'Route ID', 'Generation'] });
        table.push(...targets.map((target) => [target.label, target.platform, target.chatId, target.routeId, String(target.generation)]));
        console.log(targets.length ? table.toString() : 'No paired Hermes notification targets. Pair a bot in CCEM Remote Control first.');
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  cronCmd
    .command('create')
    .description('Create a CCEM cron task')
    .option('--from-json <json>', 'Read task input from inline JSON, @file, or - for stdin')
    .option('--name <name>', 'Task name')
    .option('--cron-expression <expr>', '5-field cron expression')
    .option('--schedule <expr>', 'Alias for --cron-expression')
    .option('--prompt <prompt>', 'Prompt to run when the task fires')
    .option('--working-dir <dir>', 'Task working directory')
    .option('--env-name <name>', 'CCEM environment name')
    .option('--execution-profile <profile>', 'conservative, standard, or autonomous')
    .option('--max-budget-usd <amount>', 'Optional max budget in USD')
    .option('--allowed-tools <items>', 'Comma-separated or JSON array of allowed tools')
    .option('--disallowed-tools <items>', 'Comma-separated or JSON array of disallowed tools')
    .option('--timeout-secs <seconds>', 'Task timeout in seconds')
    .option('--template-id <id>', 'Optional template id')
    .option('--wecom-result', 'Send cron result summary to the configured WeCom default target')
    .option('--wecom-bot-id <id>', 'WeCom bot id for cron result notifications')
    .option('--wecom-peer-id <id>', 'WeCom peer id for cron result notifications')
    .option('--disabled', 'Create task disabled')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const input = options.fromJson
          ? parseCronCreateJson(options.fromJson)
          : {
              name: options.name,
              cronExpression: options.cronExpression ?? options.schedule,
              prompt: options.prompt,
              workingDir: options.workingDir,
              envName: options.envName,
              executionProfile: options.executionProfile,
              maxBudgetUsd: options.maxBudgetUsd === undefined ? null : Number(options.maxBudgetUsd),
              allowedTools: parseStringList(options.allowedTools),
              disallowedTools: parseStringList(options.disallowedTools),
              enabled: options.disabled ? false : true,
              timeoutSecs: options.timeoutSecs === undefined ? null : Number(options.timeoutSecs),
              templateId: options.templateId,
              wecomNotification:
                options.wecomResult || options.wecomBotId || options.wecomPeerId
                  ? {
                      botId: options.wecomBotId ?? null,
                      peerId: options.wecomPeerId ?? null,
                      enabled: true,
                    }
                  : null,
            };

        const task = await createCronTaskWithNotifications(input);
        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }

        console.log(chalk.green('✓ Cron task created'));
        console.log(chalk.gray(`  id: ${task.id}`));
        console.log(chalk.gray(`  name: ${task.name}`));
        console.log(chalk.gray(`  cronExpression: ${task.cronExpression}`));
        console.log(chalk.gray(`  workingDir: ${task.workingDir}`));
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  cronCmd
    .command('delete <selector>')
    .description('Delete a cron task by exact id or exact name')
    .option('--json', 'Output deleted task as JSON')
    .action((selector, options) => {
      try {
        const task = deleteCronTask(selector);
        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        console.log(chalk.green(`✓ Deleted cron task: ${task.name}`));
        console.log(chalk.gray(`  id: ${task.id}`));
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  cronCmd
    .command('trigger <selector>')
    .description('Trigger a cron task to run immediately in CCEM Desktop (exact id or exact name; Desktop must be running)')
    .option('--json', 'Output triggered task as JSON')
    .action(async (selector, options) => {
      try {
        const task = await triggerCronTask(selector);
        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        console.log(chalk.green(`✓ Triggered cron task: ${task.name}`));
        console.log(chalk.gray(`  id: ${task.id}`));
        console.log(chalk.gray('  Runs in the background; run history is in CCEM Desktop → Cron.'));
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
