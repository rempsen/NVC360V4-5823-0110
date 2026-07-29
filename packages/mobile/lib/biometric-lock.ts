import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

/**
 * Biometric app-lock (Face ID / Touch ID / Android fingerprint).
 *
 * Policy (per product decision): prompt once per calendar day, then trust
 * the device until the driver signs out. On by default whenever the device
 * actually supports it (hardware present AND the driver has enrolled a
 * face/fingerprint) — a device with neither never sees the toggle or the
 * prompt, so this can never block sign-in for a driver without biometrics
 * set up. Drivers can turn it off in Profile.
 */
const PREF_KEY = "biometric_lock_enabled";
const LAST_UNLOCK_KEY = "biometric_last_unlock_date"; // "YYYY-MM-DD"

async function getItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

async function setItem(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* best-effort */
    }
  }
}

async function deleteItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* best-effort */
    }
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Hardware present AND the driver has actually enrolled a face/fingerprint. */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}

/** Driver's own on/off preference. Defaults to "on" (caller should also gate on isBiometricAvailable()). */
export async function getLockPreference(): Promise<boolean> {
  const v = await getItem(PREF_KEY);
  return v !== "0"; // unset or "1" -> on; explicit "0" -> off
}

export async function setLockPreference(enabled: boolean): Promise<void> {
  await setItem(PREF_KEY, enabled ? "1" : "0");
}

async function getLastUnlockDate(): Promise<string | null> {
  return getItem(LAST_UNLOCK_KEY);
}

export async function markUnlockedNow(): Promise<void> {
  await setItem(LAST_UNLOCK_KEY, todayStr());
}

/** Call on sign-out so a fresh sign-in on this device always re-prompts once. */
export async function clearUnlockStamp(): Promise<void> {
  await deleteItem(LAST_UNLOCK_KEY);
}

/**
 * Should we show the biometric prompt right now? True only if the device
 * supports it, the driver hasn't disabled it, and they haven't already
 * unlocked today.
 */
export async function shouldPromptBiometric(): Promise<boolean> {
  const [available, enabled, lastUnlock] = await Promise.all([
    isBiometricAvailable(),
    getLockPreference(),
    getLastUnlockDate(),
  ]);
  if (!available || !enabled) return false;
  return lastUnlock !== todayStr();
}

export { LocalAuthentication };
