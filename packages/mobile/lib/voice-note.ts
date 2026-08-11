/**
 * Voice notes for techs — dictate instead of typing with gloves on.
 *
 * `expo-audio` is a native module, so it only exists in binaries built after
 * it was added to package.json. We therefore load it lazily inside a try/catch
 * and expose `isVoiceNoteSupported()`; the UI hides the record button on older
 * binaries instead of crashing them. Once the next TestFlight/production build
 * ships, the button appears with no further code change.
 *
 * Permissions: iOS only ever shows the system mic prompt once. So we ask the OS
 * what the current state is first, prompt only when it is still undetermined,
 * and report `"blocked"` when the driver said no earlier — the UI then sends
 * them to Settings instead of showing a dead-end alert. Every failure path
 * returns a *reason*, never a bare null, so the driver is told what to do.
 */
import { authHeaders } from "./auth";

let mod: any = null;
let tried = false;

function load(): any {
  if (tried) return mod;
  tried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("expo-audio");
  } catch {
    mod = null;
  }
  return mod;
}

/**
 * The recorder class is exported as `AudioModule.AudioRecorder`, NOT on the
 * package root. Reading it off the root gave `undefined`, and `new undefined()`
 * threw — which the old catch-all turned into a bogus "mic unavailable"
 * message on every attempt, even with permission already granted. Resolve it
 * from both places so either module shape works.
 */
function recorderClass(m: any): any {
  return m?.AudioModule?.AudioRecorder ?? m?.AudioRecorder ?? null;
}

/** Permission helpers also live in two places depending on module shape. */
function permFns(m: any): {
  get?: () => Promise<any>;
  request?: () => Promise<any>;
} {
  return {
    get: m?.getRecordingPermissionsAsync ?? m?.AudioModule?.getRecordingPermissionsAsync,
    request:
      m?.requestRecordingPermissionsAsync ?? m?.AudioModule?.requestRecordingPermissionsAsync,
  };
}

export function isVoiceNoteSupported(): boolean {
  const m = load();
  return !!(m && recorderClass(m));
}

export type Recording = {
  stop: () => Promise<{ uri: string; durationSecs: number } | null>;
};

export type StartResult =
  /** Recording is live. */
  | { ok: true; recording: Recording }
  /** This binary predates expo-audio — needs an app update, not a permission. */
  | { ok: false; reason: "unsupported" }
  /** Driver denied the mic earlier; iOS won't re-prompt, only Settings can fix it. */
  | { ok: false; reason: "blocked" }
  /** Driver tapped "Don't Allow" on the prompt we just showed. */
  | { ok: false; reason: "denied" }
  /** Something else went wrong; `error` is for the alert body. */
  | { ok: false; reason: "error"; error: string };

/**
 * Requests mic permission (prompting the OS if it has never been asked) and
 * starts recording. Callers must branch on `reason` — "blocked" needs a
 * deep-link to Settings, the others just need a message.
 */
export async function startVoiceNote(): Promise<StartResult> {
  const m = load();
  const Recorder = recorderClass(m);
  if (!m || !Recorder) return { ok: false, reason: "unsupported" };

  // 1. Ask the OS where we stand before prompting, so a driver who already
  //    granted access never sees a second dialog and a driver who denied gets
  //    routed to Settings rather than silently failing.
  try {
    const { get, request } = permFns(m);
    let perm = get ? await get() : null;

    const needsPrompt = !perm || perm.granted !== true;
    if (needsPrompt) {
      // canAskAgain === false means iOS/Android will not show the dialog again.
      if (perm && perm.granted === false && perm.canAskAgain === false) {
        return { ok: false, reason: "blocked" };
      }
      if (!request) return { ok: false, reason: "blocked" };
      perm = await request(); // <- this is the native "Allow microphone access?" prompt
      if (perm?.granted !== true) {
        return {
          ok: false,
          reason: perm?.canAskAgain === false ? "blocked" : "denied",
        };
      }
    }
  } catch (e: any) {
    return { ok: false, reason: "error", error: e?.message || "Couldn't check microphone access" };
  }

  // 2. Permission is granted — now configure the session and record.
  try {
    const setMode = m.setAudioModeAsync ?? m.AudioModule?.setAudioModeAsync;
    await setMode?.({ allowsRecording: true, playsInSilentMode: true });

    const rec = new Recorder(m.RecordingPresets?.HIGH_QUALITY ?? {});
    await rec.prepareToRecordAsync();
    rec.record();
    const startedAt = Date.now();

    return {
      ok: true,
      recording: {
        stop: async () => {
          try {
            await rec.stop();
            const uri = rec.uri as string | null;
            if (!uri) return null;
            return { uri, durationSecs: Math.round((Date.now() - startedAt) / 1000) };
          } catch {
            return null;
          } finally {
            // Hand the audio session back so navigation sounds/playback work.
            try {
              await setMode?.({ allowsRecording: false, playsInSilentMode: false });
            } catch {}
          }
        },
      },
    };
  } catch (e: any) {
    return { ok: false, reason: "error", error: e?.message || "Couldn't start recording" };
  }
}

/** Uploads a recorded file to the job. Server transcribes best-effort. */
export async function uploadVoiceNote(opts: {
  api: string;
  token: string;
  bookingId: string;
  uri: string;
  durationSecs: number;
}): Promise<{ ok: boolean; transcript?: string; error?: string }> {
  try {
    const form = new FormData();
    form.append("file", {
      uri: opts.uri,
      name: `voice-note-${Date.now()}.m4a`,
      type: "audio/m4a",
    } as any);
    form.append("durationSecs", String(opts.durationSecs));
    const res = await fetch(`${opts.api}/api/bookings/${opts.bookingId}/voice-note`, {
      method: "POST",
      // opts.token is passed in by the caller, but the company header must
      // still come from the shared builder or a voice note uploads against the
      // driver's home company instead of the one they are working for today.
      headers: authHeaders({ Authorization: `Bearer ${opts.token}` }),
      body: form,
    });
    if (!res.ok) return { ok: false, error: `Upload failed (${res.status})` };
    const json = (await res.json()) as { transcript?: string };
    return { ok: true, transcript: json?.transcript || "" };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Upload failed" };
  }
}
