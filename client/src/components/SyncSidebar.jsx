import Card from "./Card.jsx";
import Chip from "./Chip.jsx";

/**
 * The sticky recap card that sits beside a Translate screen's main content
 * (adopted from the Ledger reference's "Project template" sidebar) --
 * always shows what a launch would actually do (org unit, target locales,
 * workflow, volume) instead of that being buried above the fold in the
 * main column. `children` holds the mode-specific action area -- Bulk
 * Sync's preview/launch/progress/done buttons, or Item Sync's
 * ItemSyncAction (translate/confirm/running/done).
 */
export default function SyncSidebar({ orgUnitName, targetLocales, volumeLabel, children }) {
  return (
    <div className="sticky top-6 flex w-[19rem] flex-none flex-col gap-4">
      <Card>
        <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-ink">Sync recap</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5 text-[12.5px]">
          <div className="flex justify-between gap-3">
            <span className="text-ink-faint">Org unit</span>
            <span className="truncate font-medium text-ink">{orgUnitName || "—"}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <span className="text-ink-faint">Targets</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {targetLocales?.length > 0 ? (
                targetLocales.map((l) => <Chip key={l}>{l}</Chip>)
              ) : (
                <span className="text-ink-faint">not set</span>
              )}
            </div>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-faint">Workflow</span>
            <span className="font-medium text-ink">Translation</span>
          </div>
          <div className="h-px bg-border-strong/40" />
          <div className="flex justify-between gap-3">
            <span className="text-ink-faint">Volume</span>
            <span className="font-mono font-medium tabular-nums text-ink">{volumeLabel}</span>
          </div>
        </div>
        {children && <div className="flex flex-col gap-2.5 border-t border-border px-4 py-3.5">{children}</div>}
      </Card>
    </div>
  );
}
