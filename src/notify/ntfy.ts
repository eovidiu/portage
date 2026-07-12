// F-029 sync-notifications — publishes sync-run outcomes to an ntfy topic.
// Every function here is fire-and-forget safe: a publish failure is logged as
// `ntfy_notify_failed` and never thrown, so a notification can never fail or
// alter a sync run. The whole module is a no-op when NTFY_TOPIC is unset.

import type { Env } from "../env";
import type { OrchestratorResult } from "../sync/orchestrator";

// Verified: https://docs.ntfy.sh/publish/ — POST {base}/{topic}; headers
// `Title`, `Priority` (1–5), `Tags` (emoji shortcodes); optional
// `Authorization: Bearer <token>`; body is plain UTF-8 text (≤ 4096 bytes).
const DEFAULT_NTFY_URL = "https://ntfy.sh";

const PUBLISH_TIMEOUT_MS = 5_000;

export interface NtfyMessage {
  title: string;
  body: string;
  /** ntfy priority: 2 = low (routine success), 4 = high (needs attention). */
  priority: 2 | 4;
  /** Comma-separated ntfy tags (emoji shortcodes). */
  tags: string;
}

export async function sendNtfyNotification(
  env: Env,
  message: NtfyMessage,
): Promise<void> {
  if (!env.NTFY_TOPIC) return;

  const base = env.NTFY_URL ?? DEFAULT_NTFY_URL;
  const headers: Record<string, string> = {
    Title: message.title,
    Priority: String(message.priority),
    Tags: message.tags,
  };
  if (env.NTFY_TOKEN) {
    headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  }

  try {
    const response = await fetch(`${base}/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers,
      body: message.body,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logNotifyFailed(`ntfy responded ${response.status}`);
    }
  } catch (err) {
    logNotifyFailed(err instanceof Error ? err.message : String(err));
  }
}

// The topic is a secret (it is the ntfy access credential) — never log it.
function logNotifyFailed(error: string): void {
  console.log(JSON.stringify({ event: "ntfy_notify_failed", error }));
}

const OUTCOME_PRESENTATION: Record<
  "succeeded" | "partial" | "failed",
  { priority: 2 | 4; tags: string }
> = {
  succeeded: { priority: 2, tags: "white_check_mark" },
  partial: { priority: 4, tags: "warning" },
  failed: { priority: 4, tags: "rotating_light" },
};

export async function notifySyncOutcome(
  env: Env,
  result: OrchestratorResult,
): Promise<void> {
  if (result.outcome === "skipped_locked") return;

  const parts: string[] = [];
  if (result.tracks_seen !== undefined) {
    parts.push(
      `seen ${result.tracks_seen} · isrc ${result.matched_isrc} · ` +
        `fuzzy ${result.matched_fuzzy} · unmatched ${result.unmatched} · ` +
        `errors ${result.errors}`,
    );
  }
  if (result.error_code) parts.push(`error_code: ${result.error_code}`);
  if (result.run_id) parts.push(`run ${result.run_id}`);

  await sendNtfyNotification(env, {
    title: `Portage sync ${result.outcome}`,
    body: parts.join("\n"),
    ...OUTCOME_PRESENTATION[result.outcome],
  });
}

export async function notifyAbandonedSweep(
  env: Env,
  count: number,
): Promise<void> {
  await sendNtfyNotification(env, {
    title: `Portage: ${count} abandoned run(s) swept`,
    body:
      "Previous run(s) never finished (isolate killed before completion); " +
      "marked failed/abandoned by the pre-run sweep.",
    priority: 4,
    tags: "ghost",
  });
}

export async function notifyOrchestratorCrash(
  env: Env,
  err: unknown,
): Promise<void> {
  await sendNtfyNotification(env, {
    title: "Portage sync failed",
    body: `orchestrator crashed before producing a result: ${
      err instanceof Error ? err.message : String(err)
    }`,
    priority: 4,
    tags: "rotating_light",
  });
}
