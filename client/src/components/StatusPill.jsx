const VARIANTS = {
  draft: { fg: "text-status-draft-fg", bg: "bg-status-draft-bg", dot: "bg-status-draft-dot", label: "Draft" },
  progress: { fg: "text-status-progress-fg", bg: "bg-status-progress-bg", dot: "bg-status-progress-dot", label: "In Progress" },
  success: { fg: "text-status-success-fg", bg: "bg-status-success-bg", dot: "bg-status-success-dot", label: "Completed" },
  error: { fg: "text-status-error-fg", bg: "bg-status-error-bg", dot: "bg-status-error-dot", label: "Error" },
  auto: { fg: "text-status-auto-fg", bg: "bg-status-auto-bg", dot: "bg-status-auto-dot", label: "Auto-Sync Active" },
};

/**
 * The app's one status vocabulary -- five fixed variants, each a
 * hue + dot behavior, reused everywhere a sync/translation state is shown
 * (Dashboard project rows, Sync Panel per-locale cells, History outcomes,
 * Settings Auto Sync indicators). Only "auto" pulses its dot, since it's
 * the one state that's genuinely ongoing rather than settled.
 */
export default function StatusPill({ variant = "draft", label, className = "" }) {
  const v = VARIANTS[variant] || VARIANTS.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-1.5 pr-2.5 text-xs font-semibold leading-tight ${v.bg} ${v.fg} ${className}`}
    >
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${v.dot} ${variant === "auto" ? "status-pulse animate-pulse" : ""}`} />
      {label || v.label}
    </span>
  );
}
