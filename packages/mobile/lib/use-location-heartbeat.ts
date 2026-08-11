import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { api } from "./api";
import { getToken } from "./auth";

/**
 * Continuously reports the driver's live GPS location to the backend
 * (PATCH /api/riders/me { lat, lng }) so the dispatch-map pin always reflects
 * the technician's real position — even when the phone is locked or the app is
 * backgrounded.
 *
 * GATING (important — this is what keeps the app from running in the
 * background when the tech never asked it to): native background location
 * tracking is only started while the rider is explicitly on shift
 * (`enabled` === true, driven by rider.status !== "offline"). It is NOT
 * enough to just have a signed-in session — a stored session survives every
 * app relaunch (including a HEADLESS background relaunch iOS performs for an
 * app with UIBackgroundModes:["location"]), so starting tracking merely
 * because a session exists means the app can be silently woken by the OS
 * forever, even for a tech who is off duty and never opened the app that day.
 * `enabled` must reflect an explicit user action (going on shift), not mere
 * auth state.
 *
 * Two layers, both start/stop together based on `enabled`:
 *  1. Background task (expo-task-manager + Location.startLocationUpdatesAsync)
 *     keeps reporting when the app is not in the foreground. iOS requires the
 *     "Always" location permission + UIBackgroundModes:location for this.
 *  2. Foreground watcher gives tighter, more responsive updates while the tech
 *     has the app open and is looking at the map.
 *
 * Presence signal: on mount (while enabled) and every time the app comes to
 * the foreground we send a heartbeat so the server stamps locationUpdatedAt
 * IMMEDIATELY — even before the first GPS fix arrives. This prevents the
 * scheduler from showing the tech as "Offline" during the GPS warm-up window.
 * The heartbeat does NOT set status:"available" (that used to silently
 * override an explicit "Offline" toggle — see riders.ts `heartbeat` flag).
 *
 * Per-job ETA pings still happen separately inside the job screen while enroute.
 */

const BG_TASK = "nvc-location-heartbeat";

/**
 * Guards a promise with a hard timeout. Critical for anything awaited inside
 * the native background-location task callback: iOS keeps this whole app
 * process alive (not suspended) while UIBackgroundModes:["location"] is
 * active, and a hung network call with no timeout can tie up that execution
 * indefinitely — a well-known cause of the OS watchdog silently killing an
 * app in the background (0x8badf00d-style termination). These terminations
 * happen at the OS level, outside the JS/native exception handlers Sentry
 * hooks into, so they show up to the user as "app quit unexpectedly" with
 * NO corresponding Sentry event — exactly the pattern this fixes.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/** Shared throttle so background + foreground don't double-spam the API. */
let lastSent = 0;

/**
 * @returns "off-duty" when the server (or a missing/rejected session) says
 * this device should not be reporting location at all, so the caller can shut
 * native tracking down. "ok" means keep going; "unknown" means we learned
 * nothing this round (throttled, offline, timed out) and must NOT shut down —
 * a flaky tunnel is not a reason to stop tracking a tech who is on a job.
 */
async function pushLocation(lat: number, lng: number): Promise<"ok" | "off-duty" | "unknown"> {
  if (!getToken()) return "off-duty";
  const now = Date.now();
  if (now - lastSent < 6_000) return "unknown"; // at most once per 6s
  lastSent = now;
  try {
    const res = await withTimeout(api.riders.me.$patch({ json: { lat, lng } }), 15_000);
    // 401/403 = session revoked or the membership was pulled. Keeping the GPS
    // running for a device the server no longer accepts is pure battery burn.
    // Cast: the typed hono client only knows the handler's own 200/404 returns.
    // 401/403 are produced by the auth middleware in front of it, so they are
    // absent from the inferred union but very much possible at runtime.
    const code = res.status as number;
    if (code === 401 || code === 403) return "off-duty";
    if (!res.ok) return "unknown";
    const json = (await res.json()) as { rider?: { status?: string } | null };
    return json?.rider?.status === "offline" ? "off-duty" : "ok";
  } catch {
    /* offline / transient / timed out — next tick retries */
    return "unknown";
  }
}

/**
 * Send an "I'm alive" signal without requiring GPS coords and WITHOUT
 * changing shift status. Stamps locationUpdatedAt on the server so the
 * presence system sees the tech as online even before a GPS fix has arrived
 * — but a rider who has explicitly gone Offline must stay Offline; this must
 * never flip status back to "available" (that was the second half of the
 * background-relaunch bug: it silently undid the on/off-shift toggle).
 */
async function pingOnline() {
  if (!getToken()) return;
  try {
    await withTimeout(api.riders.me.$patch({ json: { heartbeat: true } }), 15_000);
  } catch {
    /* transient / timed out — ignore */
  }
}

// ---- Background task definition (module scope — required by TaskManager) ----
//
// SELF-SHUTOFF (this is what stops the app running in the background forever):
// a registered location task is owned by the OS, not by our React tree. When
// the app is force-quit or iOS relaunches it HEADLESSLY to deliver a location,
// the rider layout never mounts, so the `enabled === false` branch in
// useLocationHeartbeat never runs and nothing was left to call
// stopLocationUpdatesAsync. That is how a signed-out / off-shift tech kept
// seeing the location indicator with the app apparently alive in the
// background. The task therefore has to be able to cancel ITSELF, using only
// what it can see from inside a background slice: is there still a session, and
// does the server still consider this tech on duty.
TaskManager.defineTask(BG_TASK, async ({ data, error }) => {
  if (error) return;
  try {
    // No session at all — the driver signed out (or the token was cleared).
    // Kill tracking here rather than reporting for a logged-out phone.
    if (!getToken()) {
      await stopBackgroundUpdates();
      return;
    }
    const locs = (data as { locations?: Location.LocationObject[] })?.locations;
    const loc = locs?.[locs.length - 1];
    if (loc) {
      const verdict = await pushLocation(loc.coords.latitude, loc.coords.longitude);
      // Only shut down on a definite off-duty answer. "unknown" (offline,
      // timeout, throttled) must keep tracking alive — a tech driving through
      // a dead zone still needs to be on the dispatch map.
      if (verdict === "off-duty") await stopBackgroundUpdates();
    }
  } catch {
    // Never let an unexpected error inside the background delivery callback
    // propagate — the native side is holding a background execution slice
    // open while this runs.
  }
});

