/**
 * Which company am I acting as right now?
 *
 * Two kinds of people switch companies:
 *  - a superadmin, who can act as ANY tenant (operator tooling), and
 *  - an ordinary person who genuinely works for several companies (a contract
 *    technician on both Acme's and Bolt's roster).
 *
 * Both use the same mechanism: the active company id is persisted in
 * localStorage and injected as the `X-Company-Id` header by the api client
 * (lib/api.ts). The server re-validates it on EVERY request — a superadmin
 * against the companies allow-list, everyone else against their actual
 * memberships — so this value is a convenience, never a grant of access.
 */
const KEY = "active_company";

export function activeCompany(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}

/**
 * Switch into a company and reload.
 *
 * Always stores the id explicitly, including "default". The old version deleted
 * the key for "default" and let the server fall back to the user's home
 * company, which silently broke for anyone whose home company was NOT default —
 * picking "NVC 360" would land them back wherever they started.
 */
export function switchCompany(id: string | null) {
  if (typeof localStorage === "undefined") return;
  if (!id) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, id);
  // Hard reload so every cached query re-fetches under the new tenant header.
  window.location.reload();
}

/** Forget the acting company (used on sign-out so the next person starts clean). */
export function clearActiveCompany() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}
