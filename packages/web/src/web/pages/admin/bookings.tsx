import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "../../components/toast";
import { useConfirm } from "../../components/confirm-dialog";
import { DialogPanel } from "../../components/dialog-panel";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../../lib/api";
import { StatusBadge, PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { fmtDate, money, PRIORITY_META, dismiss } from "../../lib/utils";
import {
  X, UserPlus, MapPin, Search, Sparkles, Plus, Pencil,
  Download, Filter, Trash2, RotateCcw, Printer, ChevronLeft, ChevronRight,
  Columns3, FileJson, FileText, FileSpreadsheet, Loader2, ChevronDown, ClipboardList,
} from "lucide-react";
import { useWorkerNoun, useCustomerNoun, useJobNoun } from "../../lib/use-brand";
import { TechAvatar } from "../../components/tech-avatar";
import { WorkOrderModal } from "../../components/work-order-modal";
import { EmptyState } from "../../components/empty-state";

const QUICK = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "assigned", label: "Assigned" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

type ExpCol = { key: string; label: string; kind?: string; group: string };

const EMPTY = {
  status: [] as string[],
  priority: [] as string[],
  paymentStatus: [] as string[],
  serviceId: "",
  riderId: "",
  region: "",
  tagId: "",
  notes: "",
  schedFrom: "",
  schedTo: "",
  doneFrom: "",
  doneTo: "",
  priceMin: "",
  priceMax: "",
  jobId: "",
};

function buildQuery(f: typeof EMPTY, q: string, includeDeleted: boolean) {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.priority.length) p.set("priority", f.priority.join(","));
  if (f.paymentStatus.length) p.set("paymentStatus", f.paymentStatus.join(","));
  if (f.serviceId) p.set("serviceId", f.serviceId);
  if (f.riderId) p.set("riderId", f.riderId);
  if (f.region) p.set("region", f.region);
  if (f.tagId) p.set("tagId", f.tagId);
  if (f.notes.trim()) p.set("notes", f.notes.trim());
  if (f.jobId.trim()) p.set("jobId", f.jobId.trim());
  const epoch = (s: string) => (s ? String(new Date(s).getTime()) : "");
  if (f.schedFrom) p.set("schedFrom", epoch(f.schedFrom));
  if (f.schedTo) p.set("schedTo", epoch(f.schedTo));
  if (f.doneFrom) p.set("doneFrom", epoch(f.doneFrom));
  if (f.doneTo) p.set("doneTo", epoch(f.doneTo));
  if (f.priceMin) p.set("priceMin", f.priceMin);
  if (f.priceMax) p.set("priceMax", f.priceMax);
  if (includeDeleted) p.set("includeDeleted", "1");
  return p;
}

