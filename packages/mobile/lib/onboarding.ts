import * as SecureStore from "expo-secure-store";

const KEY = "onboarding_seen_v1";

/** Has this device already seen the permissions-primer screen? */
export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(KEY)) === "1";
  } catch {
    // SecureStore isn't available on web / storage read failed — fail open
    // so onboarding never blocks sign-in.
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return true;
    }
  }
}

export async function markOnboardingSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, "1");
  } catch {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* best-effort */
    }
  }
}
