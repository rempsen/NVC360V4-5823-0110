// ─── Public options/selections page — no auth, token-based ────────────────
// /s/:token — reuses the same booking.publicToken already used for live
// tracking (/t/:token). Customer picks one tier per category, types their
// name as an e-signature, and submits — price deltas roll into the job's
// invoice via the backend (routes/option-selections.ts).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { Logo } from "../components/brand";
import { UserFacingError } from "../lib/api-error";
import { money } from "../lib/utils";
import { CheckCircle2, ShieldCheck, Star, PenLine } from "lucide-react";

type OptionItem = {
  id: string;
  tierLabel: string;
  name: string;
  description: string;
  image: string;
  priceDelta: number;
  isDefault: boolean;
};
type Category = { id: string; name: string; description: string; items: OptionItem[] };
type Payload = {
  booking: { id: string; title: string; status: string; address: string };
  company: { name: string } | null;
  categories: Category[];
  existingSelections: { categoryId: string; itemId: string; signatureName: string; selectedAt: string | number | null }[];
  locked: boolean;
};

export default function SelectionsPublic() {
  const [, params] = useRoute("/s/:token");
  const token = params?.token ?? "";
  const qc = useQueryClient();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [signatureName, setSignatureName] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const query = useQuery({
    queryKey: ["selections", token],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch(`/api/selections/${token}`);
      // Status preserved + handled locally: a dead/expired selections link is
      // rendered as its own "link isn't valid" page below, not a crash report.
      if (!res.ok) throw new UserFacingError("not_found", { status: res.status });
      return res.json();
    },
    enabled: !!token,
    retry: false,
    meta: { silentError: true },
  });

  const data = query.data;

  // seed picks with the default tier per category (and any prior selection) once loaded
  useMemo(() => {
    if (!data) return;
    setPicks((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, string> = {};
      for (const cat of data.categories) {
        const existing = data.existingSelections.find((s) => s.categoryId === cat.id);
        const def = cat.items.find((i) => i.isDefault);
        if (existing) next[cat.id] = existing.itemId;
        else if (def) next[cat.id] = def.id;
      }
      return next;
    });
  }, [data]);

  const submit = useMutation({
    mutationFn: async () => {
      const selections = Object.entries(picks).map(([categoryId, itemId]) => ({ categoryId, itemId }));
      const res = await fetch(`/api/selections/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections, signatureName }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        // Shown inline under the Submit button (see submit.isError below).
        throw new UserFacingError(j.message || "Failed to submit", { status: res.status });
      }
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      qc.invalidateQueries({ queryKey: ["selections", token] });
    },
  });

  if (query.isLoading) {
    return <div className="grid min-h-screen place-items-center bg-ink text-slate-400">Loading…</div>;
  }
  if (query.isError || !data) {
    return (
      <div className="grid min-h-screen place-items-center bg-ink px-6 text-center">
        <div>
          <Logo light className="mb-4 justify-center" />
          <p className="text-slate-400">This selections link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  const total = data.categories.reduce((sum, cat) => {
    const pickedId = picks[cat.id];
    const item = cat.items.find((i) => i.id === pickedId);
    return sum + (item?.priceDelta ?? 0);
  }, 0);

  const isLocked = data.locked || submitted;
  const allPicked = data.categories.every((cat) => !!picks[cat.id]);

  return (
    <div className="nvc-grid-bg min-h-screen bg-ink text-slate-200">
      <header className="border-b border-white/5 bg-ink-2/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Logo light />
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-live" /> Secure selections link
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5">
          <h1 className="font-display text-xl font-bold text-white">{data.booking.title || "Your job"}</h1>
          {data.company?.name && <p className="text-sm text-slate-400">{data.company.name}</p>}
          {data.booking.address && <p className="text-xs text-slate-500">{data.booking.address}</p>}
        </div>

        {isLocked ? (
          <div className="nvc-card flex flex-col items-center gap-3 p-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Selections confirmed</h2>
            <p className="max-w-md text-sm text-slate-400">
              Thanks — your choices have been recorded and the price has been added to your job.
              {data.company?.name ? ` ${data.company.name}` : "The team"} will follow up if anything
              else is needed.
            </p>
            <div className="mt-2 w-full max-w-sm space-y-1.5 rounded-lg border border-white/10 bg-white/5 p-3 text-left text-sm">
              {data.categories.map((cat) => {
                const sel = data.existingSelections.find((s) => s.categoryId === cat.id);
                const item = cat.items.find((i) => i.id === (sel?.itemId ?? picks[cat.id]));
                if (!item) return null;
                return (
                  <div key={cat.id} className="flex justify-between">
                    <span className="text-slate-400">{cat.name}: {item.name}</span>
                    <span className="text-slate-300">{item.priceDelta === 0 ? "Included" : `+${money(item.priceDelta)}`}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {data.categories.map((cat) => (
              <div key={cat.id} className="nvc-card p-4">
                <h2 className="text-base font-semibold text-white">{cat.name}</h2>
                {cat.description && <p className="mb-3 text-sm text-slate-400">{cat.description}</p>}
                <div className="grid gap-2 sm:grid-cols-3">
                  {cat.items.map((item) => {
                    const active = picks[cat.id] === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setPicks((p) => ({ ...p, [cat.id]: item.id }))}
                        className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                          active ? "border-brand bg-brand/10" : "border-white/10 bg-white/[0.03] hover:border-white/25"
                        }`}
                      >
                        {item.tierLabel && (
                          <span className="inline-flex w-fit items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {item.isDefault && <Star className="h-2.5 w-2.5" fill="currentColor" />}
                            {item.tierLabel}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-white">{item.name}</span>
                        {item.description && <span className="text-xs text-slate-500">{item.description}</span>}
                        <span className={`mt-1 text-sm font-bold ${active ? "text-brand" : "text-slate-300"}`}>
                          {item.priceDelta === 0 ? "Included" : `+${money(item.priceDelta)}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="nvc-card flex items-center justify-between p-4">
              <span className="text-sm font-medium text-slate-300">Total upgrades</span>
              <span className="text-lg font-bold text-white">{money(total)}</span>
            </div>

            <div className="nvc-card space-y-3 p-4">
              <label htmlFor="signature-name" className="flex items-center gap-1.5 text-sm font-medium text-slate-300">
                <PenLine className="h-3.5 w-3.5" /> Type your name to confirm these selections
              </label>
              <input
                id="signature-name"
                aria-label="Type your name to confirm these selections"
                value={signatureName}
                onChange={(e) => setSignatureName(e.target.value)}
                placeholder="Full name"
                className="w-full rounded-md border border-white/10 bg-ink px-3 py-2 text-sm outline-none focus:border-brand"
              />
              {submit.isError && (
                <p className="text-sm text-red-400">{(submit.error as Error).message}</p>
              )}
              <button
                type="button"
                disabled={!allPicked || !signatureName.trim() || submit.isPending}
                onClick={() => submit.mutate()}
                className="w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
              >
                {submit.isPending ? "Submitting…" : "Confirm selections"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
