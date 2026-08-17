import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ok } from "../lib/api-ok";
import { Bell, CheckCheck } from "lucide-react";
import { fmtDate, dismiss } from "../lib/utils";

export function NotifBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const notifs = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => ok(await api.notifications.$get()),
    refetchInterval: 10000,
  });
  const items = notifs.data?.notifications ?? [];
  const unread = items.filter((n) => !n.read).length;

  const readAll = useMutation({
    mutationFn: async () => {
      await api.notifications["read-all"].$post();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
        aria-expanded={open}
        className="relative grid h-10 w-10 place-items-center rounded-full text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" {...dismiss(() => setOpen(false))} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-white/10 bg-ink-2 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <span className="font-bold text-white">Notifications</span>
              {unread > 0 && (
                <button
                  onClick={() => readAll.mutate()}
                  className="flex items-center gap-1 text-xs font-medium text-cyan-glow hover:underline"
                >
                  <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-500">
                  No notifications yet
                </p>
              ) : (
                items.map((n) => (
                  <div
                    key={n.id}
                    className={`border-b border-white/5 px-4 py-3 ${n.read ? "" : "bg-brand/5"}`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-slate-600" : "bg-cyan-glow"}`}
                      />
                      <div>
                        <p className="text-sm font-semibold text-white">{n.title}</p>
                        <p className="text-xs text-slate-400">{n.body}</p>
                        <p className="mt-0.5 text-[10px] text-slate-600">{fmtDate(n.createdAt)}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
