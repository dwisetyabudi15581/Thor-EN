// GET /api/bot-status — live bot health for the dashboard header (v3.31.0).
//
// Thin login-gated proxy over the bot's unauthenticated /health endpoint so
// the browser never talks to the bot directly. The header polls this every
// 15s (in step with the data auto-refresh) to render:
//   ● Online / Offline · gateway ping (ms) · guild count · uptime.
// Failures degrade to { online: false } — never a 500 (a header widget must
// not explode the page when the bot blips).

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotOfflineError } from "@/lib/bot-api";

export type BotStatusResponse = {
  online: boolean;
  pingMs?: number;
  guildCount?: number;
  uptimeSec?: number;
  version?: string;
};

export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  try {
    const data = await botApi<{
      ok: boolean;
      guildCount?: number;
      uptimeSec?: number;
      pingMs?: number;
      version?: string;
    }>("/health", { timeoutMs: 4000 });
    return json({
      online: Boolean(data?.ok),
      pingMs: typeof data?.pingMs === "number" ? data.pingMs : undefined,
      guildCount: typeof data?.guildCount === "number" ? data.guildCount : undefined,
      uptimeSec: typeof data?.uptimeSec === "number" ? data.uptimeSec : undefined,
      version: typeof data?.version === "string" ? data.version : undefined,
    } satisfies BotStatusResponse);
  } catch (err) {
    if (err instanceof BotOfflineError) {
      return json({ online: false } satisfies BotStatusResponse);
    }
    console.error(
      "[api/bot-status] DASH /health error:",
      err instanceof Error ? err.message : err
    );
    return json({ online: false } satisfies BotStatusResponse);
  }
}
