/**
 * useLiveActivity — NVC360 Driver Live Activity / Dynamic Island integration
 *
 * Manages a single iOS Live Activity for the current active job.
 * - Starts when driver accepts (assigned) or begins driving (enroute)
 * - Updates on each status change and GPS ping
 * - Ends when job is completed or cancelled
 * - Push token is sent to server so backend can update via APNs
 *
 * Safe on Android / older iOS (all calls are no-ops there).
 *
 * ── Why activity ids are PERSISTED ────────────────────────────────────────────
 * iOS Live Activities are owned by the SYSTEM, not by the app process. Once
 * started, the pill stays on the Lock Screen / Dynamic Island until the app
 * explicitly ends it (or up to 8h/12h later when iOS reaps it). Killing the
 * app does NOT remove it.
 *
 * The old code held the activity id only in a `useRef` inside the job screen.
 * The moment that screen unmounted — navigating back, the job list emptying,
 * signing out, or the app being closed — the id was gone and there was no
 * longer any way to call `stopActivity(id, ...)`. The result was exactly what
 * Dan saw: a driver with no jobs left, signed out and app closed, still had an
 * NVC360 activity sitting in the Dynamic Island, and iOS kept the app
 * registered as having live background content.
 *
 * So every id we start is written to SecureStore, and `endAllLiveActivities()`
 * can clear them from anywhere — including a fresh cold start of a brand new
 * process that never started the activity in the first place.
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { authHeaders } from "./auth";

// Lazy import so Android bundle doesn't fail if native module isn't linked
let LiveActivity: typeof import("expo-live-activity") | null = null;
try {
  if (Platform.OS === "ios") {
    LiveActivity = require("expo-live-activity");
  }
} catch {}

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

/** SecureStore key holding a JSON array of activity ids we believe are live. */
const LIVE_IDS_KEY = "live_activity_ids";

function readLiveIds(): string[] {
  try {
    const raw = SecureStore.getItem(LIVE_IDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    // Keychain reads can throw on a locked device — treat as "none tracked"
    // rather than letting it escalate into a crash on boot.
    return [];
  }
}

function writeLiveIds(ids: string[]): void {
  try {
    if (ids.length === 0) SecureStore.setItem(LIVE_IDS_KEY, "[]");
    else SecureStore.setItem(LIVE_IDS_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* best-effort — worst case we lose the ability to end a stray activity */
  }
}

function trackId(id: string): void {
  writeLiveIds([...readLiveIds(), id]);
}

function untrackId(id: string): void {
  writeLiveIds(readLiveIds().filter((x) => x !== id));
}

export interface LiveActivityJobState {
  jobId: string;
  clientName: string;
  address: string;
  status: string;
  etaMins?: number | null;
}

const STATUS_LABELS: Record<string, string> = {
  assigned:    "Job assigned",
  enroute:     "Tech is on the way",
  arrived:     "Tech has arrived",
  in_progress: "Job in progress",
  completed:   "Job complete",
};

function buildState(job: LiveActivityJobState) {
  const label = STATUS_LABELS[job.status] ?? job.status;
  const etaMs = job.etaMins != null && job.etaMins > 0
    ? new Date(Date.now() + job.etaMins * 60 * 1000).getTime()
    : undefined;

  return {
    // Brand is carried by the logo badge now — no redundant "NVC360 ·" prefix in the title.
    title: label,
    subtitle: job.clientName ? `${job.clientName} · ${job.address}` : job.address,
    progressBar: etaMs
      ? { date: etaMs }                               // countdown timer to ETA
      : { progress: job.status === "completed" ? 1 : 0.5 },
    imageName: "nvc_icon",
    dynamicIslandImageName: "nvc_di",
  };
}

function buildConfig(status: string, jobId: string) {
  const isComplete = status === "completed";
  return {
    backgroundColor: isComplete ? "064e3b" : "070b12",   // brand ink navy; deep green on complete
    titleColor: "FFFFFF",
    subtitleColor: "8FA3B8",
    progressViewTint: "0ea5e9",
    progressViewLabelColor: "FFFFFF",
    timerType: "digital" as const,
    padding: { horizontal: 16, top: 14, bottom: 14 },
    imagePosition: "right" as const,
    imageAlign: "center" as const,
    imageSize: { width: 46, height: 46 },
    contentFit: "contain" as const,
    // Bug fix: this used to always resolve to "/job/" with no id — tapping the
    // activity/Dynamic Island never opened the right job. Now deep-links straight
    // into the active job screen.
    deepLinkUrl: `/job/${jobId}`,
  };
}

/**
 * Ends every Live Activity this app believes is running and forgets them.
 *
 * Call it whenever the driver should have NOTHING on screen from us:
 * sign-out, going off shift, no active job left, or a cold start that finds
 * no session. Safe to call repeatedly and on Android (no-op).
 */
export async function endAllLiveActivities(): Promise<void> {
  const ids = readLiveIds();
  // Always clear the record, even if the native calls fail — a stale id we can
  // never stop is worse than none, and iOS reaps abandoned activities itself.
  writeLiveIds([]);
  if (!LiveActivity) return;
  for (const id of ids) {
    try {
      LiveActivity.stopActivity?.(id, {
        title: "Shift ended",
        progressBar: { progress: 1 },
      } as any);
    } catch {
      /* already gone / unsupported */
    }
  }
}

/** POST push token to server so backend can send APNs Live Activity updates */
async function sendTokenToServer(jobId: string, token: string, type: "update" | "start") {
  try {
    await fetch(`${API}/api/tracking/${jobId}/live-activity-token`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ token, type }),
    });
  } catch {
    // non-critical — local updates still work
  }
}

