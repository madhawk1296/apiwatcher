/**
 * Plain timestamped lines to stdout. journald keeps them; `journalctl -u
 * apiwatcher -f` is the whole observability stack, and that is enough for one
 * box. Structured logging can come when there is more than one.
 */
export type Level = 'info' | 'warn' | 'error';

export function log(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const info = (m: string): void => log('info', m);
export const warn = (m: string): void => log('warn', m);
export const error = (m: string): void => log('error', m);
