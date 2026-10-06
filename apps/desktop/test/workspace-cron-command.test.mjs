import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const appPath = path.join(desktopDir, 'src', 'App.tsx');
const cronPagePath = path.join(desktopDir, 'src', 'pages', 'CronTasks.tsx');
const workspacePagePath = path.join(desktopDir, 'src', 'pages', 'Workspace.tsx');
const workspaceNativeViewPath = path.join(
  desktopDir,
  'src',
  'components',
  'workspace',
  'WorkspaceNativeSessionView.tsx',
);

async function importWorkspaceCronCommand() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-cron-command-test-'));
  const outfile = path.join(tempDir, 'workspaceCronCommand.mjs');

  await build({
    entryPoints: [path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceCronCommand.ts')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function importComposerCapabilities() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-capabilities-test-'));
  const outfile = path.join(tempDir, 'composerCapabilities.mjs');

  await build({
    entryPoints: [path.join(desktopDir, 'src', 'components', 'workspace', 'composerCapabilities.ts')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('builds /ccem-cron into an agent prompt instead of a local scheduled task draft', async () => {
  const { buildWorkspaceCronAgentPrompt } = await importWorkspaceCronCommand();

  const request = buildWorkspaceCronAgentPrompt(
    '/ccem-cron 每天早中晚都主动拉取一下最新的github代码',
    '/Users/wzt/G/Github/claude-code-env-manager',
  );

  assert.equal(
    request?.displayPrompt,
    '/ccem-cron 每天早中晚都主动拉取一下最新的github代码',
  );
  assert.match(request?.prompt ?? '', /Claude Code\/Codex agent 设置这个 CCEM 定时任务/);
  assert.match(request?.prompt ?? '', /任务工作目录固定使用：\/Users\/wzt\/G\/Github\/claude-code-env-manager/);
  assert.match(request?.prompt ?? '', /理解用户的自然语言时间表达/);
  assert.match(request?.prompt ?? '', /ccem cron create --from-json - --json/);
  assert.match(request?.prompt ?? '', /不要直接读写或手工修改 `~\/.ccem\/cron-tasks.json`/);
  assert.match(request?.prompt ?? '', /ccem cron list --json/);
  assert.doesNotMatch(request?.prompt ?? '', /创建前读取现有 `~\/.ccem\/cron-tasks.json`/);
  assert.doesNotMatch(request?.prompt ?? '', /\{ "tasks": \[\] \}/);
});

test('preserves the full user cron request for the launched agent', async () => {
  const { buildWorkspaceCronAgentPrompt } = await importWorkspaceCronCommand();
  const request = '每天早中晚都主动拉取一下github的分支代码，有新的变更就生成一个变更报告，并主动review代码';

  const agentPrompt = buildWorkspaceCronAgentPrompt(`/ccem-cron ${request}`, '/tmp/project');

  assert.match(agentPrompt?.prompt ?? '', /生成一个变更报告/);
  assert.match(agentPrompt?.prompt ?? '', /主动review代码/);
  assert.match(agentPrompt?.prompt ?? '', /不要强制覆盖任何现有任务/);
});

test('instructs the agent to resolve a paired recipient before creating a notified task', async () => {
  const { buildWorkspaceCronAgentPrompt } = await importWorkspaceCronCommand();
  const agentPrompt = buildWorkspaceCronAgentPrompt(
    '/ccem-cron 每天下午 6 点总结今天的 git 变更并把结果推送到企微',
    '/tmp/project',
  );

  assert.match(agentPrompt?.prompt ?? '', /wecomNotification/);
  assert.match(agentPrompt?.prompt ?? '', /ccem cron notification-targets --json/);
  assert.match(agentPrompt?.prompt ?? '', /hermesNotification/);
  assert.match(agentPrompt?.prompt ?? '', /存在多个候选时请用户选择/);
  assert.match(agentPrompt?.prompt ?? '', /只有用户明确选择旧企微连接/);
  assert.match(agentPrompt?.prompt ?? '', /Hermes 查询失败不能自动改用旧目标/);
  assert.match(agentPrompt?.prompt ?? '', /\{ enabled: true, botId: null, peerId: null \}/);
  assert.match(agentPrompt?.prompt ?? '', /不猜测联系人或群/);
});

test('workspace cron submit launches a native agent session instead of creating a task directly', async () => {
  const source = await fs.readFile(workspacePagePath, 'utf8');
  const liveSource = await fs.readFile(workspaceNativeViewPath, 'utf8');

  assert.doesNotMatch(source, /addCronTask/);
  assert.doesNotMatch(source, /parseWorkspaceCronCommand/);
  assert.doesNotMatch(liveSource, /addCronTask/);
  assert.doesNotMatch(liveSource, /parseWorkspaceCronCommand/);
  assert.match(source, /buildWorkspaceCronAgentPrompt\(rawPrompt, workingDir\)/);
  assert.match(source, /buildWorkspaceCronAgentPrompt\(rawPrompt, selectedSession\.project\)/);
  assert.match(source, /initialPrompt: dispatch\.prompt/);
  assert.match(source, /planModeEnabled: isCronCommand \? false : composePlanModeEnabled/);
  assert.match(source, /planModeEnabled: isCronCommand \? false : historyPlanModeEnabled/);
  assert.match(liveSource, /buildWorkspaceCronAgentPrompt\(text, session\.project_dir\)/);
  assert.match(liveSource, /planMode: isCronCommand \? false : composerPlanModeEnabled/);
});

test('cron AI Create opens workspace composer seeded with /ccem-cron', async () => {
  const appSource = await fs.readFile(appPath, 'utf8');
  const cronSource = await fs.readFile(cronPagePath, 'utf8');
  const workspaceSource = await fs.readFile(workspacePagePath, 'utf8');

  assert.match(appSource, /workspaceComposeSeed/);
  assert.match(appSource, /value: '\/ccem-cron '/);
  assert.match(appSource, /<CronTasksPage onAiCreate=\{openWorkspaceCronCreate\}/);
  assert.match(appSource, /composeSeed=\{workspaceComposeSeed\}/);
  assert.match(workspaceSource, /composeSeed/);
  assert.match(workspaceSource, /setWorkspaceMode\('compose'\)/);
  assert.match(workspaceSource, /setComposePrompt\(composeSeed\.value\)/);
  assert.doesNotMatch(cronSource, /AiCronPanel/);
});

test('cron Add Task form retains the legacy WeCom result notification fields', async () => {
  const cronSource = await fs.readFile(cronPagePath, 'utf8');

  assert.match(cronSource, /getWecomTaskBindingOptions/);
  assert.match(cronSource, /legacyNotification/);
  assert.match(cronSource, /wecomNotification: notifyWecom/);
  assert.match(cronSource, /wecomDefaultTarget/);
  assert.match(cronSource, /wecomManualTarget/);
});

test('cron task dialog select menus render above the modal overlay', async () => {
  const cronSource = await fs.readFile(cronPagePath, 'utf8');
  const modalSelectContentUses = cronSource.match(/SelectContent className=\{MODAL_SELECT_CONTENT_CLS\}/g) ?? [];

  assert.match(cronSource, /const MODAL_SELECT_CONTENT_CLS = '!z-\[160\]'/);
  assert.equal(modalSelectContentUses.length, 3);
});

test('ignores normal workspace prompts and empty cron commands', async () => {
  const {
    buildWorkspaceCronAgentPrompt,
    getWorkspaceCronRequest,
    isWorkspaceCronCommand,
  } = await importWorkspaceCronCommand();

  assert.equal(buildWorkspaceCronAgentPrompt('帮我看下状态', '/tmp/project'), null);
  assert.equal(buildWorkspaceCronAgentPrompt('/ccem-cron', '/tmp/project'), null);
  assert.equal(buildWorkspaceCronAgentPrompt('/ccem-cron   ', '/tmp/project'), null);
  assert.equal(buildWorkspaceCronAgentPrompt('/ccem-cron 每天检查一下', null), null);
  assert.equal(getWorkspaceCronRequest('/ccem-cron 每天检查一下'), '每天检查一下');
  assert.equal(isWorkspaceCronCommand('/ccem-cronology 每天检查一下'), false);
});

test('/ccem-cron is available as a workspace slash command for both providers', async () => {
  const { getComposerCapabilities } = await importComposerCapabilities();

  for (const provider of ['claude', 'codex']) {
    assert.ok(
      getComposerCapabilities(provider).commands.some((command) => command.token === '/ccem-cron'),
      `${provider} should expose /ccem-cron`,
    );
  }
});
