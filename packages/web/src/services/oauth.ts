/* ---------------------------------------------------------------------------
 * Generic OAuth2 framework for third-party integrations.
 * Credentials come from env: <PROVIDER>_CLIENT_ID / <PROVIDER>_CLIENT_SECRET.
 * e.g. GOOGLE_DRIVE_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, ...
 * ------------------------------------------------------------------------- */

export type ProviderId =
  | "quickbooks" | "xero" | "gmail" | "outlook" | "office365"
  | "google_calendar" | "companycam"
  | "google_drive" | "dropbox" | "onedrive";

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  category: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** env prefix → reads <PREFIX>_CLIENT_ID / <PREFIX>_CLIENT_SECRET */
  envPrefix: string;
  /** extra params appended to the authorize URL */
  extraAuthParams?: Record<string, string>;
  /** how to fetch a human label (email / company) after token exchange */
  accountInfo?: (tokens: TokenSet, raw: any) => Promise<{ label: string; externalId: string }>;
  /** whether token endpoint expects HTTP Basic auth for client creds */
  basicAuth?: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null; // epoch ms
  scope: string;
}

// Google family share one auth/token endpoint.
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

async function googleAccount(t: TokenSet): Promise<{ label: string; externalId: string }> {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${t.accessToken}` },
    });
    const j = await r.json();
    return { label: j.email ?? "Google account", externalId: j.id ?? "" };
  } catch {
    return { label: "Google account", externalId: "" };
  }
}

async function msAccount(t: TokenSet): Promise<{ label: string; externalId: string }> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${t.accessToken}` },
    });
    const j = await r.json();
    return { label: j.userPrincipalName ?? j.mail ?? "Microsoft account", externalId: j.id ?? "" };
  } catch {
    return { label: "Microsoft account", externalId: "" };
  }
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  quickbooks: {
    id: "quickbooks", name: "QuickBooks", category: "Accounting", envPrefix: "QUICKBOOKS",
    authUrl: "https://appcenter.intuit.com/connect/oauth2", tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: ["com.intuit.quickbooks.accounting", "openid", "email"], basicAuth: true,
    accountInfo: async (_t, raw) => ({ label: "QuickBooks Company", externalId: raw?.realmId ?? "" }),
  },
  xero: {
    id: "xero", name: "Xero", category: "Accounting", envPrefix: "XERO",
    authUrl: "https://login.xero.com/identity/connect/authorize", tokenUrl: "https://identity.xero.com/connect/token",
    scopes: ["openid", "email", "accounting.transactions", "offline_access"], basicAuth: true,
    accountInfo: async (_t) => ({ label: "Xero Organisation", externalId: "" }),
  },
  gmail: {
    id: "gmail", name: "Gmail", category: "Email", envPrefix: "GOOGLE",
    authUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ["https://www.googleapis.com/auth/gmail.send", "openid", "email"],
    extraAuthParams: { access_type: "offline", prompt: "consent" }, accountInfo: googleAccount,
  },
  google_calendar: {
    id: "google_calendar", name: "Google Calendar", category: "Calendar", envPrefix: "GOOGLE",
    authUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ["https://www.googleapis.com/auth/calendar.events", "openid", "email"],
    extraAuthParams: { access_type: "offline", prompt: "consent" }, accountInfo: googleAccount,
  },
  google_drive: {
    id: "google_drive", name: "Google Drive", category: "File Storage", envPrefix: "GOOGLE",
    authUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ["https://www.googleapis.com/auth/drive.file", "openid", "email"],
    extraAuthParams: { access_type: "offline", prompt: "consent" }, accountInfo: googleAccount,
  },
  outlook: {
    id: "outlook", name: "Outlook", category: "Email", envPrefix: "MICROSOFT",
    authUrl: MS_AUTH, tokenUrl: MS_TOKEN,
    scopes: ["offline_access", "Mail.Send", "User.Read"], accountInfo: msAccount,
  },
  office365: {
    id: "office365", name: "Microsoft 365", category: "Productivity", envPrefix: "MICROSOFT",
    authUrl: MS_AUTH, tokenUrl: MS_TOKEN,
    scopes: ["offline_access", "User.Read", "Calendars.ReadWrite", "Mail.Send"], accountInfo: msAccount,
  },
  onedrive: {
    id: "onedrive", name: "OneDrive", category: "File Storage", envPrefix: "MICROSOFT",
    authUrl: MS_AUTH, tokenUrl: MS_TOKEN,
    scopes: ["offline_access", "Files.ReadWrite", "User.Read"], accountInfo: msAccount,
  },
  dropbox: {
    id: "dropbox", name: "Dropbox", category: "File Storage", envPrefix: "DROPBOX",
    authUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: ["files.content.write", "files.content.read", "account_info.read"],
    extraAuthParams: { token_access_type: "offline" },
    accountInfo: async (t) => {
      try {
        const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
          method: "POST", headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" }, body: "null",
        });
        const j = await r.json();
        return { label: j?.email ?? "Dropbox account", externalId: j?.account_id ?? "" };
      } catch { return { label: "Dropbox account", externalId: "" }; }
    },
  },
  companycam: {
    id: "companycam", name: "CompanyCam", category: "Photos", envPrefix: "COMPANYCAM",
    authUrl: "https://app.companycam.com/oauth/authorize", tokenUrl: "https://app.companycam.com/oauth/token",
    scopes: ["read", "write"], accountInfo: async () => ({ label: "CompanyCam", externalId: "" }),
  },
};

