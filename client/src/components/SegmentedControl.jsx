/**
 * A pill-group switch for a small, closed set of options (e.g. Select &
 * Send's "CMS Items | Pages | Components", or the Automation wizard's
 * content-scope picker).
 */
export default function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            "rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition-colors " +
            (value === opt.value ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
