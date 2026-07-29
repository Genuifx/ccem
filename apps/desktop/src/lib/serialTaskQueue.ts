export function createSerialTaskQueue<T>(
  task: (value: T) => Promise<void>,
): (value: T) => Promise<void> {
  let tail = Promise.resolve();

  return (value: T) => {
    const current = tail.then(() => task(value));
    tail = current.catch(() => undefined);
    return current;
  };
}
