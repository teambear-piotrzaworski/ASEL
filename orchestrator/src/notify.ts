/** Push notifications. Woopy inbound webhook on the VPS, no-op locally. */
import type { GlobalConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RunOutcome } from "./machine.js";

/**
 * The whole push policy, in one place.
 *
 * Woopy is an alarm ("drop what you are doing"), not a reporting channel. A
 * push therefore goes out for exactly one situation: the process STOPPED and
 * cannot move again without a person. That is a failed run (`asel:failed`) and
 * a run that stopped on a question (`asel:blocked`).
 *
 * Everything else stays silent on purpose: a finished map, the spec and plan
 * gates, commits waiting for review. All of it is visible on GitHub, none of it
 * is urgent, and a channel that also carries the ordinary events stops being an
 * alarm within a day. Keeping the rule here rather than at the call sites is
 * what stops it from drifting back.
 */
export function shouldNotifyOutcome(outcome: RunOutcome): boolean {
  return outcome === "failure" || outcome === "blocked";
}

export interface NotificationEvent {
  title: string;
  message: string;
  url?: string;
}

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

export class NoopNotifier implements Notifier {
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async notify(event: NotificationEvent): Promise<void> {
    this.log.info("notification suppressed", { title: event.title, message: event.message });
  }
}

export class WoopyNotifier implements Notifier {
  private readonly url: string;
  private readonly log: Logger;

  constructor(url: string, log: Logger) {
    this.url = url;
    this.log = log;
  }

  async notify(event: NotificationEvent): Promise<void> {
    // TODO(slice-3): confirm the exact inbound payload schema against the
    // Woopy webhook docs before relying on this in production.
    const payload: Record<string, string> = { title: event.title, message: event.message };
    if (event.url !== undefined) {
      payload["url"] = event.url;
    }
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.log.warn("woopy notification rejected", {
          status: response.status,
          title: event.title,
        });
        return;
      }
      this.log.debug("woopy notification sent", { title: event.title });
    } catch (error) {
      // A missing push must never take the orchestrator down.
      this.log.warn("woopy notification failed", { error: (error as Error).message });
    }
  }
}

export function createNotifier(config: GlobalConfig, log: Logger): Notifier {
  const woopy = config.notifications.woopy;
  if (!woopy.enabled) {
    return new NoopNotifier(log);
  }
  const url = process.env[woopy.url_env];
  if (url === undefined || url.trim() === "") {
    log.warn("woopy notifications enabled but url env var is empty", { env: woopy.url_env });
    return new NoopNotifier(log);
  }
  return new WoopyNotifier(url, log);
}
