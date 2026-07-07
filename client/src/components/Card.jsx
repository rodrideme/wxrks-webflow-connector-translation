/**
 * The one card surface used everywhere -- plain by default (read screens:
 * Dashboard, History, Settings), or with a top accent stripe when `accent`
 * is set (act screens: Sync Panel's launch console), so "this triggers
 * something" is visually distinct from "this is just information."
 */
export default function Card({ accent = false, className = "", children }) {
  return (
    <div
      className={
        "overflow-hidden rounded-lg border border-border bg-surface shadow-card " +
        (accent ? "border-t-[3px] border-t-accent " : "") +
        className
      }
    >
      {children}
    </div>
  );
}
