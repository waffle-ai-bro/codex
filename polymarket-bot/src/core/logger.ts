/** Minimal structured logger. Never log secrets. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /key|secret|passphrase|private|signature|token|authorization/i;

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

export class Logger {
  constructor(
    private readonly name: string,
    private readonly minLevel: LogLevel = (process.env["LOG_LEVEL"] as LogLevel) || "info",
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  ) {}

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      name: this.name,
      msg,
      ...(fields ? redact(fields) : {}),
    };
    this.sink(JSON.stringify(entry));
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }
}
