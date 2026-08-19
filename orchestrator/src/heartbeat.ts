/** Heartbeat file shared by the main loop and the docker healthcheck. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HEARTBEAT_FILE = "heartbeat";

export function heartbeatPath(stateDir: string): string {
  return join(stateDir, HEARTBEAT_FILE);
}

export function writeHeartbeat(stateDir: string, now: Date = new Date()): void {
  const path = heartbeatPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${now.toISOString()}\n`, "utf8");
}

/** Age of the heartbeat in seconds, or null when it is missing or unreadable. */
export function heartbeatAgeSeconds(stateDir: string, now: Date = new Date()): number | null {
  const path = heartbeatPath(stateDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const stamp = Date.parse(readFileSync(path, "utf8").trim());
    if (Number.isNaN(stamp)) {
      return null;
    }
    return Math.round((now.getTime() - stamp) / 1000);
  } catch {
    return null;
  }
}
