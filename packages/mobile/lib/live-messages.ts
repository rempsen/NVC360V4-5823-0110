import { useEffect, useRef } from "react";
import EventSource from "react-native-sse";
import Constants from "expo-constants";
import { getToken } from "./auth";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

/**
 * Live "go refetch" signal for a message thread, replacing 5-8s polling with
 * an instant push via the backend's SSE stream (see
 * packages/web/src/api/routes/messages.ts /direct/stream and
 * /:bookingId/stream). The stream only ever carries a bare "new-message"
 * signal, never the message payload itself — `onSignal` is expected to
 * invalidate the relevant react-query key, which re-runs the existing GET
 * that already fetches/shapes the real data. This keeps the mobile change
 * additive and low-risk: if the stream ever misbehaves, the caller's
 * existing (now much longer, safety-net) refetchInterval still covers it.
 *
 * plain `EventSource` (the browser/web one used by track-public.tsx) can't
 * set a custom Authorization header, which every one of our endpoints
 * requires — hence react-native-sse, which uses XMLHttpRequest under the
 * hood and does support custom headers, plus built-in auto-reconnect.
 *
 * No-ops safely if `path` is falsy (e.g. still waiting on an id) or if
 * there's no auth token yet.
 */
export function useLiveMessageSignal(path: string | null | undefined, onSignal: () => void) {
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;

  useEffect(() => {
    if (!path) return;
    const token = getToken();
    if (!token) return;

    const es = new EventSource<"new-message" | "ping">(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      debug: false,
    });
    es.addEventListener("new-message", () => onSignalRef.current());
    // "ping"/"open"/"error" intentionally unhandled — the library's own
    // reconnect (default 5s backoff) covers drops; the caller's safety-net
    // polling interval covers anything this stream misses entirely.

    return () => es.close();
  }, [path]);
}
