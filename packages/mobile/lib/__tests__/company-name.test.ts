import { describe, expect, test } from "bun:test";
import { dispatchLabels, resolveActiveCompanyName, type MyCompanies } from "../company-name";

/**
 * A driver on two rosters had to ask, in the app, "is this BMD or NVC360
 * office?" — the Dispatch screen never said which employer was messaging.
 * These cases pin down how the app decides which name to show, including the
 * cases where the client and the server disagree about who is active.
 */

const bmd = { id: "co_bmd", name: "BMD Materials", role: "tech" };
const nvc = { id: "co_nvc", name: "NVC360", role: "tech" };

function data(partial: Partial<MyCompanies>): MyCompanies {
  return { companies: [], ...partial };
}

describe("resolveActiveCompanyName", () => {
  test("names the company the client is acting as", () => {
    expect(
      resolveActiveCompanyName("co_bmd", data({ companies: [bmd, nvc] })),
    ).toBe("BMD Materials");
    expect(
      resolveActiveCompanyName("co_nvc", data({ companies: [bmd, nvc] })),
    ).toBe("NVC360");
  });

  test("single-roster driver never picks a company, so use their only one", () => {
    // pick-company.tsx auto-forwards a one-company driver, which leaves the
    // stored id empty and the header with nothing to resolve.
    expect(resolveActiveCompanyName("", data({ companies: [bmd] }))).toBe(
      "BMD Materials",
    );
  });

  test("falls back to the company the SERVER says is active", () => {
    // No local id but several rosters: the backend already resolved one for
    // this request, and that is whose data is on screen.
    expect(
      resolveActiveCompanyName(
        "",
        data({ activeCompanyId: "co_nvc", companies: [bmd, nvc] }),
      ),
    ).toBe("NVC360");
  });

  test("a local id always wins over the server's fallback", () => {
    // Guessing wrong here is the "Profile says NVC360 but I see BMD data" bug:
    // requests carry the local id, so the header must match the local id.
    expect(
      resolveActiveCompanyName(
        "co_bmd",
        data({ activeCompanyId: "co_nvc", companies: [bmd, nvc] }),
      ),
    ).toBe("BMD Materials");
  });

  test("shows nothing rather than a wrong or ugly name", () => {
    expect(resolveActiveCompanyName("", undefined)).toBe("");
    expect(resolveActiveCompanyName("", data({ companies: [] }))).toBe("");
    // Ambiguous: two rosters, nobody says which. Better silent than wrong.
    expect(resolveActiveCompanyName("", data({ companies: [bmd, nvc] }))).toBe("");
    // Stale id (membership revoked) must not fall through to another company.
    expect(
      resolveActiveCompanyName("co_gone", data({ companies: [bmd, nvc] })),
    ).toBe("");
    // Same, but the server DID name an active company. Requests still carry
    // the stale local id, so naming the server's company would put the wrong
    // employer on a thread whose contents came from nowhere.
    expect(
      resolveActiveCompanyName(
        "co_gone",
        data({ activeCompanyId: "co_nvc", companies: [bmd, nvc] }),
      ),
    ).toBe("");
    // me.ts falls back to the id as the name when the row is missing; an id is
    // not a name a driver can read.
    expect(
      resolveActiveCompanyName("co_bmd", data({ companies: [{ ...bmd, name: "co_bmd" }] })),
    ).toBe("");
    expect(
      resolveActiveCompanyName("co_bmd", data({ companies: [{ ...bmd, name: "  " }] })),
    ).toBe("");
  });
});

describe("dispatchLabels", () => {
  test("names the company everywhere once it is known", () => {
    const l = dispatchLabels("BMD Materials");
    expect(l.title).toBe("BMD Materials dispatch");
    expect(l.senderFallback).toBe("BMD Materials dispatch");
    expect(l.emptyTarget).toBe("BMD Materials's dispatcher");
    expect(l.placeholder).toBe("Message BMD Materials dispatch…");
    expect(l.inputLabel).toBe("Message to BMD Materials dispatch");
  });

  test("unknown company degrades to the old neutral wording", () => {
    // Never "undefined dispatch" or a dangling "'s dispatcher".
    for (const blank of ["", "   "]) {
      const l = dispatchLabels(blank);
      expect(l.title).toBe("Dispatch");
      expect(l.senderFallback).toBe("Dispatch");
      expect(l.emptyTarget).toBe("dispatch");
      expect(l.placeholder).toBe("Message dispatch…");
      expect(l.inputLabel).toBe("Message to dispatch");
      expect(Object.values(l).join(" ")).not.toContain("undefined");
    }
  });
});
