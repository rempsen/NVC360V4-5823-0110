import type { CompanyOption } from "./active-company";

/**
 * "Whose dispatcher am I talking to?"
 *
 * A contract technician can be on two rosters, and every screen in the app is
 * scoped to whichever one they picked. Dispatch messages were the one place
 * that never said the company out loud, so a driver on both BMD Materials' and
 * NVC360's books literally had to type "Hi is this BMD or NVC360 office?" into
 * the thread to find out who had messaged him.
 *
 * The name resolution lives here, separate from both the screens and the
 * data-fetching hook, because the answer has to be identical everywhere it
 * appears — a header that disagrees with the Profile switcher is worse than no
 * header at all. Keeping this file free of react-native/expo imports (the type
 * import above is erased at build time) is also what makes it unit-testable
 * with `bun test`, which cannot load React Native's Flow-typed entry point.
 */

/** Exactly what `GET /api/me/companies` returns (see api/routes/me.ts). */
export type MyCompanies = {
  activeCompanyId?: string;
  superadmin?: boolean;
  companies: CompanyOption[];
};

/**
 * Resolve the display name for the company the app is acting as right now.
 *
 * Returns "" — show nothing — whenever the answer is not certain. Silence is
 * recoverable (the driver can check Profile); a wrong employer name on a
 * dispatch thread is not, because it would have the tech answering questions
 * for the wrong company.
 *
 * Order matters:
 *  1. The locally stored id, because THAT is the `X-Company-Id` every request
 *     carries — it decides what's on screen, so the header must agree with it.
 *  2. The server's resolved `activeCompanyId`, for a cold start where nothing
 *     has been stored yet and the backend fell back to a home company.
 *  3. A single-roster driver, who never sees the picker and so never stores an
 *     id at all.
 */
export function resolveActiveCompanyName(
  localId: string,
  data: MyCompanies | undefined | null,
): string {
  const list = data?.companies ?? [];
  if (list.length === 0) return "";

  const pick = (id: string | undefined) =>
    id ? list.find((c) => c.id === id) : undefined;

  const chosen =
    pick(localId) ??
    // Only trust the server's fallback when the client hasn't stored a choice.
    // If a local id is set but matches nothing (membership revoked), naming a
    // different company would be a lie, so we deliberately resolve to nothing.
    (localId ? undefined : pick(data?.activeCompanyId)) ??
    (!localId && list.length === 1 ? list[0] : undefined);

  const name = chosen?.name?.trim() ?? "";
  // `me.ts` uses the company id as the name when the row is missing. An opaque
  // id in a header reads like a bug to a driver — treat it as unknown.
  if (!name || name === chosen?.id) return "";
  return name;
}

/**
 * Every piece of wording on the Dispatch screen that has to name the employer,
 * in one place.
 *
 * Same reasoning as `companyAlertText` in components/company-alert.tsx: the
 * strings a driver reads are product decisions, so they live in a pure,
 * testable function rather than inline in JSX. It also guarantees the header,
 * the message bubbles, and the composer can't end up disagreeing about which
 * company (or about whether the name is known at all).
 *
 * Pass "" for an unknown company and every string degrades to the neutral
 * wording the screen used before, never to "undefined dispatch".
 */
export function dispatchLabels(companyName: string) {
  const co = companyName.trim();
  return {
    /** Screen title. */
    title: co ? `${co} dispatch` : "Dispatch",
    /** Bubble author when the office didn't send a person's name. */
    senderFallback: co ? `${co} dispatch` : "Dispatch",
    /** Empty-thread nudge: "Message BMD Materials's dispatcher anytime". */
    emptyTarget: co ? `${co}'s dispatcher` : "dispatch",
    /** Composer placeholder. */
    placeholder: co ? `Message ${co} dispatch…` : "Message dispatch…",
    /** Composer screen-reader label. */
    inputLabel: co ? `Message to ${co} dispatch` : "Message to dispatch",
  };
}
