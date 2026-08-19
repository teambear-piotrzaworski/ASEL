/** Minimal structured logger. One line per event, easy to grep in docker logs. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function currentLevel(): LogLevel {
  const raw = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

function formatMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${formatMeta(meta)}`;
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