async function startBackgroundUpdates() {
  try {
    // "Always" permission is required for background delivery.
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return false;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (!bg.granted) return false;

    const already = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(
      () => false,
    );
    if (already) return true;

    await Location.startLocationUpdatesAsync(BG_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 10_000,
      distanceInterval: 25, // meters
      pausesUpdatesAutomatically: false,
      // Keeps the OS from killing updates; shows the system location banner.
      foregroundService: {
        notificationTitle: "NVC360 is sharing your location",
        notificationBody: "Your live location is visible to dispatch while on shift.",
        notificationColor: "#0ea5e9",
      },
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.AutomotiveNavigation,
    });
    return true;
  } catch {
    return false;
  }
}

async function stopBackgroundUpdates() {
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(BG_TASK).catch(
      () => false,
    );
    if (started) await Location.stopLocationUpdatesAsync(BG_TASK);
  } catch {
    /* ignore */
  }
}

/**
 * @param enabled Only start native background/foreground GPS tracking while
 * this is true. Must reflect the rider's explicit on-shift/"available"
 * status (never just "is there a session") — see file header.
 */
export function useLocationHeartbeat(enabled: boolean) {
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const granted = useRef(false);
  const keepaliveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const running = useRef(false);

  async function sendOnce() {
    if (!getToken()) return;
    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await pushLocation(loc.coords.latitude, loc.coords.longitude);
    } catch {
      /* ignore transient GPS errors */
    }
  }

  async function startForeground() {
    const perm = await Location.getForegroundPermissionsAsync();
    granted.current = perm.granted;
    if (!perm.granted) return;

    // immediate fix so the map jumps to the real position right away
    await sendOnce();

    watcher.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 6_000,
        distanceInterval: 15,
      },
      (loc) => pushLocation(loc.coords.latitude, loc.coords.longitude),
    );
  }

  function stopForeground() {
    watcher.current?.remove();
    watcher.current = null;
  }

  useEffect(() => {
    let mounted = true;

    if (!enabled) {
      // Off shift (or status not yet known) — make sure nothing is running.
      // This is what actually stops the OS from ever waking the app for a
      // location event once a tech goes Offline, instead of just relying on
      // sign-out (which most techs rarely do — they stay logged in for days).
      if (running.current) {
        stopForeground();
        stopBackgroundUpdates();
        running.current = false;
      }
      if (keepaliveTimer.current) {
        clearInterval(keepaliveTimer.current);
        keepaliveTimer.current = null;
      }
      return () => {
        mounted = false;
      };
    }

    running.current = true;

    // ── Immediate online signal ──────────────────────────────────────────────
    pingOnline();

    // ── Keepalive: re-ping every 90s even if GPS is stale/denied ────────────
    // Ensures locationUpdatedAt stays fresh within the 3-minute liveness window.
    keepaliveTimer.current = setInterval(() => {
      if (getToken()) pingOnline();
    }, 90_000);

    (async () => {
      // Kick off background updates first (handles the locked-phone case),
      // then layer the tighter foreground watcher on top — but only if the
      // app is actually in the foreground right now. Without this check, a
      // headless background relaunch (iOS waking the app purely to deliver a
      // location event while UIBackgroundModes:["location"] is active) would
      // start the foreground watcher too, running it redundantly alongside
      // the background task for as long as the process stays alive.
      const ok = await startBackgroundUpdates();
      if (!mounted) return;
      granted.current = ok;
      if (AppState.currentState === "active") {
        await startForeground();
      }
    })();

    // Foreground watcher vs. background task, on AppState change:
    //  - going to background/inactive: stop the tighter foreground watcher.
    //    The native background task (started above) is what's designed to
    //    keep reporting location while backgrounded/locked — running BOTH
    //    simultaneously is redundant work (extra GPS callbacks + network
    //    calls) that keeps the backgrounded process busier than it needs to
    //    be, for no benefit, while the app is already living on borrowed
    //    background execution time from the OS.
    //  - returning to foreground: restart the tighter watcher and force an
    //    immediate fresh fix + online signal.
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active") {
        pingOnline();
        if (granted.current && !watcher.current) {
          lastSent = 0; // force an immediate GPS send too
          sendOnce();
          Location.watchPositionAsync(
            { accuracy: Location.Accuracy.High, timeInterval: 6_000, distanceInterval: 15 },
            (loc) => pushLocation(loc.coords.latitude, loc.coords.longitude),
          ).then((w) => { watcher.current = w; });
        }
      } else {
        stopForeground();
      }
    });

    return () => {
      mounted = false;
      stopForeground();
      if (keepaliveTimer.current) clearInterval(keepaliveTimer.current);
      sub.remove();
      // NOTE: background native updates are intentionally left running across
      // this effect's own cleanup (e.g. component re-render) — they are only
      // ever stopped by the `enabled === false` branch above (shift toggled
      // off) or by stopLocationSharing() on sign-out.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

/** Stop all location sharing — call on logout or when the tech goes offline. */
export async function stopLocationSharing() {
  await stopBackgroundUpdates();
}
