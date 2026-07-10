import { useEffect } from "react";

/**
 * Minimal overlay + centered panel -- no modal primitive existed anywhere
 * in this codebase before the Automation wizard needed one. Esc and
 * backdrop-click both close; styled consistently with Card.jsx's surface/
 * border/shadow tokens.
 *
 * `subheader` and `footer` are optional full-width bands (same width as
 * the title bar) sandwiching the scrollable body -- e.g. a wizard's step
 * indicator and its Back/Continue actions -- so they stay pinned and never
 * scroll away or get squeezed by the body's narrower content column.
 * `children` renders inside the body, which has its own tinted background
 * (`bg-surface-sunken`) and is capped narrower (`max-w-xl`, centered) than
 * the panel itself, so wide panels don't stretch form content edge-to-edge.
 * `height`, when given (e.g. `"h-[38rem]"`), fixes the panel's height so it
 * doesn't resize as a multi-step flow's content changes size between
 * steps -- the body scrolls internally instead. Omit it for a simple,
 * content-sized modal (the default).
 */
export default function Modal({ open, onClose, title, subheader, footer, children, width = "max-w-2xl", height }) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-10"
      style={{ backgroundColor: "rgba(10, 11, 20, 0.55)" }}
      onClick={onClose}
    >
      <div
        className={`flex ${height || ""} max-h-[85vh] w-full ${width} flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {subheader && <div className="flex-none border-b border-border px-5 py-3.5">{subheader}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken px-5 py-5">
          <div className="mx-auto max-w-xl">{children}</div>
        </div>
        {footer && <div className="flex-none border-t border-border bg-surface px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}
