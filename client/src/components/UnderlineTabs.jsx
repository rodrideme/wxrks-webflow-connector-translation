/**
 * Underline tab row for switching sync mode within a screen (Bulk Sync /
 * Item Sync / Auto Sync). Distinct from SegmentedControl -- this sits
 * inside a screen's topbar, not floating over a card.
 */
export default function UnderlineTabs({ options, value, onChange, className = "" }) {
  return (
    <div className={"flex gap-6 border-b border-border " + className}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            "border-b-2 pb-2.5 pt-0.5 text-[13px] font-semibold transition-colors " +
            (value === opt.value
              ? "border-accent text-accent-text"
              : "border-transparent text-ink-faint hover:text-ink-soft")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