export default function AdminWorkOrders() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  const { noun: jobNoun, nounPlural: jobPlural } = useJobNoun();
  const initialStatus =
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("status")) ||
    "";

  const [assignFor, setAssignFor] = useState<any>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editJob, setEditJob] = useState<any>(null);
  const [, navigate] = useLocation();
  // Completed jobs are historical records now — clicking one opens the
  // read-only report page instead of the editable work-order form.
  // Cancelled (and every other status) keep the old edit-modal behavior.
  const openJob = (b: any) => {
    if (b.status === "completed") navigate(`/admin/jobs/${b.id}/report`);
    else setEditJob(b);
  };

  const [quick, setQuick] = useState(
    QUICK.some((x) => x.key === initialStatus) ? initialStatus : "",
  );
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<typeof EMPTY>({
    ...EMPTY,
    status: initialStatus && QUICK.some((x) => x.key === initialStatus) ? [] : [],
  });
  const [showFilters, setShowFilters] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [sort, setSort] = useState("scheduledAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  // debounce free-text search
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [qInput]);

  // merge quick-status pill into the status filter set
  const effStatus = useMemo(
    () => (quick ? [quick] : filters.status),
    [quick, filters.status],
  );
  const effFilters = useMemo(
    () => ({ ...filters, status: effStatus }),
    [filters, effStatus],
  );

  const facets = useQuery({
    queryKey: ["jobFacets"],
    queryFn: async () => (await api.jobs.facets.$get()).json() as Promise<any>,
    staleTime: 60_000,
  });

  const params = useMemo(
    () => buildQuery(effFilters, q, includeDeleted),
    [effFilters, q, includeDeleted],
  );

  const search = useQuery({
    queryKey: ["jobSearch", params.toString(), page, pageSize, sort, dir],
    queryFn: async () => {
      const p = new URLSearchParams(params);
      p.set("page", String(page));
      p.set("pageSize", String(pageSize));
      p.set("sort", sort);
      p.set("dir", dir);
      const res = await fetch(`/api/jobs/search?${p.toString()}`, {
        credentials: "include",
        headers: apiHeaders(),
      });
      if (!res.ok) throw new Error("search failed");
      return res.json() as Promise<{
        jobs: any[];
        total: number;
        page: number;
        pages: number;
      }>;
    },
    refetchInterval: 12000,
    placeholderData: (prev) => prev,
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.jobs[":id"].$delete({ param: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobSearch"] }),
  });
  const restore = useMutation({
    mutationFn: async (id: string) =>
      api.jobs[":id"].restore.$post({ param: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobSearch"] }),
  });

  const list = search.data?.jobs ?? [];
  const total = search.data?.total ?? 0;
  const pages = search.data?.pages ?? 1;

  const activeFilterCount = useMemo(() => {
    let n = 0;
    const f = filters;
    if (f.priority.length) n++;
    if (f.paymentStatus.length) n++;
    if (!quick && f.status.length) n++;
    if (f.serviceId) n++;
    if (f.riderId) n++;
    if (f.region) n++;
    if (f.tagId) n++;
    if (f.notes.trim()) n++;
    if (f.jobId.trim()) n++;
    if (f.schedFrom || f.schedTo) n++;
    if (f.doneFrom || f.doneTo) n++;
    if (f.priceMin || f.priceMax) n++;
    if (includeDeleted) n++;
    return n;
  }, [filters, quick, includeDeleted]);

  // Distinguishes "you filtered everything out" from "there is genuinely
  // nothing here" -- the two need completely different empty states, and
  // showing "create your first work order" to someone who just typed a bad
  // search term is the classic version of getting this wrong.
  const hasAnyFilter = activeFilterCount > 0 || !!quick || !!qInput.trim();

  function clearAll() {
    setFilters(EMPTY);
    setQuick("");
    setQInput("");
    setQ("");
    setIncludeDeleted(false);
    setPage(1);
  }

  function toggleSort(key: string) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir("desc");
    }
  }

  return (
    <PageWrap>
      <PageHead
        title={jobPlural}
        subtitle={`Search, filter, dispatch and export every ${jobNoun.toLowerCase()}`}
        actions={
          <div className="flex items-center gap-2">
            <ExportMenu params={params} columns={facets.data?.columns ?? []} />
            <button
              onClick={() => setNewOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep"
            >
              <Plus className="h-4 w-4" /> New {jobNoun}
            </button>
          </div>
        }
      />
      <WorkOrderModal open={newOpen} onClose={() => setNewOpen(false)} />
      <WorkOrderModal
        open={editJob !== null}
        editBooking={editJob ?? undefined}
        onClose={() => setEditJob(null)}
      />

      {/* quick pills + search + filter toggle */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((f) => (
            <button
              key={f.key || "all"}
              onClick={() => {
                setQuick(f.key);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                quick === f.key
                  ? "bg-brand text-white"
                  : "bg-ink-2 text-slate-400 hover:bg-white/5"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters((s) => !s)}
            className={`relative flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition ${
              showFilters || activeFilterCount
                ? "border-brand/50 bg-brand/10 text-white"
                : "border-white/10 bg-ink-2 text-slate-300 hover:bg-white/5"
            }`}
          >
            <Filter className="h-3.5 w-3.5" /> Filters
            {activeFilterCount > 0 && (
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input aria-label="Search name, phone, email, address…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search name, phone, email, address…"
              className="w-full rounded-full border border-white/10 bg-ink-2 py-2 pl-9 pr-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand sm:w-72"
            />
          </div>
        </div>
      </div>

      {showFilters && (
        <FilterBar
          filters={filters}
          setFilters={(u) => {
            setFilters(u);
            setPage(1);
          }}
          facets={facets.data}
          includeDeleted={includeDeleted}
          setIncludeDeleted={(v) => {
            setIncludeDeleted(v);
            setPage(1);
          }}
          activeCount={activeFilterCount}
          onClear={clearAll}
        />
      )}

      <div className="nvc-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 text-xs text-slate-500">
          <span>
            {search.isFetching ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Searching…
              </span>
            ) : (
              <>
                <span className="font-semibold text-slate-300">{total}</span>{" "}
                {total === 1 ? jobNoun.toLowerCase() : jobPlural.toLowerCase()}
              </>
            )}
          </span>
          <SortControl sort={sort} dir={dir} onSort={toggleSort} />
        </div>
        {/* The capped, self-scrolling table (which is what makes the sticky
            header work) is desktop-only on purpose. On a phone a nested
            vertical scroller fights the page scroll -- you flick to move the
            page and instead move the table -- so below lg it stays a plain
            horizontally-scrolling table inside normal page flow. */}
        <div className="nvc-scroll-y overflow-x-auto lg:max-h-[calc(100vh-19rem)] lg:overflow-auto">
          <table className="nvc-thead-sticky w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-3 font-semibold lg:px-4">{jobNoun}</th>
                <th className="hidden px-3 py-3 font-semibold lg:table-cell lg:px-4">{customerNoun}</th>
                <th className="hidden px-3 py-3 font-semibold xl:table-cell xl:px-4">Schedule</th>
                <th className="hidden px-3 py-3 font-semibold md:table-cell lg:px-4">{noun}</th>
                <th className="px-3 py-3 font-semibold lg:px-4">Status</th>
                <th className="hidden px-3 py-3 text-right font-semibold sm:table-cell lg:px-4">Total</th>
                <th className="relative px-3 py-3 lg:px-4"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {search.isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12">
                    {/* Skeleton rows rather than a "Loading…" string: the table
                        keeps its shape, so the list does not jump when data
                        lands. */}
                    <div className="mx-4 space-y-2.5" aria-live="polite" aria-busy="true">
                      <span className="sr-only">Loading work orders…</span>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className="h-9 animate-pulse rounded-md bg-white/[0.04]"
                          style={{ animationDelay: `${i * 90}ms` }}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : list.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {hasAnyFilter ? (
                      <EmptyState
                        icon={Search}
                        title="No matches"
                        hint="Nothing here fits the current filters and search. Widen the date range or clear the filters to see everything."
                        action={
                          <button
                            onClick={clearAll}
                            className="rounded-md border border-white/10 bg-ink-2 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/5"
                          >
                            Clear filters
                          </button>
                        }
                      />
                    ) : (
                      <EmptyState
                        icon={ClipboardList}
                        title={`No ${jobPlural.toLowerCase()} yet`}
                        hint={`Create one from the button above, or let ${customerNoun.toLowerCase()}s book themselves through an intake form.`}
                      />
                    )}
                  </td>
                </tr>
              ) : (
                list.map((b) => {
                  const archived = !!b.deletedAt;
                  return (
                    <tr
                      key={b.id}
                      className={`hover:bg-white/[0.03] ${archived ? "opacity-50" : ""}`}
                    >
                      <td
                        className={`px-3 py-3 lg:px-4 ${archived ? "" : "cursor-pointer"}`}
                        aria-label={b.title || b.service || b.jobNumber}
                        onClick={() => {
                          if (!archived) openJob(b);
                        }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                              {b.jobNumber}
                            </span>
                            <p className="truncate font-semibold text-slate-100">
                              {b.title || b.service}
                            </p>
                            {b.priority && PRIORITY_META[b.priority] && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                                style={{
                                  color: PRIORITY_META[b.priority].color,
                                  background: `${PRIORITY_META[b.priority].color}22`,
                                }}
                              >
                                {PRIORITY_META[b.priority].label}
                              </span>
                            )}
                            {archived && (
                              <span className="shrink-0 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-400">
                                ARCHIVED
                              </span>
                            )}
                          </div>
                          <p className="flex items-center gap-1 truncate text-xs text-slate-500">
                            <MapPin className="h-3 w-3" /> {b.address}
                          </p>
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 text-slate-300 lg:table-cell lg:px-4">
                        {b.customerName}
                      </td>
                      <td className="hidden px-3 py-3 text-slate-400 xl:table-cell xl:px-4">
                        {b.scheduledAt ? fmtDate(b.scheduledAt) : "—"}
                      </td>
                      <td className="hidden px-3 py-3 text-slate-300 md:table-cell lg:px-4">
                        {b.technician === "Unassigned" ? (
                          <span className="text-slate-600">Unassigned</span>
                        ) : (
                          b.technician
                        )}
                      </td>
                      <td className="px-3 py-3 lg:px-4">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="hidden px-3 py-3 text-right font-bold text-white sm:table-cell lg:px-4">
                        {money(b.total ?? 0)}
                      </td>
                      <td className="px-3 py-3 lg:px-4">
                        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                          {!archived &&
                            ["pending", "confirmed"].includes(b.status) && (
                              <button
                                onClick={() => setAssignFor(b)}
                                aria-label={`Assign ${noun.toLowerCase()}`}
                                className="inline-flex items-center gap-1.5 rounded-full bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-deep lg:px-3"
                              >
                                <UserPlus className="h-3.5 w-3.5" />{" "}
                                <span className="hidden lg:inline">Assign</span>
                              </button>
                            )}
                          {!archived && (
                            <button
                              onClick={() => openJob(b)}
                              title={b.status === "completed" ? "View job report" : "Edit work order"}
                              aria-label={b.status === "completed" ? "View job report" : "Edit work order"}
                              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:border-brand/50 hover:text-white lg:px-3"
                            >
                              {b.status === "completed"
                                ? <ClipboardList className="h-3.5 w-3.5" />
                                : <Pencil className="h-3.5 w-3.5" />}{" "}
                              <span className="hidden lg:inline">{b.status === "completed" ? "Report" : "Edit"}</span>
                            </button>
                          )}
                          <RowExportMenu jobId={b.id} jobNumber={b.jobNumber} />
                          {archived ? (
                            <button
                              onClick={() => restore.mutate(b.id)}
                              title="Restore"
                              className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-emerald-live hover:bg-white/5"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={async () => {
                                if (
                                  await confirm({
                                    title: "Archive this work order?",
                                    message: "It moves to the archive and can be restored later.",
                                    confirmLabel: "Archive",
                                  })
                                )
                                  del.mutate(b.id);
                              }}
                              title="Archive"
                              className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-slate-400 hover:border-rose-500/40 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* pagination */}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-white/5 px-4 py-3 text-xs text-slate-400">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 hover:bg-white/5 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 hover:bg-white/5 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {assignFor && (
        <AssignModal
          booking={assignFor}
          onClose={() => setAssignFor(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["jobSearch"] });
            qc.invalidateQueries({ queryKey: ["fleet"] });
            setAssignFor(null);
          }}
        />
      )}
    </PageWrap>
  );
}

/* ----------------------------- sort control ------------------------------ */
const SORTS = [
  { key: "scheduledAt", label: "Scheduled" },
  { key: "createdAt", label: "Created" },
  { key: "completedAt", label: "Completed" },
  { key: "total", label: "Total" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
];

function SortControl({
  sort,
  dir,
  onSort,
}: {
  sort: string;
  dir: string;
  onSort: (k: string) => void;
}) {
  const dirLabel = dir === "asc" ? "ascending" : "descending";
  // One control, not two. The field picker and the direction toggle are a
  // single decision ("sort by X, this way round"), so they share one bordered
  // group -- previously the chevron button floated beside the select looking
  // like an unrelated action.
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden sm:inline">Sort:</span>
      <div className="flex items-center overflow-hidden rounded-md border border-white/10 bg-ink-2 focus-within:border-brand/60">
        <select
          aria-label="Sort work orders by"
          value={sort}
          onChange={(e) => onSort(e.target.value)}
          className="appearance-none bg-transparent py-1 pl-2 pr-1 text-xs text-slate-300 outline-none focus-visible:shadow-none"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => onSort(sort)}
          title={`Sorted ${dirLabel} — click to reverse`}
          aria-label={`Sorted ${dirLabel}. Reverse sort order`}
          className="grid h-7 w-7 place-items-center border-l border-white/10 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${dir === "asc" ? "rotate-180" : ""}`}
          />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ filter bar ------------------------------- */
function FilterBar({
  filters,
  setFilters,
  facets,
  includeDeleted,
  setIncludeDeleted,
  activeCount,
  onClear,
}: {
  filters: typeof EMPTY;
  setFilters: (f: typeof EMPTY) => void;
  facets: any;
  includeDeleted: boolean;
  setIncludeDeleted: (v: boolean) => void;
  activeCount: number;
  onClear: () => void;
}) {
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  // FilterBar is its own component, so it needs its own brand-noun hooks.
  // This was previously reading `jobNoun` from the parent's scope, which
  // doesn't exist here — opening the Filters panel threw
  // "jobNoun is not defined" and took the whole Jobs page down.
  const { noun: jobNoun } = useJobNoun();
  const up = (patch: Partial<typeof EMPTY>) =>
    setFilters({ ...filters, ...patch });
  const toggleArr = (key: "status" | "priority" | "paymentStatus", v: string) => {
    const cur = filters[key];
    up({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as any);
  };

  const chip = (active: boolean) =>
    `rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
      active ? "bg-brand text-white" : "bg-ink-2 text-slate-400 hover:bg-white/10"
    }`;
  const inputCls =
    "rounded-lg border border-white/10 bg-ink-2 px-2.5 py-1.5 text-xs text-white outline-none focus:border-brand";

  return (
    <div className="nvc-card mb-4 space-y-4 p-4">
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Status
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(facets?.statuses ?? []).map((s: string) => (
              <button
                key={s}
                onClick={() => toggleArr("status", s)}
                className={chip(filters.status.includes(s))}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Priority
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(facets?.priorities ?? []).map((s: string) => (
              <button
                key={s}
                onClick={() => toggleArr("priority", s)}
                className={chip(filters.priority.includes(s))}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Payment
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(facets?.paymentStatuses ?? []).map((s: string) => (
              <button
                key={s}
                onClick={() => toggleArr("paymentStatus", s)}
                className={chip(filters.paymentStatus.includes(s))}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Service</span>
          <select
            value={filters.serviceId}
            onChange={(e) => up({ serviceId: e.target.value })}
            className={inputCls}
          >
            <option value="">Any</option>
            {(facets?.services ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{noun}</span>
          <select
            value={filters.riderId}
            onChange={(e) => up({ riderId: e.target.value })}
            className={inputCls}
          >
            <option value="">Any</option>
            <option value="__unassigned__">Unassigned</option>
            {(facets?.technicians ?? []).map((t: any) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Region</span>
          <select
            value={filters.region}
            onChange={(e) => up({ region: e.target.value })}
            className={inputCls}
          >
            <option value="">Any</option>
            {(facets?.regions ?? []).map((r: string) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{customerNoun} tag</span>
          <select
            value={filters.tagId}
            onChange={(e) => up({ tagId: e.target.value })}
            className={inputCls}
          >
            <option value="">Any</option>
            {(facets?.tags ?? []).map((t: any) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{jobNoun} #</span>
          <input aria-label="e.g. A1B2C3"
            value={filters.jobId}
            onChange={(e) => up({ jobId: e.target.value })}
            placeholder="e.g. A1B2C3"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Notes contain</span>
          <input aria-label="text in notes"
            value={filters.notes}
            onChange={(e) => up({ notes: e.target.value })}
            placeholder="text in notes"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Min total ($)</span>
          <input aria-label="0"
            type="number"
            value={filters.priceMin}
            onChange={(e) => up({ priceMin: e.target.value })}
            placeholder="0"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Max total ($)</span>
          <input aria-label="∞"
            type="number"
            value={filters.priceMax}
            onChange={(e) => up({ priceMax: e.target.value })}
            placeholder="∞"
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Scheduled from</span>
          <input aria-label="Sched From" type="date" value={filters.schedFrom} onChange={(e) => up({ schedFrom: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Scheduled to</span>
          <input aria-label="Sched To" type="date" value={filters.schedTo} onChange={(e) => up({ schedTo: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Completed from</span>
          <input aria-label="Done From" type="date" value={filters.doneFrom} onChange={(e) => up({ doneFrom: e.target.value })} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Completed to</span>
          <input aria-label="Done To" type="date" value={filters.doneTo} onChange={(e) => up({ doneTo: e.target.value })} className={inputCls} />
        </label>
      </div>

      <div className="flex items-center justify-between border-t border-white/5 pt-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input aria-label="Include Deleted"
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-white/20 bg-ink-2 accent-brand"
          />
          Show archived
        </label>
        <button
          onClick={onClear}
          disabled={activeCount === 0}
          className="text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-40"
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}

/* ------------------------- bulk export dropdown -------------------------- */
// Fetch with auth + tenant headers, then trigger a download from the blob.
// A bare <a href> can't send the bearer token or the superadmin X-Company-Id
// header, so exports would either 401 or return the wrong company's data.
async function download(url: string) {
  try {
    const res = await fetch(url, { credentials: "include", headers: apiHeaders() });
    if (!res.ok) throw new Error(`export failed (${res.status})`);
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    const name = m?.[1] || url.split("/").pop()?.split("?")[0] || "export";
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    toast({ kind: "error", key: "export-failed", message: "Export failed. Please try again.", detail: err instanceof Error ? err.message : undefined });
  }
}

function ExportMenu({
  params,
  columns,
}: {
  params: URLSearchParams;
  columns: ExpCol[];
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (columns.length && picked.length === 0)
      setPicked(columns.filter((c) => c.group === "summary").map((c) => c.key));
  }, [columns, picked.length]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPicking(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const exp = (format: string) => {
    const p = new URLSearchParams(params);
    p.set("format", format);
    if (picked.length) p.set("columns", picked.join(","));
    download(`/api/jobs/export?${p.toString()}`);
    setOpen(false);
  };

  const togglePick = (k: string) =>
    setPicked((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink-2 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5"
      >
        <Download className="h-4 w-4" /> Export
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-ink-2 shadow-2xl">
          {!picking ? (
            <div className="py-1.5">
              <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Export current results
              </p>
              <MenuItem icon={<FileSpreadsheet className="h-4 w-4 text-emerald-live" />} label="CSV (spreadsheet)" onClick={() => exp("csv")} />
              <MenuItem icon={<FileText className="h-4 w-4 text-rose-400" />} label="PDF (printable)" onClick={() => exp("pdf")} />
              <MenuItem icon={<FileJson className="h-4 w-4 text-amber-warn" />} label="JSON (data)" onClick={() => exp("json")} />
              <div className="my-1 border-t border-white/5" />
              <MenuItem
                icon={<Columns3 className="h-4 w-4 text-cyan-glow" />}
                label={`Choose columns (${picked.length})`}
                onClick={() => setPicking(true)}
              />
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto p-2">
              <div className="mb-1 flex items-center justify-between px-1">
                <button onClick={() => setPicking(false)} className="text-xs font-semibold text-brand hover:underline">
                  ‹ Back
                </button>
                <span className="text-[10px] text-slate-500">{picked.length} selected</span>
              </div>
              {["summary", "detail"].map((grp) => (
                <div key={grp} className="mb-1">
                  <p className="px-1 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{grp}</p>
                  {columns.filter((c) => c.group === grp).map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs text-slate-300 hover:bg-white/5">
                      <input aria-label="Includes" type="checkbox" checked={picked.includes(c.key)} onChange={() => togglePick(c.key)} className="h-3.5 w-3.5 accent-brand" />
                      {c.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/5"
    >
      {icon}
      {label}
    </button>
  );
}

/* --------------------- per-row export (PDF / JSON / print) --------------- */
function RowExportMenu({
  jobId,
  jobNumber,
}: {
  jobId: string;
  jobNumber: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Export / print this job"
        className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-slate-400 hover:border-brand/40 hover:text-white"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-ink-2 py-1.5 shadow-2xl">
          <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Job {jobNumber}
          </p>
          <MenuItem
            icon={<FileText className="h-4 w-4 text-rose-400" />}
            label="PDF detail"
            onClick={() => {
              download(`/api/jobs/${jobId}/export?format=pdf`);
              setOpen(false);
            }}
          />
          <MenuItem
            icon={<FileJson className="h-4 w-4 text-amber-warn" />}
            label="JSON"
            onClick={() => {
              download(`/api/jobs/${jobId}/export?format=json`);
              setOpen(false);
            }}
          />
          <MenuItem
            icon={<Printer className="h-4 w-4 text-cyan-glow" />}
            label="Print"
            onClick={() => {
              window.open(`/api/jobs/${jobId}/export?format=pdf`, "_blank");
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function AssignModal({ booking, onClose, onDone }: any) {
  const { noun, nounPlural } = useWorkerNoun();
  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: async () => (await api.riders.$get()).json(),
  });
  const suggest = useQuery({
    queryKey: ["suggest", booking.id],
    queryFn: async () =>
      (await api.ai["suggest-tech"][":bookingId"].$post({
        param: { bookingId: booking.id },
      })).json(),
  });
  const assign = useMutation({
    mutationFn: async (riderId: string) =>
      api.bookings[":id"].assign.$post({
        param: { id: booking.id },
        json: { riderId },
      }),
    onSuccess: onDone,
  });

  const list = (riders.data?.riders ?? []).filter(
    (r: any) => r.status !== "offline",
  );
  const bestId = (suggest.data as any)?.best?.techId;
  const sug = suggest.data as any;
  const rankInfo = new Map<string, { rank: number; rationale: string | null }>(
    ((sug?.ranked ?? []) as any[]).map((x, i) => [
      x.techId,
      { rank: i + 1, rationale: x.rationale ?? null },
    ]),
  );
  // show the ranked order the recommendation actually produced
  const ordered = [...list].sort(
    (a: any, b: any) =>
      (rankInfo.get(a.id)?.rank ?? 99) - (rankInfo.get(b.id)?.rank ?? 99),
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      {...dismiss(onClose)}
    >
      <DialogPanel onClose={onClose} label={`Assign ${noun.toLowerCase()}`} className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div>
            <h3 className="font-bold text-white">Assign {noun.toLowerCase()}</h3>
            <p className="text-xs text-slate-500">
              {booking.title || booking.service?.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {sug?.reasoning && (
          <div className="mx-4 mt-4 rounded-xl border border-brand/20 bg-brand/5 p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-glow" />
              <span className="text-[10px] font-bold uppercase tracking-wide text-cyan-glow">
                {sug.source === "ai" ? "AI dispatch" : "Best match"}
              </span>
              {sug.typicalMins ? (
                <span className="text-[10px] text-slate-500">
                  · usually ~{sug.typicalMins} min on site
                </span>
              ) : null}
            </div>
            <span className="text-slate-300">{sug.reasoning}</span>
          </div>
        )}

        <div className="max-h-[55vh] space-y-2 overflow-y-auto p-4">
          {riders.isLoading ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No available {nounPlural.toLowerCase()} online
            </p>
          ) : (
            ordered.map((r: any) => (
              <button
                key={r.id}
                disabled={assign.isPending}
                onClick={() => assign.mutate(r.id)}
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${
                  r.id === bestId
                    ? "border-brand/50 bg-brand/10"
                    : "border-white/10 hover:border-brand/40 hover:bg-white/5"
                }`}
              >
                <TechAvatar
                  name={r.name}
                  photoUrl={r.photoUrl}
                  color={r.color}
                  className="h-10 w-10"
                  textClassName="text-sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="font-semibold text-slate-100">{r.name}</p>
                    {r.id === bestId && (
                      <span className="rounded-full bg-cyan-glow/15 px-1.5 py-0.5 text-[10px] font-bold text-cyan-glow">
                        AI PICK
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    {r.rating ? `★ ${r.rating.toFixed(1)}` : "New"} ·{" "}
                    {r.skillClass ?? r.vehicle ?? "Van"}
                  </p>
                  {rankInfo.get(r.id)?.rationale && (
                    <p className="mt-1 text-[11px] leading-snug text-slate-400">
                      {rankInfo.get(r.id)!.rationale}
                    </p>
                  )}
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    r.status === "available"
                      ? "bg-emerald-live/15 text-emerald-live"
                      : "bg-amber-warn/15 text-amber-warn"
                  }`}
                >
                  {r.status}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogPanel>
    </div>
  );
}