export function useLiveActivity(job: LiveActivityJobState | null | undefined) {
  const activityIdRef = useRef<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);

  function endCurrent(finalState?: LiveActivityJobState) {
    const id = activityIdRef.current;
    if (!id) return;
    activityIdRef.current = null;
    prevStatusRef.current = null;
    try {
      LiveActivity?.stopActivity?.(
        id,
        finalState
          ? buildState(finalState)
          : ({ title: "Job closed", progressBar: { progress: 1 } } as any),
      );
    } catch {
      /* already gone */
    }
    untrackId(id);
  }

  // Register for push token changes (lets server push updates via APNs)
  useEffect(() => {
    if (!LiveActivity || !job) return;

    const updateSub = LiveActivity.addActivityTokenListener?.(({ activityID, activityPushToken }) => {
      if (activityID === activityIdRef.current && job.jobId) {
        sendTokenToServer(job.jobId, activityPushToken, "update");
      }
    });

    const startSub = LiveActivity.addActivityPushToStartTokenListener?.((ev: any) => {
      if (job.jobId && ev.activityPushToStartToken) {
        sendTokenToServer(job.jobId, ev.activityPushToStartToken, "start");
      }
    });

    return () => {
      updateSub?.remove?.();
      startSub?.remove?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId]);

  // Keep our persisted id list honest: if the driver swipes the activity away
  // (or iOS reaps it), drop the id so we don't try to stop a dead activity.
  useEffect(() => {
    if (!LiveActivity) return;
    const sub = LiveActivity.addActivityUpdatesListener?.((ev: any) => {
      if (ev?.activityState === "ended" || ev?.activityState === "dismissed") {
        if (ev.activityID === activityIdRef.current) {
          activityIdRef.current = null;
          prevStatusRef.current = null;
        }
        if (ev.activityID) untrackId(ev.activityID);
      }
    });
    return () => sub?.remove?.();
  }, []);

  // Start / update / stop activity based on job status changes
  useEffect(() => {
    if (!LiveActivity) return;

    // No job in scope any more (job cleared, data gone, driver navigated away
    // from a job that no longer exists). Previously this early-returned BEFORE
    // the stop branch, which is how activities were orphaned — the pill lived
    // on with nobody left holding its id.
    if (!job) {
      endCurrent();
      return;
    }

    const { status } = job;
    const ACTIVE = ["assigned", "enroute", "arrived", "in_progress"];
    const isActive = ACTIVE.includes(status);

    // Start activity when job becomes active and no activity is running
    if (isActive && !activityIdRef.current) {
      try {
        const id = LiveActivity.startActivity?.(buildState(job), buildConfig(status, job.jobId));
        if (id) {
          activityIdRef.current = id;
          prevStatusRef.current = status;
          // Persist immediately — if the process dies a millisecond from now,
          // this id is the only way to ever clear the pill.
          trackId(id);
        }
      } catch {
        // Live Activities not supported (simulator, old iOS, etc.)
      }
      return;
    }

    // Update if status changed or ETA changed
    if (activityIdRef.current && isActive && status !== prevStatusRef.current) {
      try {
        LiveActivity.updateActivity?.(activityIdRef.current, buildState(job));
        prevStatusRef.current = status;
      } catch {}
      return;
    }

    // End activity on completion/cancellation
    if (activityIdRef.current && !isActive) {
      endCurrent(job);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.etaMins, job?.jobId, !job]);

  // Leaving the job screen must not leave a pill behind with no owner. The job
  // screen is only mounted while the tech is actually working that job; the
  // server can restart the activity via APNs push-to-start if needed.
  useEffect(() => {
    return () => {
      endCurrent();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Call this on each GPS ping to update ETA countdown in real time */
  function updateEta(etaMins: number) {
    if (!LiveActivity || !activityIdRef.current || !job) return;
    try {
      LiveActivity.updateActivity?.(activityIdRef.current, buildState({ ...job, etaMins }));
    } catch {}
  }

  return { updateEta };
}
