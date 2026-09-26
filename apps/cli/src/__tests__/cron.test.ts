import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createCronTask,
  createCronTaskWithNotifications,
  deleteCronTask,
  parseCronCreateJson,
  readCronTasks,
  writeCronTasks,
} from '../cron.js';

describe('cron task store', () => {
  let tempDir: string;
  let tasksPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-cron-test-'));
    tasksPath = path.join(tempDir, 'cron-tasks.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a task through the structured store contract', () => {
    const task = createCronTask({
      name: 'Daily Review',
      cronExpression: '0 9 * * *',
      prompt: 'Review recent commits',
      workingDir: '/repo',
      envName: 'glm-official',
      executionProfile: 'standard',
      allowedTools: ['Bash', 'Read'],
      timeoutSecs: 600,
    }, tasksPath);

    expect(task.id).toMatch(/^cron-\d+-[0-9a-f]{4}$/);
    expect(task.enabled).toBe(true);
    expect(task.triggerType).toBe('schedule');
    expect(readCronTasks(tasksPath)).toEqual([task]);

    const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
    expect(raw).toEqual({ tasks: [task] });
  });

  it('normalizes legacy raw-array stores back to the object wrapper on write', () => {
    fs.writeFileSync(tasksPath, JSON.stringify([
      {
        id: 'cron-old',
        name: 'Old',
        cronExpression: '0 8 * * *',
        prompt: 'Old task',
        workingDir: '/repo',
        envName: null,
        executionProfile: 'standard',
        maxBudgetUsd: null,
        allowedTools: [],
        disallowedTools: [],
        enabled: true,
        timeoutSecs: 300,
        templateId: null,
        triggerType: 'schedule',
        parentTaskId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]));

    const tasks = readCronTasks(tasksPath);
    writeCronTasks(tasks, tasksPath);

    expect(JSON.parse(fs.readFileSync(tasksPath, 'utf-8'))).toEqual({ tasks });
  });

  it('rejects invalid cron expressions before writing', () => {
    expect(() => createCronTask({
      name: 'Bad',
      cronExpression: '0 9 * *',
      prompt: 'Bad task',
      workingDir: '/repo',
    }, tasksPath)).toThrow(/exactly 5 fields/);
    expect(fs.existsSync(tasksPath)).toBe(false);
  });

  it('deletes by exact id or name and rejects ambiguous names', () => {
    const first = createCronTask({
      name: 'Duplicate',
      cronExpression: '0 9 * * *',
      prompt: 'First',
      workingDir: '/repo',
    }, tasksPath);
    createCronTask({
      name: 'Duplicate',
      cronExpression: '0 10 * * *',
      prompt: 'Second',
      workingDir: '/repo',
    }, tasksPath);

    expect(() => deleteCronTask('Duplicate', tasksPath)).toThrow(/ambiguous/);
    expect(deleteCronTask(first.id, tasksPath)).toEqual(first);
    expect(readCronTasks(tasksPath)).toHaveLength(1);
  });

  it('parses create input from JSON aliases', () => {
    expect(parseCronCreateJson(JSON.stringify({
      name: 'From JSON',
      schedule: '0 7 * * *',
      prompt: 'Run task',
      timeoutSecs: 120,
      wecom_notification: {
        enabled: true,
        bot_id: 'aibot-1',
        peer_id: 'iveswen',
      },
    }))).toMatchObject({
      name: 'From JSON',
      cronExpression: '0 7 * * *',
      prompt: 'Run task',
      timeoutSecs: 120,
      wecomNotification: {
        enabled: true,
        botId: 'aibot-1',
        peerId: 'iveswen',
      },
    });
  });

  it('creates a task with WeCom result notifications enabled', () => {
    const task = createCronTask({
      name: 'WeCom Report',
      cronExpression: '0 9 * * *',
      prompt: 'Send report',
      workingDir: '/repo',
      wecomNotification: {
        enabled: true,
        botId: ' aibot-1 ',
        peerId: ' iveswen ',
      },
    }, tasksPath);

    expect(task.wecomNotification).toEqual({
      enabled: true,
      botId: 'aibot-1',
      peerId: 'iveswen',
    });
    expect(readCronTasks(tasksPath)[0]?.wecomNotification).toEqual(task.wecomNotification);
  });

  it('creates and reads back a task only after validating its paired Hermes target', async () => {
    const input = parseCronCreateJson(JSON.stringify({ name: 'Hermes report', cronExpression: '0 9 * * *', prompt: 'Report', hermesNotification: { routeId: 'route-one', generation: 3, subscriptionId: 'invented' } }));
    const methods: string[] = [];
    const task = await createCronTaskWithNotifications(input, tasksPath, async (method) => {
      methods.push(method);
      return [{ routeId: 'route-one', generation: 3, label: 'My bot', platform: 'wecom', chatId: 'paired-chat' }];
    });
    expect(methods).toEqual(['ccem.cron.notificationTargets']);
    expect(task.hermesNotification).toMatchObject({ routeId: 'route-one', generation: 3 });
    expect(task.hermesNotification?.subscriptionId).toBeTruthy();
    expect(task.hermesNotification?.subscriptionId).not.toBe('invented');
    expect(task.wecomNotification).toBeNull();
    expect(readCronTasks(tasksPath)).toEqual([task]);
  });

  it('rejects unavailable or stale targets and RPC errors before any task write', async () => {
    const input = { name: 'Report', cronExpression: '0 9 * * *', prompt: 'Report', hermesNotification: { routeId: 'paired', generation: 1 } };
    for (const targets of [[], [{ routeId: 'paired', generation: 2 }], [{ routeId: 'another', generation: 1 }]]) {
      await expect(createCronTaskWithNotifications(input, tasksPath, async () => targets)).rejects.toThrow(/unavailable or has changed/);
      expect(fs.existsSync(tasksPath)).toBe(false);
    }
    await expect(createCronTaskWithNotifications(input, tasksPath, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(fs.existsSync(tasksPath)).toBe(false);
  });

  it('keeps legacy task creation offline and notification-free', async () => {
    const task = await createCronTaskWithNotifications({ name: 'Local', cronExpression: '0 9 * * *', prompt: 'Local' }, tasksPath, async () => { throw new Error('must not call Desktop'); });
    expect(task.hermesNotification).toBeNull();
  });

  it('rejects malformed targets and gives separate tasks separate subscription versions', () => {
    for (const target of [{ routeId: 'guess' }, { routeId: 'paired', generation: 0 }, { routeId: '../path', generation: 1 }, 'paired']) {
      expect(() => parseCronCreateJson(JSON.stringify({ hermesNotification: target }))).toThrow(/hermesNotification/);
    }
    const input = { name: 'Report', cronExpression: '0 9 * * *', prompt: 'Report', hermesNotification: { routeId: 'paired', generation: 1 } };
    expect(createCronTask(input, tasksPath).hermesNotification?.subscriptionId).not.toBe(createCronTask(input, tasksPath).hermesNotification?.subscriptionId);
  });
});
