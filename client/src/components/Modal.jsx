import { useEffect } from "react";

/**
 * Minimal overlay + centered panel -- no modal primitive existed anywhere
 * in this codebase before the Automation wizard needed one. Esc and
 * backdrop-click both close; styled consistently with Card.jsx's surface/
 * border/shadow tokens.
 */
export default function Modal({ open, onClose, title, children, width = "max-w-2xl" }) {
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
        className={`flex max-h-[85vh] w-full ${width} flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card`}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
}
