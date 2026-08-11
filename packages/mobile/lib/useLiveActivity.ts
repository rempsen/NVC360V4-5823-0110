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
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { authHeaders } from "./auth";

// Lazy import so Android bundle doesn't fail if native module isn't linked
let LiveActivity: typeof import("expo-live-activity") | null = null;
try {
  if (Platform.OS === "ios") {
    LiveActivity = require("expo-live-activity");
  }
} catch {}

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

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

  // Start / update / stop activity based on job status changes
  useEffect(() => {
    if (!LiveActivity || !job) return;

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
      try {
        LiveActivity.stopActivity?.(activityIdRef.current, buildState(job));
        activityIdRef.current = null;
        prevStatusRef.current = null;
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.etaMins, job?.jobId]);

  /** Call this on each GPS ping to update ETA countdown in real time */
  function updateEta(etaMins: number) {
    if (!LiveActivity || !activityIdRef.current || !job) return;
    try {
      LiveActivity.updateActivity?.(activityIdRef.current, buildState({ ...job, etaMins }));
    } catch {}
  }

  return { updateEta };
}
