/**
 * One dialog at a time across the main agent and every subagent: they run
 * in one process and share one terminal, so permission asks from parallel
 * agents queue here instead of fighting over the screen.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serializeDialog<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
