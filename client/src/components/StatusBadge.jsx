const STYLES = {
  published: "bg-green-100 text-green-800",
  draft: "bg-amber-100 text-amber-800",
  missing: "bg-slate-100 text-slate-600",
};

const LABELS = {
  published: "Translated",
  draft: "Pending",
  missing: "Missing",
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
        (STYLES[status] || "bg-slate-100 text-slate-600")
      }
    >
      {LABELS[status] || status}
    </span>
  );
}
