import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCronCommands } from '../cronCommands.js';
import { listCronTasksViaDesktop, triggerCronTask } from '../cron.js';

vi.mock('../cron.js', () => ({
  createCronTaskWithNotifications: vi.fn(),
  getCronNotificationTargets: vi.fn(),
  deleteCronTask: vi.fn(),
  formatCronTaskTableRows: vi.fn(),
  listCronTasksViaDesktop: vi.fn(),
  parseCronCreateJson: vi.fn(),
  parseStringList: vi.fn(),
  triggerCronTask: vi.fn(),
}));

const originalExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode;
});

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerCronCommands(program);
  await program.parseAsync(['node', 'ccem', 'cron', ...args]);
}

describe('registered cron commands', () => {
  it('lists the Desktop tasks as machine-readable JSON', async () => {
    const tasks = [{ id: 'task-1', name: 'Release check' }];
    vi.mocked(listCronTasksViaDesktop).mockResolvedValue(tasks as never);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['list', '--json']);
    expect(listCronTasksViaDesktop).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(tasks);
  });

  it('passes the exact trigger selector and awaits the Desktop result', async () => {
    const task = { id: 'task-1', name: 'Release check' };
    vi.mocked(triggerCronTask).mockResolvedValue(task as never);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['trigger', 'Release check', '--json']);
    expect(triggerCronTask).toHaveBeenCalledWith('Release check');
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(task);
  });

  it('reports a failed trigger without emitting a success response', async () => {
    vi.mocked(triggerCronTask).mockRejectedValue(new Error('Desktop unavailable'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(['trigger', 'task-1', '--json']);
    expect(process.exitCode).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain('Desktop unavailable');
  });
});
