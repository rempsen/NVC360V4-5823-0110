import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Field, inputCls, BtnPrimary } from "./modal";
import { Plus, Trash2, Clock, CalendarOff } from "lucide-react";
import { useBrand } from "../lib/use-brand";
import { fmtInZone } from "../../shared/tz";

type Shift = {
  id: string;
  riderId: string;
  kind: string;
  date: string | number;
  startMin: number;
  endMin: number;
  note: string;
};

const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/**
 * On the COMPANY's clock, not the viewer's. A day stored as its local midnight
 * formatted in the browser's zone showed the day before for anyone further west
 * — the office booked Tuesday off and the list said Monday.
 */
const fmtDate = (d: string | number, tz: string) =>
  fmtInZone(d, tz, { weekday: "short", month: "short", day: "numeric" });

export function TechShifts({ riderId }: { riderId: string }) {
  const qc = useQueryClient();
  const brand = useBrand();
  const [form, setForm] = useState({ kind: "shift", date: new Date().toISOString().slice(0, 10), start: "09:00", end: "17:00", note: "" });

  const shiftsQ = useQuery({
    queryKey: ["shifts", riderId],
    queryFn: async () => (await api.shifts.$get({ query: { riderId } })).json(),
  });

  const add = useMutation({
    mutationFn: async () =>
      (await api.shifts.$post({
        json: {
          riderId,
          kind: form.kind,
          // The day as the office typed it. Sending `new Date("2026-09-15").getTime()`
          // sent UTC midnight, which the server read as the previous local day.
          date: form.date,
          startMin: toMin(form.start),
          endMin: toMin(form.end),
          note: form.note,
        } as any,
      })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts", riderId] });
      setForm({ ...form, note: "" });
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.shifts[":id"].$delete({ param: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shifts", riderId] }),
  });

  const shifts: Shift[] = ((shiftsQ.data as any)?.shifts ?? []).sort(
    (a: Shift, b: Shift) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Type">
            <select className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="shift">Shift</option>
              <option value="timeoff">Time off</option>
            </select>
          </Field>
          <Field label="Date">
            <input aria-label="Date" type="date" className={inputCls} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        </div>
        {form.kind === "shift" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Start"><input aria-label="Start" type="time" className={inputCls} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            <Field label="End"><input aria-label="End" type="time" className={inputCls} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
          </div>
        )}
        <div className="mt-2">
          <Field label="Note">
            <input aria-label="optional" className={inputCls} value={form.note} placeholder="optional" onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <BtnPrimary disabled={add.isPending} onClick={() => add.mutate()}><Plus className="h-4 w-4" /> Add</BtnPrimary>
        </div>
      </div>

      {shifts.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No shifts or time-off scheduled.</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <div key={s.id} className="group flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
              <span className={`grid h-9 w-9 place-items-center rounded-lg ${s.kind === "timeoff" ? "bg-rose-500/15 text-rose-400" : "bg-brand/15 text-cyan-glow"}`}>
                {s.kind === "timeoff" ? <CalendarOff className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white">{fmtDate(s.date, brand.timezone)}</p>
                <p className="text-[11px] text-slate-500">
                  {s.kind === "timeoff" ? "Time off" : `${toHM(s.startMin)} – ${toHM(s.endMin)}`}
                  {s.note ? ` · ${s.note}` : ""}
                </p>
              </div>
              <button onClick={() => del.mutate(s.id)} className="rounded-lg p-1.5 text-slate-500 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