/* ---------------------------------------------------------------------------
 * Credential resolution.
 * Priority: DB (oauth_app_credentials, set by superadmin in the UI) → env vars.
 * DB-first lets the platform owner paste keys once in the UI and go live with
 * NO server restart. A tiny cache keeps the hot path (authorize/exchange) cheap.
 * ------------------------------------------------------------------------- */
import { db } from "../api/database";
import { oauthAppCredentials } from "../api/database/schema";

let _credCache: { at: number; map: Record<string, { clientId: string; clientSecret: string; enabled: boolean }> } | null = null;
export function invalidateCredentialCache() { _credCache = null; }

async function loadDbCredentials() {
  if (_credCache && Date.now() - _credCache.at < 5_000) return _credCache.map;
  const map: Record<string, { clientId: string; clientSecret: string; enabled: boolean }> = {};
  try {
    const rows = await db.select().from(oauthAppCredentials);
    for (const r of rows) {
      map[r.provider] = { clientId: r.clientId, clientSecret: r.clientSecret, enabled: r.enabled };
    }
  } catch { /* table may not exist yet */ }
  _credCache = { at: Date.now(), map };
  return map;
}

function envCredentials(p: ProviderConfig): { clientId: string; clientSecret: string } | null {
  const id = process.env[`${p.envPrefix}_CLIENT_ID`];
  const secret = process.env[`${p.envPrefix}_CLIENT_SECRET`];
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret };
}

/** Resolve credentials for a provider: DB first (if enabled), then env. */
export async function getCredentials(p: ProviderConfig): Promise<{ clientId: string; clientSecret: string } | null> {
  const map = await loadDbCredentials();
  const fromDb = map[p.id];
  if (fromDb && fromDb.enabled && fromDb.clientId && fromDb.clientSecret) {
    return { clientId: fromDb.clientId, clientSecret: fromDb.clientSecret };
  }
  return envCredentials(p);
}

export async function hasCredentials(provider: ProviderId): Promise<boolean> {
  const cfg = PROVIDERS[provider];
  return cfg ? !!(await getCredentials(cfg)) : false;
}

/** Where a provider's credentials come from (for the owner UI). */
export async function credentialSource(provider: ProviderId): Promise<"db" | "env" | "none"> {
  const cfg = PROVIDERS[provider];
  if (!cfg) return "none";
  const map = await loadDbCredentials();
  const fromDb = map[provider];
  if (fromDb && fromDb.enabled && fromDb.clientId && fromDb.clientSecret) return "db";
  if (envCredentials(cfg)) return "env";
  return "none";
}

export function redirectUri(provider: ProviderId): string {
  const base = (process.env.APP_URL || process.env.PUBLIC_URL || "http://localhost:4200").replace(/\/$/, "");
  return `${base}/api/integrations/oauth/callback/${provider}`;
}

/** Build the provider's authorize URL. `state` carries our CSRF/session token. */
export async function buildAuthorizeUrl(provider: ProviderId, state: string): Promise<string | null> {
  const cfg = PROVIDERS[provider];
  const creds = await getCredentials(cfg);
  if (!creds) return null;
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    redirect_uri: redirectUri(provider),
    scope: cfg.scopes.join(" "),
    state,
    ...cfg.extraAuthParams,
  });
  return `${cfg.authUrl}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(provider: ProviderId, code: string): Promise<{ tokens: TokenSet; raw: any }> {
  const cfg = PROVIDERS[provider];
  const creds = await getCredentials(cfg);
  if (!creds) throw new Error("missing_credentials");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.basicAuth) {
    headers.Authorization = "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  } else {
    body.set("client_id", creds.clientId);
    body.set("client_secret", creds.clientSecret);
  }
  const r = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const raw = await r.json();
  if (!r.ok) throw new Error(raw.error_description || raw.error || "token_exchange_failed");
  return { tokens: normalizeTokens(raw), raw };
}

/** Refresh an access token using a stored refresh token. */
export async function refreshTokens(provider: ProviderId, refreshToken: string): Promise<TokenSet> {
  const cfg = PROVIDERS[provider];
  const creds = await getCredentials(cfg);
  if (!creds) throw new Error("missing_credentials");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.basicAuth) {
    headers.Authorization = "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  } else {
    body.set("client_id", creds.clientId);
    body.set("client_secret", creds.clientSecret);
  }
  const r = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const raw = await r.json();
  if (!r.ok) {
    // Prefer the OAuth error CODE (e.g. "invalid_grant") over error_description
    // — providers like Google sometimes send a useless generic description
    // ("Bad Request") alongside the actually-meaningful code. Callers (see
    // google-drive.ts freshAccessToken) pattern-match on the message to detect
    // "needs reconnect" vs other failures, so the code must always be present.
    const code = raw.error || "refresh_failed";
    const desc = raw.error_description && raw.error_description !== "Bad Request" ? `: ${raw.error_description}` : "";
    throw new Error(`${code}${desc}`);
  }
  const t = normalizeTokens(raw);
  if (!t.refreshToken) t.refreshToken = refreshToken; // some providers omit on refresh
  return t;
}

function normalizeTokens(raw: any): TokenSet {
  const expiresIn = Number(raw.expires_in || 0);
  return {
    accessToken: raw.access_token ?? "",
    refreshToken: raw.refresh_token ?? "",
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    scope: raw.scope ?? "",
  };
}
