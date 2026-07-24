const start = Date.now()

function stamp(): string {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1).padStart(6)
  return `[${elapsed}s]`
}

export const log = {
  info(...args: unknown[]): void {
    console.log(stamp(), ...args)
  },
  warn(...args: unknown[]): void {
    console.warn(stamp(), '!', ...args)
  },
  error(...args: unknown[]): void {
    console.error(stamp(), 'x', ...args)
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG === 'true') console.log(stamp(), '·', ...args)
  },
}
