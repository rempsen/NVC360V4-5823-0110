import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Which company is this driver working for right now?
 *
 * A contract technician can be on more than one company's roster (the same
 * person on both Acme's and Bolt's books). The backend decides what they can
 * see from the `X-Company-Id` header on every single request — it is never
 * stored as server-side session state, so a revoked membership takes effect
 * immediately (see packages/web/src/api/middleware/auth.ts).
 *
 * That makes this value the single most important piece of client state in the
 * app: if it is wrong or missing, the driver sees another company's jobs, or
 * silently falls back to their home company. So it is read SYNCHRONOUSLY.
 *
 * Why synchronous matters: `lib/api.ts`'s header callback and every raw
 * `fetch()` header object are sync functions. If reading the company were
 * async, those call sites would have to send the request without the header
 * and hope it resolved in time — a race that would show up as the wrong
 * company's data on a cold start. `SecureStore.getItem` (no `Async`) is the
 * sync Keychain read, the same one `getToken()` already relies on.
 *
 * An empty string means "not chosen yet" and the header is omitted entirely,
 * which makes the backend fall back to the driver's home company. That is the
 * correct default for a single-company driver who never sees a picker.
 */
const KEY = "active_company_id";
const isWeb = Platform.OS === "web";

/** Sync read — safe to call from a fetch header builder. Never throws. */
export function getActiveCompany(): string {
  try {
    return SecureStore.getItem(KEY) ?? "";
  } catch {
    // Keychain reads CAN throw on a locked device (same failure mode that
    // caused the background-location crash documented in lib/auth.ts). Treat
    // it as "not chosen" rather than letting it escalate — and NEVER touch
    // `localStorage` on native, where the global doesn't exist at all.
    if (isWeb) {
      try {
        return localStorage.getItem(KEY) ?? "";
      } catch {
        return "";
      }
    }
    return "";
  }
}

/**
 * Write the active company — and VERIFY it landed, throwing if it didn't.
 *
 * This used to swallow every failure. Because the caller (the company switcher
 * in app/(rider)/profile.tsx) sets its local UI state on success, a Keychain
 * write that silently failed left the app *claiming* to be on company B while
 * every request still carried company A's id — the exact "Profile says NVC 360
 * but I'm seeing BMD Materials data" mismatch Dan hit. A switch that can't be
 * persisted has to surface, so the mutation's onError Alert fires and the tech
 * knows to retry instead of trusting a lie.
 */
export async function setActiveCompany(companyId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, companyId);
  } catch (err) {
    if (isWeb) {
      // On web the Keychain shim can be unavailable; localStorage is the real
      // store there, so a successful fallback write is not a failure.
      localStorage.setItem(KEY, companyId);
    } else {
      throw err instanceof Error ? err : new Error("Could not save active company");
    }
  }
  // Read back through the same sync path the request headers use. If the store
  // accepted the write but headers would still send the old id, that is still
  // a failed switch as far as the driver is concerned.
  if (getActiveCompany() !== companyId) {
    throw new Error("Active company did not persist");
  }
}

/**
 * Call on sign-out. Leaving a stale company id behind would mean the next
 * person to sign in on a shared work phone starts out pointed at the previous
 * driver's company until they hit the picker.
 */
export async function clearActiveCompany(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    if (isWeb) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* best-effort */
      }
    }
  }
}

export type CompanyOption = {
  id: string;
  name: string;
  role: string;
  staffType?: string | null;
};
