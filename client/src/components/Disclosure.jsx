import { useState } from "react";

/**
 * The app's one pattern for nested/expandable content -- a chevron, an
 * indent rule connecting parent to child, and children that keep the same
 * row grammar as the parent. Used for Collections' field config + item
 * list and (structurally) anywhere else a list needs an expandable detail
 * instead of a new nested table/card.
 */
export function Disclosure({ summary, meta, defaultOpen = false, onOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);

  function handleClick() {
    setOpen((o) => {
      const next = !o;
      if (next) onOpen?.();
      return next;
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={handleClick}
        className="grid w-full grid-cols-[16px_1fr_auto] items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-sunken"
      >
        <span className={"text-[10px] text-ink-faint transition-transform " + (open ? "rotate-90" : "")}>▶</span>
        <span className="text-sm font-medium text-ink">{summary}</span>
        {meta && <span className="font-mono text-xs text-ink-faint tabular-nums">{meta}</span>}
      </button>
      {open && <div className="bg-surface-sunken">{children}</div>}
    </div>
  );
}

/**
 * One child row inside an open Disclosure -- indent rule + same grid
 * shape as the parent's chevron column, so every depth reads as "the same
 * kind of row," just indented.
 */
export function DisclosureRow({ children, trailing, className = "" }) {
  return (
    <div
      className={
        "grid grid-cols-[16px_1fr_auto] items-center gap-2.5 border-t border-border py-2.5 pl-3.5 pr-3.5 text-sm first:border-t-0 " +
        className
      }
    >
      <span className="mx-auto h-full w-px bg-border-strong" />
      <span className="min-w-0 text-ink">{children}</span>
      {trailing}
    </div>
  );
}
