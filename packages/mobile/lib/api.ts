import { hc } from "hono/client";
import Constants from "expo-constants";
import type { AppType } from "@template/web";
import { authHeaders } from "./auth";

const baseUrl =
  (Constants.expoConfig?.extra?.apiUrl as string) ??
  process.env.EXPO_PUBLIC_API_URL;

const client = hc<AppType>(baseUrl!, {
  // Evaluated per request (not once at module load), so switching company in
  // Profile takes effect on the very next call without an app restart.
  headers: (): Record<string, string> => authHeaders(),
});

export const api = client.api;
