import fs from 'node:fs/promises';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (predicate()) return;
    await delay(Math.min(10, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitClosed(closed, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopHelper(child, closed, timeoutMs) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (await waitClosed(closed, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!await waitClosed(closed, timeoutMs)) throw new Error('Helper did not close after forced fixture cleanup');
}

function fixtureGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error; // EPERM and other probe failures are not evidence of exit.
  }
}

async function finishFixture({ child, closed, capture, output, timeoutMs = 10000, shutdownMs = 2000, stdinErrors }) {
  let helperClosed = false;
  void closed.then(() => { helperClosed = true; });
  let turnError;
  try {
    await waitUntil(() => {
      const lines = output().stdout.split('\n').slice(0, -1);
      const ready = lines.some((line) => {
        if (!line.trim()) return false;
        const event = JSON.parse(line);
        return event.type === 'status' && event.status === 'ready'
          && event.detail === 'Ready for the next prompt.';
      });
      if (ready) return true;
      if (helperClosed) throw new Error('Helper closed before exact post-turn ready');
      return false;
    }, timeoutMs, 'exact post-turn ready (SDK fixture exit)');
  } catch (error) {
    turnError = error;
  }

  const cleanupErrors = [];
  if (turnError) {
    // A failed/aborted SDK stream may skip its exit wait. Stop it cooperatively,
    // then prove this fixture is gone while its helper can still reap it.
    let fixture;
    try {
      fixture = JSON.parse(await fs.readFile(capture, 'utf8'));
      if (!Number.isSafeInteger(fixture.pid) || fixture.pid <= 0 || fixture.ppid !== child.pid) {
        throw new Error(`Cannot prove fixture ownership from ${capture}`);
      }
    } catch (error) { cleanupErrors.push(error); }
    if (!helperClosed && child.stdin.writable) {
      try {
        const sent = await waitClosed(new Promise((resolve, reject) => child.stdin.end(`${JSON.stringify({ type: 'stop' })}\n`,
          (error) => error ? reject(error) : resolve())), shutdownMs);
        if (!sent) throw new Error('Timed out writing fixture stop command');
      } catch (error) { cleanupErrors.push(error); }
    }
    if (fixture && fixture.ppid === child.pid && Number.isSafeInteger(fixture.pid) && fixture.pid > 0) {
      try { await waitUntil(() => fixtureGone(fixture.pid), shutdownMs, `owned SDK fixture ${fixture.pid} to exit`); }
      catch (error) { cleanupErrors.push(error); }
    } else {
      // Give the protocol stop its grace period even when ownership evidence is
      // missing. Parent closure alone does not authorize removing the fixture cwd.
      await waitClosed(closed, shutdownMs);
    }
  }
  try { await stopHelper(child, closed, shutdownMs); }
  catch (error) { cleanupErrors.push(error); }

  for (const error of stdinErrors) if (!cleanupErrors.includes(error)) cleanupErrors.push(error);
  if (turnError || cleanupErrors.length) {
    const { stdout, stderr } = output();
    const errors = [turnError, ...cleanupErrors].filter(Boolean);
    const error = new AggregateError(errors,
      `${errors.map((item) => item.message).join('; ')}\nCapture: ${capture}\nstdout: ${stdout}\nstderr: ${stderr}`);
    error.fixtureCleanupIncomplete = cleanupErrors.length > 0;
    throw error;
  }
}

// Always settle the SDK child, including when a capture assertion fails. Keep
// both failures if teardown also fails; callers retain the cwd when unproven.
export async function withCodexFixtureCleanup(options, body) {
  const stdinErrors = [];
  const onStdinError = (error) => { stdinErrors.push(error); };
  options.child.stdin.on('error', onStdinError);
  options.child.stdin.once('close', () => options.child.stdin.removeListener('error', onStdinError));
  let failure;
  let result;
  try { result = await body(); } catch (error) { failure = error; }
  try { await finishFixture({ ...options, stdinErrors }); }
  catch (cleanupError) {
    if (!failure) throw cleanupError;
    const error = new AggregateError([failure, cleanupError], 'Fixture assertion and cleanup both failed');
    error.fixtureCleanupIncomplete = cleanupError.fixtureCleanupIncomplete;
    throw error;
  }
  if (failure) throw failure;
  return result;
}
