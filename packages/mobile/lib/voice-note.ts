/**
 * Voice notes for techs — dictate instead of typing with gloves on.
 *
 * `expo-audio` is a native module, so it only exists in binaries built after
 * it was added to package.json. We therefore load it lazily inside a try/catch
 * and expose `isVoiceNoteSupported()`; the UI hides the record button on older
 * binaries instead of crashing them. Once the next TestFlight/production build
 * ships, the button appears with no further code change.
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

export function isVoiceNoteSupported(): boolean {
  const m = load();
  return !!(m && (m.AudioModule || m.setAudioModeAsync));
}

export type Recording = {
  stop: () => Promise<{ uri: string; durationSecs: number } | null>;
};

/**
 * Starts recording. Returns null if unsupported or permission was denied —
 * callers should surface a friendly message, never assume success.
 */
export async function startVoiceNote(): Promise<Recording | null> {
  const m = load();
  if (!m) return null;
  try {
    const perm = await m.requestRecordingPermissionsAsync?.();
    if (perm && perm.granted === false) return null;
    await m.setAudioModeAsync?.({ allowsRecording: true, playsInSilentMode: true });

    const rec = new m.AudioRecorder(m.RecordingPresets?.HIGH_QUALITY ?? {});
    await rec.prepareToRecordAsync();
    rec.record();
    const startedAt = Date.now();

    return {
      stop: async () => {
        try {
          await rec.stop();
          const uri = rec.uri as string | null;
          if (!uri) return null;
          return { uri, durationSecs: Math.round((Date.now() - startedAt) / 1000) };
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
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
