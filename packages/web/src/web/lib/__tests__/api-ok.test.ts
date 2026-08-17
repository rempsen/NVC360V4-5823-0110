import { describe, expect, it } from "bun:test";
import { ok, type SuccessOf } from "../api-ok";

/** Compile-time assertion helpers. */
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const typeAssert = <_T extends true>() => {};

describe("SuccessOf", () => {
  it("drops the exact error envelope from a union", () => {
    typeAssert<Eq<SuccessOf<{ message: string } | { bookings: number[] }>, { bookings: number[] }>>();
  });

  it("keeps a success body that merely contains a message field", () => {
    type Body = { message: string; id: string };
    typeAssert<Eq<SuccessOf<{ message: string } | Body>, Body>>();
  });

  it("leaves a union with no error branch untouched", () => {
    typeAssert<Eq<SuccessOf<{ a: 1 } | { b: 2 }>, { a: 1 } | { b: 2 }>>();
  });

  it("collapses to never when the only branch is the error envelope", () => {
    typeAssert<Eq<SuccessOf<{ message: string }>, never>>();
  });
});

describe("ok()", () => {
  it("returns the parsed json body", async () => {
    const res = { json: async (): Promise<{ message: string } | { n: 1 }> => ({ n: 1 }) };
    const body = await ok(res);
    typeAssert<Eq<typeof body, { n: 1 }>>();
    expect(body).toEqual({ n: 1 });
  });

  it("propagates a json parse rejection instead of swallowing it", async () => {
    const res = { json: async () => { throw new Error("bad json"); } };
    await expect(ok(res)).rejects.toThrow("bad json");
  });
});

describe("ok() over a response union", () => {
  it("collects every status' body before dropping the error branch", async () => {
    // Mirrors the hono client's shape: one response member per status code.
    type Res =
      | { status: 401; json(): Promise<{ message: string }> }
      | { status: 200; json(): Promise<{ bookings: number[] }> };
    const res = { status: 200, json: async () => ({ bookings: [1] }) } as unknown as Res;
    const body = await ok(res);
    typeAssert<Eq<typeof body, { bookings: number[] }>>();
    expect(body.bookings).toEqual([1]);
  });
});
