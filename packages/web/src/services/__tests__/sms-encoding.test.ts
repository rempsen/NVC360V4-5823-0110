/**
 * SMS segment cost: one em dash was tripling the bill.
 *
 * GSM-7 fits 160 characters in a single segment. The moment ONE character in
 * the body falls outside GSM-7, Twilio must encode the whole message as UCS-2
 * and the limit collapses to 70 (67 per part when concatenated). Measured
 * across the default copy on 2026-08-16: 17 of the built-in messages contained
 * "—" (U+2014) and one contained "·" (U+00B7). Nothing else. That alone pushed
 * routine 145-character notices — the running-late notice, the completion
 * notice, the change-request notices — from 1 segment to 3.
 *
 * Both characters have lossless ASCII equivalents, so this is pure margin.
 * Normalising at the send boundary (rather than in the template strings) also
 * covers tenant-authored templates and tenant company names, which are the
 * other two places this text comes from.
 *
 * Emoji and real accented letters are deliberately left alone: there is no
 * lossless substitute, and silently mangling a customer's name would be worse
 * than paying for the segment.
 */
import { describe, it, expect } from "bun:test";
import { toGsm7, smsSegments } from "../sms";

describe("toGsm7 — swap non-GSM punctuation for its ASCII equivalent", () => {
  it("replaces the em dash and en dash with a hyphen", () => {
    expect(toGsm7("Furnace Tune-Up — 20 min late")).toBe("Furnace Tune-Up - 20 min late");
    expect(toGsm7("9–11 AM")).toBe("9-11 AM");
  });

  it("replaces the middle dot and bullet with a pipe separator", () => {
    expect(toGsm7("record · history")).toBe("record | history");
    expect(toGsm7("a • b")).toBe("a | b");
  });

  it("straightens curly quotes and apostrophes", () => {
    expect(toGsm7("we’re running late")).toBe("we're running late");
    expect(toGsm7("“on the way”")).toBe('"on the way"');
  });

  it("expands an ellipsis and normalises exotic spaces", () => {
    expect(toGsm7("hold on…")).toBe("hold on...");
    expect(toGsm7("2:30 PM")).toBe("2:30 PM");
    expect(toGsm7("2:30 PM")).toBe("2:30 PM");
  });

  it("leaves GSM-7 text completely untouched", () => {
    const s = "BMD Materials: Jordan is on the way! ETA ~20 min. Track: https://x.co/t/a1 (£5 @ 50%)";
    expect(toGsm7(s)).toBe(s);
  });

  it("does not mangle emoji or accented names — no lossless swap exists", () => {
    expect(toGsm7("Job done 🎉")).toBe("Job done 🎉");
    expect(toGsm7("Renée Gagné")).toBe("Renée Gagné");
  });

  it("survives an empty or nullish body", () => {
    expect(toGsm7("")).toBe("");
    expect(toGsm7(undefined as unknown as string)).toBe("");
  });
});

describe("smsSegments — what a body actually costs", () => {
  it("counts one segment for up to 160 GSM characters", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
  });

  it("counts extended GSM characters as two, like the carrier does", () => {
    // { } [ ] ~ ^ | \ € each take two GSM-7 septets.
    expect(smsSegments("{".repeat(80))).toBe(1);
    expect(smsSegments("{".repeat(81))).toBe(2);
  });

  it("collapses to a 70-character segment as soon as one character is not GSM", () => {
    expect(smsSegments("a".repeat(70))).toBe(1);
    expect(smsSegments("a".repeat(69) + "🎉")).toBe(2);
  });

  it("shows the win: the change-request notice drops from 3 segments to 1", () => {
    // Verbatim default copy at 145 characters. Under 160 GSM-7 septets, so it
    // should always have been a single segment; the em dash made it three.
    const msg =
      "BMD Materials: We've got your request for the Furnace Tune-Up appointment on " +
      "Jun 4, 2:30 PM. The office will confirm shortly — nothing has changed yet.";
    expect(msg.length).toBeLessThanOrEqual(160);
    expect(smsSegments(msg)).toBe(3);
    expect(smsSegments(toGsm7(msg))).toBe(1);
  });

  it("still helps the long notices, which drop from 3 segments to 2", () => {
    // The running-late notice is genuinely 193 characters, so it cannot fit one
    // segment — but GSM-7 gets it to two instead of three.
    const late =
      "BMD Materials: Update on your Furnace Tune-Up — we're running about 20 minutes " +
      "behind, so Jordan Lee should reach you closer to 2:50 PM. Sorry to hold you up. " +
      "Live status: https://nvc360.app/t/abc123";
    expect(smsSegments(late)).toBe(3);
    expect(smsSegments(toGsm7(late))).toBe(2);
  });
});
