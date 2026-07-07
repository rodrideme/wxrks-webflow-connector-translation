/**
 * A real checkbox (keyboard/screen-reader accessible) styled as a small
 * switch -- used for the translatable-field / Auto Sync toggles in
 * Settings' disclosure rows.
 */
export default function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <label
      className={
        "relative inline-flex h-[17px] w-[30px] flex-none items-center " +
        (disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="peer sr-only"
        aria-label={label}
      />
      <span
        className={
          "pointer-events-none absolute inset-0 rounded-full border transition-colors " +
          "border-border-strong bg-surface-sunken peer-checked:border-accent peer-checked:bg-accent " +
          "peer-focus-visible:shadow-[0_0_0_2px_var(--canvas),0_0_0_4px_var(--accent)]"
        }
      />
      <span className="pointer-events-none absolute left-px h-[13px] w-[13px] rounded-full bg-surface transition-transform peer-checked:translate-x-[13px] peer-checked:bg-white" />
    </label>
  );
}
