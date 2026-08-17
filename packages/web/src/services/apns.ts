/**
 * apns.ts — Apple Push Notification Service (HTTP/2) sender
 *
 * Used to push Live Activity updates to iOS devices when job status changes.
 * Requires:
 *   APNS_KEY_ID    — Key ID from Apple Dev portal (same as ascApiKeyId)
 *   APNS_TEAM_ID   — Apple Team ID (86S82A9ZPS)
 *   APNS_KEY_PATH  — Path to AuthKey_*.p8 private key file
 *   APNS_BUNDLE_ID — iOS bundle identifier (com.nvc360.uberize)
 *
 * Falls back to no-op if env vars are missing (dev/web environments).
 */

import * as fs from "fs";
import * as crypto from "crypto";

const KEY_ID    = process.env.APNS_KEY_ID    ?? process.env.EXPO_EAS_API_KEY_ID ?? "";
const TEAM_ID   = process.env.APNS_TEAM_ID   ?? "86S82A9ZPS";
const KEY_PATH  = process.env.APNS_KEY_PATH  ?? "";
const BUNDLE_ID = process.env.APNS_BUNDLE_ID ?? "com.nvc360.uberize";

const APNS_HOST = process.env.APNS_ENV === "sandbox"
  ? "api.sandbox.push.apple.com"
  : "api.push.apple.com";

// Cache the signed JWT (valid 60 min, refresh 50 min)
let cachedJwt: { token: string; exp: number } | null = null;

function getPrivateKey(): string | null {
  if (!KEY_PATH) return null;
  try { return fs.readFileSync(KEY_PATH, "utf8"); } catch { return null; }
}

function makeJwt(privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: TEAM_ID, iat: now })).toString("base64url");
  // APNs uses an EC (ES256) key, so the signer is created with ECDSA.
  const ecSign = crypto.createSign("SHA256");
  ecSign.update(`${header}.${payload}`);
  const sig = ecSign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }, "base64url");
  return `${header}.${payload}.${sig}`;
}

function getJwt(): string | null {
  if (!KEY_ID || !TEAM_ID) return null;
  const pem = getPrivateKey();
  if (!pem) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp > now + 60) return cachedJwt.token;
  const token = makeJwt(pem);
  cachedJwt = { token, exp: now + 3000 };
  return token;
}

export interface LiveActivityPushPayload {
  /** "update" or "end" */
  event: "update" | "end";
  contentState: {
    title: string;
    subtitle?: string;
    timerEndDateInMilliseconds?: number;
    progress?: number;
    imageName?: string;
    dynamicIslandImageName?: string;
    elapsedTimerStartDateInMilliseconds?: null;
  };
}

/**
 * Send a Live Activity update to a specific device via APNs.
 * @param pushToken  The activityPushToken received from expo-live-activity
 * @param payload    The content-state payload
 */
export async function sendLiveActivityUpdate(
  pushToken: string,
  payload: LiveActivityPushPayload,
): Promise<void> {
  const jwt = getJwt();
  if (!jwt) {
    // Not configured — silently skip (dev / web env)
    return;
  }

  const body = JSON.stringify({
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: payload.event,
      "content-state": payload.contentState,
    },
  });

  try {
    const res = await fetch(`https://${APNS_HOST}/3/device/${pushToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-push-type": "liveactivity",
        "apns-topic": `${BUNDLE_ID}.push-type.liveactivity`,
        "content-type": "application/json",
      },
      body,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn("[apns] Live Activity push failed:", res.status, err);
    }
  } catch (e) {
    console.warn("[apns] Live Activity push error:", e);
  }
}

/**
 * Live Activity push tokens for a booking, read out of `bookings.field_data`.
 *
 * `field_data` is a JSON *text* column shared with the work-order template
 * fields, so this parses defensively: a corrupt or empty blob must degrade to
 * "no token registered", never throw on the status-change path.
 */
export function readLiveActivityTokens(
  fieldData: string | null | undefined,
): { start?: string; update?: string } {
  if (!fieldData) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fieldData);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const o = parsed as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { start: pick(o.__la_push_start_token), update: pick(o.__la_push_update_token) };
}

/** Key under which each token lives inside `bookings.field_data`. */
export const LA_TOKEN_KEYS = {
  start: "__la_push_start_token",
  update: "__la_push_update_token",
} as const;

/**
 * Helper: push a job status update to the driver's Live Activity.
 * Reads __la_push_update_token out of the booking's raw `fieldData` JSON.
 */
export async function pushLiveActivityJobUpdate(booking: {
  id: string;
  /** Raw `bookings.field_data` JSON text. */
  fieldData?: string | null;
  status: string;
  etaMins?: number | null;
  customerName?: string | null;
  address?: string | null;
}) {
  const token = readLiveActivityTokens(booking.fieldData).update;
  if (!token) return; // no token registered for this booking

  const STATUS_LABELS: Record<string, string> = {
    assigned:    "Job assigned",
    enroute:     "Tech is on the way",
    arrived:     "Tech has arrived",
    in_progress: "Job in progress",
    completed:   "Job complete",
  };

  const label = STATUS_LABELS[booking.status] ?? booking.status;
  const isComplete = booking.status === "completed";
  const etaMs = booking.etaMins != null && booking.etaMins > 0
    ? Date.now() + booking.etaMins * 60 * 1000
    : undefined;

  await sendLiveActivityUpdate(token, {
    event: isComplete ? "end" : "update",
    contentState: {
      // Brand is carried by the logo badge now — keep in sync with client-side
      // buildState() in lib/useLiveActivity.ts (no redundant "NVC360 ·" prefix).
      title: label,
      subtitle: booking.customerName
        ? `${booking.customerName} · ${booking.address ?? ""}`
        : booking.address ?? "",
      timerEndDateInMilliseconds: etaMs,
      progress: isComplete ? 1 : 0.5,
      imageName: "nvc_icon",
      dynamicIslandImageName: "nvc_di",
      elapsedTimerStartDateInMilliseconds: null,
    },
  });
}
