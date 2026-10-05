type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /pass|token|secret|session|cookie|hash/i;
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === "test" ? "error" : "info");

function Scrub(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) clean[key] = SECRET_KEYS.test(key) ? "[redacted]" : value;
  return clean;
}

export interface Logger {
  Debug(message: string, details?: Record<string, unknown>): void;
  Info(message: string, details?: Record<string, unknown>): void;
  Warn(message: string, details?: Record<string, unknown>): void;
  Error(message: string, details?: Record<string, unknown>): void;
}

export function CreateLogger(scope: string): Logger {
  const Write = (level: LogLevel, message: string, details?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, scope, message, ...Scrub(details) });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    Debug: (message, details) => Write("debug", message, details),
    Info: (message, details) => Write("info", message, details),
    Warn: (message, details) => Write("warn", message, details),
    Error: (message, details) => Write("error", message, details)
  };
}
