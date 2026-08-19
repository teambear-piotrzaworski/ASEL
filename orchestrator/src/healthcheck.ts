/**
 * Docker healthcheck entry point: exits 0 when the main loop wrote a fresh
 * heartbeat, 1 otherwise. Referenced from docker-compose.yml.
 */
import { heartbeatAgeSeconds } from "./heartbeat.js";

const stateDir = process.env["ASEL_STATE_DIR"] ?? "/data/state";
const maxAge = Number(process.env["ASEL_HEARTBEAT_MAX_AGE_SECONDS"] ?? "180");
const age = heartbeatAgeSeconds(stateDir);

if (age === null) {
  console.error(`unhealthy: no heartbeat in ${stateDir}`);
  process.exit(1);
}
if (age > maxAge) {
  console.error(`unhealthy: heartbeat is ${age}s old (max ${maxAge}s)`);
  process.exit(1);
}
console.log(`healthy: heartbeat is ${age}s old`);
process.exit(0);
