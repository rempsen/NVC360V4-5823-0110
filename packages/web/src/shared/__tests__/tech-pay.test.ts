import { describe, it, expect } from "bun:test";
import { computeTechPay, type TechPayInput } from "../tech-pay";
import type { LineItem } from "../catalog";

const unitLine = (cost: number): LineItem =>
  ({ id: crypto.randomUUID(), kind: "unit", name: "Install", unit: "sqft", qty: 1, unitCost: cost, unitPrice: 0, taxable: true, cost, price: 0 }) as unknown as LineItem;

const catalogLine = (cost: number): LineItem =>
  ({ id: crypto.randomUUID(), kind: "product", name: "Filter", unit: "each", qty: 1, unitCost: cost, unitPrice: 0, taxable: true, cost, price: 0 }) as unknown as LineItem;

const base: TechPayInput = { onSiteMinutes: 0, payRatePerHour: 0, lineItems: [] };

describe("computeTechPay — hourly on-site time + per-unit pay", () => {
  it("pays the hourly rate for the time actually spent on site", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 90, payRatePerHour: 40 });
    expect(r.hours).toBe(1.5);
    expect(r.hourlyPay).toBe(60);
    expect(r.unitPay).toBe(0);
    expect(r.techPay).toBe(60);
  });

  it("adds per-unit line pay on top of the hourly pay", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 60, payRatePerHour: 30, lineItems: [unitLine(120)] });
    expect(r.hourlyPay).toBe(30);
    expect(r.unitPay).toBe(120);
    expect(r.techPay).toBe(150);
  });

  it("ignores catalog product cost — that is company COGS, not tech pay", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 60, payRatePerHour: 30, lineItems: [catalogLine(500), unitLine(20)] });
    expect(r.unitPay).toBe(20);
    expect(r.techPay).toBe(50);
  });

  it("rounds money to cents, never to a fraction of a cent", () => {
    // 50 min @ $37/h = 0.83h * 37 = 30.71 (0.8333.. rounded to 2dp first)
    const r = computeTechPay({ ...base, onSiteMinutes: 50, payRatePerHour: 37 });
    expect(r.hours).toBe(0.83);
    expect(r.hourlyPay).toBe(30.71);
  });

  it("flags a job as unrated when there is no hourly rate and no per-unit pay", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 120, payRatePerHour: 0 });
    expect(r.techPay).toBe(0);
    expect(r.unrated).toBe(true);
  });

  it("does not flag a job that is paid purely per unit with no hourly rate", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 0, payRatePerHour: 0, lineItems: [unitLine(200)] });
    expect(r.techPay).toBe(200);
    expect(r.unrated).toBe(false);
  });

  it("does not flag a rated tech who simply finished in zero recorded minutes", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: 0, payRatePerHour: 45 });
    expect(r.techPay).toBe(0);
    expect(r.unrated).toBe(false);
  });

  it("treats a garbage rate or garbage minutes as zero instead of producing NaN pay", () => {
    const r = computeTechPay({
      onSiteMinutes: Number("nonsense"),
      payRatePerHour: undefined as unknown as number,
      lineItems: [],
    });
    expect(Number.isNaN(r.techPay)).toBe(false);
    expect(r.techPay).toBe(0);
    expect(r.unrated).toBe(true);
  });

  it("never produces negative pay from a negative rate or negative minutes", () => {
    const r = computeTechPay({ ...base, onSiteMinutes: -60, payRatePerHour: -50, lineItems: [unitLine(-10)] });
    expect(r.hourlyPay).toBe(0);
    expect(r.unitPay).toBe(0);
    expect(r.techPay).toBe(0);
  });
});
