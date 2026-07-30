import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tenantId } from "../middleware/auth";
import { tdb, type TenantDb } from "../database/tenant";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/* ------------------------------- CSV -------------------------------- */
export function toCsv(rows: Record<string, any>[], columns?: string[]): string {
  if (!rows.length) return columns?.length ? columns.join(",") + "\n" : "";
  const cols = columns?.length ? columns : Object.keys(rows[0]);
  const esc = (v: any) => {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return head + "\n" + body;
}

/* ------------------------------ XLSX -------------------------------- */
export async function toXlsx(
  rows: Record<string, any>[],
  columns: { key: string; label: string; kind?: string }[],
  sheetName = "Report",
  title?: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NVC360";
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Report");

  // column widths
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(12, c.label.length + 4); });

  if (title) {
    ws.mergeCells(1, 1, 1, Math.max(columns.length, 1));
    const t = ws.getCell(1, 1);
    t.value = title;
    t.font = { bold: true, size: 14, color: { argb: "FF0EA5C9" } };
    ws.getRow(1).height = 22;
  }
  const headerRowIdx = title ? 2 : 1;

  const headRow = ws.getRow(headerRowIdx);
  columns.forEach((c, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    cell.alignment = { vertical: "middle" };
  });

  rows.forEach((r, ri) => {
    const row = ws.getRow(headerRowIdx + 1 + ri);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = r[c.key] ?? "";
      if (c.kind === "money") cell.numFmt = '"$"#,##0.00';
      else if (c.kind === "pct") cell.numFmt = '0.0"%"';
      else if (c.kind === "num") cell.numFmt = "#,##0.##";
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/* ------------------------------- PDF -------------------------------- */
export async function toPdf(
  rows: Record<string, any>[],
  columns: { key: string; label: string; kind?: string }[],
  title: string,
  subtitle?: string,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 792, pageH = 612; // landscape letter
  const margin = 36;
  const usableW = pageW - margin * 2;
  const colW = usableW / columns.length;
  const fmt = (v: any, kind?: string) => {
    if (v == null || v === "") return "";
    if (kind === "money") return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kind === "pct") return `${Number(v).toFixed(1)}%`;
    if (kind === "num") return Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (kind === "date") { const d = new Date(v); return isNaN(+d) ? String(v) : d.toLocaleDateString("en-US"); }
    const s = String(v);
    return s.length > 26 ? s.slice(0, 24) + "…" : s;
  };

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  // Same encoding-crash protection as buildJobPdf below: standard fonts only
  // support WinAnsi, so any emoji/unsupported character in row data (e.g. a
  // customer name) would otherwise throw and 500 the whole bulk export.
  const dt = (text: string, opts: Parameters<typeof page.drawText>[1]) => {
    try {
      page.drawText(text, opts);
    } catch {
      const ascii = Array.from(text).filter((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f).join("").trim();
      page.drawText(ascii || "(unsupported character)", opts);
    }
  };
  dt(title, { x: margin, y: y - 4, size: 16, font: bold, color: rgb(0.04, 0.65, 0.79) });
  y -= 22;
  if (subtitle) { dt(subtitle, { x: margin, y, size: 9, font, color: rgb(0.4, 0.45, 0.5) }); y -= 16; }
  y -= 6;

  const drawHeader = () => {
    page.drawRectangle({ x: margin, y: y - 16, width: usableW, height: 18, color: rgb(0.06, 0.09, 0.16) });
    columns.forEach((c, i) => {
      dt(c.label.slice(0, 18), { x: margin + i * colW + 4, y: y - 12, size: 8, font: bold, color: rgb(1, 1, 1) });
    });
    y -= 20;
  };
  drawHeader();

  rows.forEach((r, ri) => {
    if (y < margin + 24) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
      drawHeader();
    }
    if (ri % 2 === 0) page.drawRectangle({ x: margin, y: y - 13, width: usableW, height: 15, color: rgb(0.96, 0.97, 0.98) });
    columns.forEach((c, i) => {
      dt(fmt(r[c.key], c.kind), { x: margin + i * colW + 4, y: y - 10, size: 8, font, color: rgb(0.1, 0.12, 0.15) });
    });
    y -= 15;
  });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/* ----------------------- single-job detail PDF ---------------------- */
/** Internal (office/dispatch/driver) job sheet: label/value details + a
 *  per-unit work & pay breakdown. NEVER given to the client — it exposes
 *  tech-pay rates. Charge-only invoice for the client lives elsewhere. */
export type JobUnitLine = {
  name: string;
  unit: string;
  qty: number;
  unitPrice: number; // customer charge per unit
  unitCost: number;  // tech pay per unit
  price: number;     // line customer charge
  cost: number;      // line tech pay
};
export type JobPhoto = { url: string; caption?: string };

export async function buildJobPdf(
  details: { field: string; value: any }[],
  unitLines: JobUnitLine[],
  title: string,
  subtitle?: string,
  photos?: JobPhoto[],
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 612, pageH = 792; // portrait letter
  const margin = 40;
  const usableW = pageW - margin * 2;
  const money = (v: any) => `${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (v: any) => Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  // Standard PDF fonts (Helvetica/HelveticaBold) only support WinAnsi
  // encoding. It actually covers plenty of "fancy" punctuation (em-dash,
  // ellipsis, curly quotes) just fine — the real crash risk is emoji and
  // other characters outside WinAnsi entirely, which throw at draw time
  // ("WinAnsi cannot encode ...") and previously took down the WHOLE export
  // with a 500 the moment any job photo caption (or other free-text field)
  // contained one. Try the real text first (keeps existing punctuation
  // working exactly as before); only on an actual encoding failure fall
  // back to stripping to plain ASCII and retry, so one bad character can
  // never crash the export.
  const dt = (text: string, opts: Parameters<typeof page.drawText>[1]) => {
    try {
      page.drawText(text, opts);
    } catch {
      const ascii = Array.from(text).filter((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f).join("").trim();
      page.drawText(ascii || "(unsupported character)", opts);
    }
  };

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  const ensure = (need: number) => {
    if (y < margin + need) { page = doc.addPage([pageW, pageH]); y = pageH - margin; }
  };

  dt(title, { x: margin, y: y - 4, size: 17, font: bold, color: rgb(0.04, 0.65, 0.79) });
  y -= 24;
  if (subtitle) { dt(String(subtitle).slice(0, 90), { x: margin, y, size: 9, font, color: rgb(0.4, 0.45, 0.5) }); y -= 14; }
  dt("INTERNAL COPY — includes tech pay. Not for the customer.", { x: margin, y, size: 8, font: bold, color: rgb(0.78, 0.25, 0.16) });
  y -= 18;

  // --- details label/value block ---
  dt("Job details", { x: margin, y, size: 11, font: bold, color: rgb(0.1, 0.12, 0.15) });
  y -= 16;
  const labelW = 150;
  details.forEach((r, ri) => {
    ensure(20);
    if (ri % 2 === 0) page.drawRectangle({ x: margin, y: y - 11, width: usableW, height: 14, color: rgb(0.96, 0.97, 0.98) });
    dt(String(r.field).slice(0, 32), { x: margin + 4, y: y - 8, size: 8, font: bold, color: rgb(0.25, 0.3, 0.36) });
    const val = String(r.value ?? "");
    dt(val.length > 70 ? val.slice(0, 68) + "…" : val, { x: margin + labelW, y: y - 8, size: 8, font, color: rgb(0.1, 0.12, 0.15) });
    y -= 14;
  });
  y -= 12;

  // --- per-unit breakdown table ---
  if (unitLines.length) {
    ensure(60);
    dt("Per-unit work & pay", { x: margin, y, size: 11, font: bold, color: rgb(0.1, 0.12, 0.15) });
    y -= 16;
    const cols = [
      { label: "Description", w: 0.30, align: "l" as const },
      { label: "Unit", w: 0.10, align: "l" as const },
      { label: "Qty", w: 0.08, align: "r" as const },
      { label: "Charge/u", w: 0.13, align: "r" as const },
      { label: "Pay/u", w: 0.13, align: "r" as const },
      { label: "Line charge", w: 0.13, align: "r" as const },
      { label: "Line pay", w: 0.13, align: "r" as const },
    ];
    const xAt = (i: number) => margin + cols.slice(0, i).reduce((s, c) => s + c.w * usableW, 0);
    const drawCell = (text: string, i: number, yy: number, f = font, color = rgb(0.1, 0.12, 0.15)) => {
      const c = cols[i];
      const cx = xAt(i);
      const cw = c.w * usableW;
      if (c.align === "r") {
        const tw = f.widthOfTextAtSize(text, 8);
        dt(text, { x: cx + cw - tw - 4, y: yy, size: 8, font: f, color });
      } else {
        const max = c.label === "Description" ? 30 : 12;
        dt(text.length > max ? text.slice(0, max - 1) + "…" : text, { x: cx + 4, y: yy, size: 8, font: f, color });
      }
    };
    const drawHead = () => {
      page.drawRectangle({ x: margin, y: y - 15, width: usableW, height: 17, color: rgb(0.06, 0.09, 0.16) });
      cols.forEach((c, i) => drawCell(c.label, i, y - 11, bold, rgb(1, 1, 1)));
      y -= 19;
    };
    drawHead();
    let totCharge = 0, totPay = 0;
    unitLines.forEach((l, ri) => {
      ensure(20);
      if (y < margin + 24) { drawHead(); }
      if (ri % 2 === 0) page.drawRectangle({ x: margin, y: y - 13, width: usableW, height: 15, color: rgb(0.96, 0.97, 0.98) });
      const payOnly = Number(l.price || 0) <= 0;
      drawCell(l.name + (payOnly ? " (pay-only)" : ""), 0, y - 10);
      drawCell(l.unit || "", 1, y - 10);
      drawCell(num(l.qty), 2, y - 10);
      drawCell(payOnly ? "—" : money(l.unitPrice), 3, y - 10);
      drawCell(money(l.unitCost), 4, y - 10, font, rgb(0.72, 0.45, 0.05));
      drawCell(payOnly ? "—" : money(l.price), 5, y - 10);
      drawCell(money(l.cost), 6, y - 10, bold, rgb(0.72, 0.45, 0.05));
      totCharge += Number(l.price || 0);
      totPay += Number(l.cost || 0);
      y -= 15;
    });
    // totals row
    ensure(20);
    page.drawRectangle({ x: margin, y: y - 14, width: usableW, height: 16, color: rgb(0.92, 0.95, 0.97) });
    drawCell("Totals", 0, y - 10, bold);
    drawCell(money(totCharge), 5, y - 10, bold);
    drawCell(money(totPay), 6, y - 10, bold, rgb(0.72, 0.45, 0.05));
    y -= 18;
  }

  // --- photos section ---
  if (photos && photos.length > 0) {
    ensure(40);
    dt("Field Photos", { x: margin, y, size: 11, font: bold, color: rgb(0.1, 0.12, 0.15) });
    y -= 14;

    // Attempt to embed each photo from its URL
    for (const ph of photos) {
      ensure(24);
      // Show caption/URL as text (image embedding not guaranteed for all URLs)
      const caption = ph.caption ? `Photo: ${ph.caption}` : "Photo";
      dt(caption, { x: margin + 4, y: y - 8, size: 8, font: bold, color: rgb(0.25, 0.3, 0.36) });
      const urlText = ph.url.length > 80 ? ph.url.slice(0, 78) + "…" : ph.url;
      dt(urlText, { x: margin + 4, y: y - 18, size: 7, font, color: rgb(0.04, 0.42, 0.72) });
      y -= 28;
    }

    // Attempt to embed actual images (best-effort: skip on failure)
    let _imgY = y; void _imgY;
    for (const ph of photos) {
      try {
        const resp = await fetch(ph.url);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get("content-type") || "";
        let img;
        if (ct.includes("png")) img = await doc.embedPng(buf);
        else img = await doc.embedJpg(buf);
        const maxW = usableW / 2 - 10;
        const maxH = 160;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        ensure(h + 16);
        page.drawImage(img, { x: margin, y: y - h, width: w, height: h });
        y -= h + 12;
      } catch { /* skip unembeddable images */ }
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/* ------------------------- dataset definitions ---------------------- */
export const DATASET_COLUMNS: Record<string, { key: string; label: string; kind?: string }[]> = {
  "work-orders": [
    { key: "id", label: "ID" }, { key: "title", label: "Title" }, { key: "service", label: "Service" },
    { key: "client", label: "Client" }, { key: "clientPhone", label: "Phone" }, { key: "technician", label: "Technician" },
    { key: "status", label: "Status" }, { key: "priority", label: "Priority" }, { key: "address", label: "Address" },
    { key: "scheduledAt", label: "Scheduled", kind: "date" }, { key: "price", label: "Price", kind: "money" },
    { key: "paymentStatus", label: "Payment" }, { key: "createdAt", label: "Created", kind: "date" },
  ],
  technicians: [
    { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "email", label: "Email" },
    { key: "phone", label: "Phone" }, { key: "vehicle", label: "Vehicle" }, { key: "skillClass", label: "Class" },
    { key: "skills", label: "Skills" }, { key: "status", label: "Status" }, { key: "rating", label: "Rating", kind: "num" },
    { key: "completedJobs", label: "Jobs", kind: "num" },
  ],
  clients: [
    { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "email", label: "Email" },
    { key: "phone", label: "Phone" }, { key: "createdAt", label: "Created", kind: "date" },
  ],
  invoices: [
    { key: "number", label: "Invoice" }, { key: "amount", label: "Amount", kind: "money" }, { key: "tax", label: "Tax", kind: "money" },
    { key: "total", label: "Total", kind: "money" }, { key: "status", label: "Status" }, { key: "method", label: "Method" },
    { key: "paidAt", label: "Paid", kind: "date" }, { key: "createdAt", label: "Created", kind: "date" },
  ],
};

export async function loadDataset(dataset: string, t: TenantDb): Promise<Record<string, any>[]> {
  const cid = t.companyId;
  if (dataset === "work-orders") {
    const bs = await t.select(schema.bookings);
    return Promise.all(bs.map(async (b) => {
      const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));
      const [cu] = await db.select().from(schema.user).where(eq(schema.user.id, b.customerId));
      let tech = "";
      if (b.riderId) {
        const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
        if (r) { const [ru] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId)); tech = ru?.name ?? ""; }
      }
      return {
        id: b.id, title: b.title, service: svc?.name ?? "", client: cu?.name ?? "", clientPhone: b.customerPhone,
        technician: tech, status: b.status, priority: b.priority, address: b.address,
        scheduledAt: b.scheduledAt, price: b.total || b.price, paymentStatus: b.paymentStatus, createdAt: b.createdAt,
      };
    }));
  }
  if (dataset === "technicians") {
    const ts = await t.select(schema.riders);
    return Promise.all(ts.map(async (tr) => {
      const [ru] = await db.select().from(schema.user).where(eq(schema.user.id, tr.userId));
      return { id: tr.id, name: ru?.name ?? "", email: ru?.email ?? "", phone: tr.phone || ru?.phone || "", vehicle: tr.vehicle, skillClass: tr.skillClass, skills: tr.skills, status: tr.status, rating: tr.rating, completedJobs: tr.completedJobs };
    }));
  }
  if (dataset === "clients") {
    const us = (await db.select().from(schema.user).where(eq(schema.user.role, "customer"))).filter((u) => u.companyId === cid);
    return us.map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt }));
  }
  if (dataset === "invoices") {
    const inv = await t.select(schema.invoices);
    return inv.map((i) => ({ number: i.number, amount: i.amount, tax: i.tax, total: i.total, status: i.status, method: i.method, paidAt: i.paidAt, createdAt: i.createdAt }));
  }
  return [];
}

export function fileResponse(buf: Buffer | string, name: string, mime: string) {
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}

export const exportRoutes = new Hono()
  // generic report export: client posts the already-computed report rows/columns.
  // POST /api/export/report?format=csv|xlsx|pdf  body: { title, subtitle, rows, columns }
  .post("/report", requireAuth, async (c) => {
    const format = (c.req.query("format") || "csv").toLowerCase();
    const body = await c.req.json<{ title: string; subtitle?: string; rows: any[]; columns: any[] }>();
    const { title, subtitle, rows, columns } = body;
    const slug = (title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const stamp = Date.now();
    if (format === "xlsx") {
      const buf = await toXlsx(rows, columns, title || "Report", title);
      return fileResponse(buf, `nvc360-${slug}-${stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (format === "pdf") {
      const buf = await toPdf(rows, columns, title || "Report", subtitle);
      return fileResponse(buf, `nvc360-${slug}-${stamp}.pdf`, "application/pdf");
    }
    const csv = toCsv(rows, columns.map((c: any) => c.key));
    return fileResponse(csv, `nvc360-${slug}-${stamp}.csv`, "text/csv; charset=utf-8");
  })
  // GET /api/export/:dataset?columns=a,b,c&format=csv|xlsx|pdf
  .get("/:dataset", requireAuth, async (c) => {
    const dataset = c.req.param("dataset");
    if (!DATASET_COLUMNS[dataset]) return c.json({ message: "Unknown dataset" }, 400);
    const format = (c.req.query("format") || "csv").toLowerCase();
    const colsParam = c.req.query("columns");
    const picked = colsParam ? colsParam.split(",").map((s) => s.trim()) : undefined;

    const allCols = DATASET_COLUMNS[dataset];
    const cols = picked ? allCols.filter((c) => picked.includes(c.key)) : allCols;
    const rows = await loadDataset(dataset, tdb(tenantId(c)));
    const stamp = Date.now();
    const title = dataset.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

    if (format === "xlsx") {
      const buf = await toXlsx(rows, cols, title, title);
      return fileResponse(buf, `nvc360-${dataset}-${stamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (format === "pdf") {
      const buf = await toPdf(rows, cols, title);
      return fileResponse(buf, `nvc360-${dataset}-${stamp}.pdf`, "application/pdf");
    }
    const csv = toCsv(rows, cols.map((c) => c.key));
    return fileResponse(csv, `nvc360-${dataset}-${stamp}.csv`, "text/csv; charset=utf-8");
  })
  // schema preview so the UI can let users pick columns
  .get("/:dataset/columns", requireAuth, async (c) => {
    const ds = DATASET_COLUMNS[c.req.param("dataset")];
    return c.json({ columns: ds ? ds.map((c) => c.key) : [] }, 200);
  });
