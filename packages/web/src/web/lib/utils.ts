import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function money(n: number) {
  return `$${n.toFixed(2)}`;
}

export function fmtDate(d: string | number | Date) {
  return new Date(d).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDateShort(d: string | number | Date) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export const STATUS_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "Pending", color: "#fbbf24", bg: "rgba(245,158,11,0.14)" },
  confirmed: { label: "Confirmed", color: "#38bdf8", bg: "rgba(14,165,233,0.14)" },
  assigned: { label: "Assigned", color: "#c084fc", bg: "rgba(168,85,247,0.16)" },
  enroute: { label: "En route", color: "#22d3ee", bg: "rgba(34,211,238,0.14)" },
  arrived: { label: "On site", color: "#34d399", bg: "rgba(16,185,129,0.14)" },
  // A tech clocked in on site, and a tech who paused mid-job, are real booking
  // statuses the API returns. They were missing here, so every surface that
  // looks a status up (including the public tracking page) fell through to
  // printing the raw db value at the customer — "onsite", "paused".
  onsite: { label: "On site", color: "#34d399", bg: "rgba(16,185,129,0.14)" },
  paused: { label: "Paused", color: "#fbbf24", bg: "rgba(245,158,11,0.14)" },
  in_progress: { label: "In progress", color: "#fb923c", bg: "rgba(249,115,22,0.16)" },
  completed: { label: "Completed", color: "#34d399", bg: "rgba(16,185,129,0.16)" },
  cancelled: { label: "Cancelled", color: "#f87171", bg: "rgba(239,68,68,0.16)" },
};

/** Technician live status (fleet map) */
export const TECH_STATUS: Record<
  string,
  { label: string; color: string }
> = {
  available: { label: "Available", color: "#10b981" },
  enroute: { label: "En Route", color: "#0ea5e9" },
  onsite: { label: "On Site", color: "#f59e0b" },
  busy: { label: "Busy", color: "#f59e0b" },
  break: { label: "Break", color: "#a855f7" },
  offline: { label: "Offline", color: "#64748b" },
};

export const PRIORITY_META: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: "#64748b" },
  normal: { label: "Normal", color: "#0ea5e9" },
  high: { label: "High", color: "#f59e0b" },
  urgent: { label: "Urgent", color: "#ef4444" },
};

/**
 * a11y helpers for non-semantic interactive elements.
 *
 * Prefer a real <button>/<a>. When layout forces a clickable <div> (cards,
 * rows, table cells), spread `activate(fn)` so the element is keyboard
 * operable (Enter/Space) and announced as a button.
 */
export function activate(fn: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: import("react").KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    },
  };
}

/**
 * For full-screen dismiss overlays/backdrops: clickable to close and also
 * closes on Escape, without being announced as a control (presentational).
 *
 * Bug-hardened against drag-to-select text inside modal:
 * When user drag-selects text, mousedown fires inside the modal but mouseup
 * can land on the backdrop — browser synthesises a click on the backdrop,
 * making target===currentTarget true and incorrectly closing the modal.
 * Fix: track where mousedown started; only close if BOTH mousedown AND
 * mouseup originated on the backdrop itself (not inside modal content).
 */
export function dismiss(onClose: () => void) {
  let mouseDownOnBackdrop = false;
  return {
    onMouseDown: (e: import("react").MouseEvent) => {
      mouseDownOnBackdrop = e.target === e.currentTarget;
    },
    onMouseUp: (e: import("react").MouseEvent) => {
      if (!mouseDownOnBackdrop) return;
      if (e.target === e.currentTarget) onClose();
      mouseDownOnBackdrop = false;
    },
    // Keep onClick only for keyboard-triggered synthetic clicks (e.g. Space/Enter on a button)
    // but guard it so a drag that ends on backdrop doesn't double-fire.
    onClick: (e: import("react").MouseEvent) => {
      // Only synthetic (keyboard-triggered) clicks have detail === 0
      if (e.detail === 0 && e.target === e.currentTarget) onClose();
    },
    onKeyDown: (e: import("react").KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    role: "button" as const,
    tabIndex: -1,
    "aria-label": "Dismiss",
  };
}
