import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import Modal from "./Modal.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-5 py-2 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint";

function baseLang(code) {
  return code.toLowerCase().replace("_", "-").split("-")[0];
}

const CADENCE_OPTIONS = [
  { value: "hourly", label: "Hourly", desc: "Several times a day" },
  { value: "daily", label: "Daily", desc: "Once every day" },
  { value: "weekly", label: "Weekly", desc: "Once a week" },
];
const TIME_OPTIONS = ["00:00", "06:00", "08:00", "09:00", "12:00", "15:00", "18:00", "22:00"];
const WEEKDAY_OPTIONS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function cadenceSummary(cadence) {
  if (cadence.kind === "hourly") return `Runs every ${cadence.everyHours} hour${cadence.everyHours > 1 ? "s" : ""}, from ${cadence.startTime}`;
  if (cadence.kind === "weekly") return `Runs every ${cadence.weekday} at ${cadence.time}`;
  return `Runs every day at ${cadence.time}`;
}

// Real wxrks work-unit workflow values (POST /project/:uuid/work-unit?bulk=true's `workflows` array).
// TRANSLATION is always first and can't be removed; the rest are optional add-on steps.
const WORKFLOW_LABELS = {
  TRANSLATION: "Automatic Translation",
  PROOFREADING: "Proofreading",
  REVIEW: "Review",
  REVIEW_2: "Review 2",
  REVIEW_3: "Review 3",
  ICR: "ICR",
  REGIONAL_APPROVAL: "Regional Approval",
  DTP: "DTP",
};
const WORKFLOW_ORDER = Object.keys(WORKFLOW_LABELS);

/**
 * The redesign's single "Send to wxrks" flow -- Settings → Run → Review --
 * handling both a one-time send and recurring-automation creation, decided
 * at the Run step. Replaces the old separate NewAutomationModal; one-time
 * sends call the existing per-entity-kind item-sync endpoints (sequentially
 * per kind/leaf, since this app creates one wxrks project per sync call --
 * a selection spanning multiple collections/kinds becomes multiple
 * projects/jobs). Each call returns a jobId immediately (processing
 * continues in the background -- large sends can take minutes), handed to
 * the parent via onJobsStarted to poll and show real progress + cancel.
 * Recurring creates one `automations` row via the contentScope this modal
 * builds from the current selection.
 */
export default function SendToWxrksModal({ open, onClose, scope, selection, allSummary, ruleBased, onJobsStarted, onRecurringCreated }) {
  const { account } = useAuth();
  const wxrksConnected = account?.wxrksConnected;
  const [settings, setSettings] = useState(null);
  const [orgUnits, setOrgUnits] = useState([]);
  const [webflowLocales, setWebflowLocales] = useState(null);
  const [orgUnitResources, setOrgUnitResources] = useState(null);
  const [orgUnitResourcesLoading, setOrgUnitResourcesLoading] = useState(false);

  const [step, setStep] = useState(0);
  const [orgUnitUUID, setOrgUnitUUID] = useState("");
  const [targetLocales, setTargetLocales] = useState([]);
  const [reviewStep, setReviewStep] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [advOpen, setAdvOpen] = useState(false);

  const [runMode, setRunMode] = useState("now"); // "now" | "auto"
  const [cadenceKind, setCadenceKind] = useState("daily");
  const [everyHours, setEveryHours] = useState(6);
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("Mon");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [workflowSteps, setWorkflowSteps] = useState(["TRANSLATION"]);
  const [addStepOpen, setAddStepOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (!wxrksConnected) {
      // Nothing to fetch or submit without wxrks credentials -- the render
      // below shows a "connect first" message instead of the picker.
      setStep(0);
      setError(null);
      return;
    }
    api.getSettings().then((s) => {
      setSettings(s);
      setOrgUnitUUID(s.orgUnitUUID || "");
      setTargetLocales(s.targetLocales || []);
      if (s.orgUnitUUID) loadOrgUnitResources(s.orgUnitUUID);
    });
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getWebflowLocales().then(setWebflowLocales).catch(() => setWebflowLocales(null));
    setOrgUnitResources(null);
    setStep(0);
    setRunMode("now");
    setCadenceKind("daily");
    setTime("09:00");
    setEveryHours(6);
    setWeekday("Mon");
    setIncludeExisting(false);
    setProjectName("");
    setAdvOpen(false);
    setWorkflowSteps(["TRANSLATION"]);
    setAddStepOpen(false);
    setError(null);
  }, [open]);

  function addWorkflowStep(step) {
    setWorkflowSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
    setAddStepOpen(false);
  }

  function removeWorkflowStep(step) {
    setWorkflowSteps((prev) => prev.filter((s) => s !== step));
  }

  function loadOrgUnitResources(uuid) {
    setOrgUnitResourcesLoading(true);
    api
      .getOrgUnitResources(uuid)
      .then(setOrgUnitResources)
      .catch(() => setOrgUnitResources(null))
      .finally(() => setOrgUnitResourcesLoading(false));
  }

  function selectOrgUnit(uuid) {
    setOrgUnitUUID(uuid);
    const org = orgUnits.find((o) => o.uuid === uuid);
    if (org && webflowLocales) {
      const orgBaseLangs = new Set(org.targetLanguages.map(baseLang));
      setTargetLocales(webflowLocales.secondary.filter((l) => orgBaseLangs.has(baseLang(l.tag))).map((l) => l.tag));
    }
    setOrgUnitResources(null);
    if (uuid) loadOrgUnitResources(uuid);
  }

  function toggleLocale(tag) {
    setTargetLocales((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  const cadence =
    cadenceKind === "hourly" ? { kind: "hourly", everyHours, startTime: time } : cadenceKind === "weekly" ? { kind: "weekly", weekday, time } : { kind: "daily", time };

  const contentLabel = scope === "all" ? "All site content" : selection?.groups?.map((g) => g.label).join(", ") || "Content";
  const contentCount = scope === "all" ? allSummary?.totalItems ?? 0 : selection?.count ?? 0;
  const contentWords = scope === "all" ? allSummary?.totalWords ?? 0 : selection?.words ?? 0;

  async function handleNext() {
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    await handleSubmit();
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      if (runMode === "auto") {
        const contentScope =
          scope === "all"
            ? { scope: "all" }
            : { scope: "leaves", leaves: selection.groups.map((g) => ({ kind: g.kind, id: g.leafId, filters: g.filters || [] })) };
        // Always pass this automation's own org unit/target locales
        // explicitly, rather than only when they differ from the account's
        // stored default -- makes every new automation fully self-contained
        // instead of silently depending on a "global default" that has no
        // dedicated editing UI anymore (see Settings.jsx).
        const automation = await api.createAutomation({
          name: `${contentLabel} · ${new Date().toLocaleDateString()}`,
          contentScope,
          cadence,
          workflows: workflowSteps,
          projectName: projectName || null,
          includeExisting,
          orgUnitOverride: orgUnitUUID,
          targetLocalesOverride: targetLocales,
        });
        onRecurringCreated?.(automation);
        // "Include existing content on the first run" backfills immediately
        // rather than waiting for the schedule -- when that backfill found
        // something to send, the server hands back a job to poll so the
        // wizard can show the same progress-bar-with-cancel UI a one-time
        // send already gets, instead of it happening invisibly.
        if (automation.firstSyncJob) {
          onJobsStarted([
            {
              jobId: automation.firstSyncJob.jobId,
              total: automation.firstSyncJob.total,
              wxrksProjectUUID: null,
              kind: "automation",
              label: contentLabel,
            },
          ]);
        }
        onClose();
        return;
      }

      // One-time: dispatch per kind/leaf -- each call now creates its wxrks
      // project and returns a jobId immediately (processing continues in
      // the background), rather than blocking until every item is done.
      // A selection spanning multiple kinds/leaves becomes multiple jobs/
      // projects, tracked together by the parent's job poller.
      const options = { workflows: workflowSteps, projectName: projectName || undefined, orgUnitUUID, targetLocales };
      const sourceGroups = (scope === "all" ? allSummary.groups : selection.groups).filter((g) => g.ids.length > 0);
      const jobs = [];
      for (const g of sourceGroups) {
        let res;
        if (g.kind === "collection") res = await api.syncItem(g.leafId, g.ids, options);
        else if (g.kind === "pagesFolder") res = await api.syncPagesItem(g.ids, options);
        else res = await api.syncComponentsItem(g.ids, options);
        jobs.push({ jobId: res.jobId, total: res.total, wxrksProjectUUID: res.wxrksProjectUUID, kind: g.kind, label: g.label });
      }
      onJobsStarted(jobs);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  if (!wxrksConnected) {
    return (
      <Modal open={open} onClose={onClose} title="Send for translation">
        <p className="text-sm text-ink-soft">
          This account hasn't connected a wxrks account yet. Connect one in{" "}
          <Link to="/settings" onClick={onClose} className="font-medium text-accent-text hover:underline">
            Settings
          </Link>{" "}
          before sending content for translation.
        </p>
      </Modal>
    );
  }

  if (!settings) return <Modal open={open} onClose={onClose} title="Send for translation"><p className="text-sm text-ink-faint">Loading…</p></Modal>;

  return (
    <Modal open={open} onClose={onClose} title="Send for translation" width="max-w-4xl">
      <div className="mb-5 flex items-center gap-2">
        {["Settings", "Run", "Review"].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => i <= step && setStep(i)}
              className={
                "flex h-6 w-6 items-center justify-center rounded-full font-mono text-xs font-semibold " +
                (i <= step ? "bg-ink text-canvas" : "border border-border-strong text-ink-faint")
              }
            >
              {i < step ? "✓" : i + 1}
            </button>
            <span className={"text-[13px] font-semibold " + (i === step ? "text-ink" : "text-ink-faint")}>{label}</span>
            {i < 2 && <span className="mx-2 h-px w-8 bg-border-strong" />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-soft">
            Org unit
            <select value={orgUnitUUID} onChange={(e) => selectOrgUnit(e.target.value)} className={inputClass}>
              <option value="">— select —</option>
              {orgUnits.map((o) => (
                <option key={o.uuid} value={o.uuid}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          {orgUnitUUID && (
            <div className="rounded-md border border-border bg-surface-sunken p-3 text-sm">
              {orgUnitResourcesLoading && <p className="text-xs text-ink-faint">Loading translation memories &amp; glossaries...</p>}
              {orgUnitResources && (
                <>
                  <p className="text-ink-soft">
                    <strong className="text-ink">Translation memories:</strong>{" "}
                    {orgUnitResources.translationMemories.length === 0
                      ? "none bound to this org unit"
                      : orgUnitResources.translationMemories.map((tm) => tm.name).join(", ")}
                  </p>
                  <p className="mt-1 text-ink-soft">
                    <strong className="text-ink">Glossaries:</strong>{" "}
                    {orgUnitResources.glossaries.length === 0
                      ? "none bound to this org unit"
                      : orgUnitResources.glossaries.map((g) => g.name).join(", ")}
                  </p>
                  <p className="mt-2 text-xs text-ink-faint">
                    Read-only — wxrks attaches these to each project automatically based on the org unit.
                  </p>
                </>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-sm font-medium text-ink-soft">Target languages · {targetLocales.length}</div>
            <div className="flex flex-wrap gap-1.5">
              {(webflowLocales?.secondary || []).map((l) => (
                <button
                  key={l.tag}
                  type="button"
                  onClick={() => toggleLocale(l.tag)}
                  title={l.displayName}
                  className={
                    "rounded border px-2 py-1 font-mono text-[10.5px] font-semibold " +
                    (targetLocales.includes(l.tag) ? "border-ink bg-ink text-canvas" : "border-dashed border-border-strong text-ink-faint")
                  }
                >
                  {l.tag.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium text-ink-soft">Workflow</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {workflowSteps.map((step, i) => (
                <div key={step} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-ink-faint">→</span>}
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-ink bg-ink px-3 py-1 text-xs font-semibold text-canvas">
                    <span className="font-mono text-[9px] opacity-60">{i + 1}</span>
                    {WORKFLOW_LABELS[step]}
                    {step !== "TRANSLATION" && (
                      <button
                        type="button"
                        onClick={() => removeWorkflowStep(step)}
                        aria-label={`Remove ${WORKFLOW_LABELS[step]}`}
                        className="ml-0.5 opacity-70 hover:opacity-100"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {workflowSteps.length < WORKFLOW_ORDER.length && (
                <div className="flex items-center gap-1.5">
                  <span className="text-ink-faint">→</span>
                  <button
                    type="button"
                    onClick={() => setAddStepOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 py-1 text-xs font-semibold text-ink-faint hover:border-ink-faint hover:text-ink"
                  >
                    + Add step
                  </button>
                </div>
              )}
            </div>
            {/* Rendered in normal flow (not an absolutely-positioned popover) so it
                can't get clipped by the modal body's overflow-y-auto -- it simply
                pushes the rest of the step content down instead. */}
            {addStepOpen && (
              <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg border border-border bg-surface-sunken p-2">
                {WORKFLOW_ORDER.filter((s) => !workflowSteps.includes(s)).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => addWorkflowStep(s)}
                    className="rounded-full border border-border-strong bg-surface px-3 py-1 text-xs font-semibold text-ink hover:border-ink-faint"
                  >
                    + {WORKFLOW_LABELS[s]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <button type="button" onClick={() => setAdvOpen((v) => !v)} className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <span className="text-ink-faint">{advOpen ? "▾" : "▸"}</span>Advanced — more settings
            </button>
            {advOpen && (
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={`${contentLabel} · ${new Date().toLocaleDateString()}`}
                className={inputClass + " mt-2"}
              />
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-ink-soft">When should content be sent for translation?</div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setRunMode("now")}
                className={"flex-1 rounded-lg border p-3 text-left " + (runMode === "now" ? "border-accent bg-accent-subtle" : "border-border")}
              >
                <div className="text-[13.5px] font-semibold text-ink">One-time send</div>
                <div className="mt-0.5 text-[11.5px] text-ink-faint">Send the selected content to wxrks and create one translation project.</div>
              </button>
              <button
                type="button"
                onClick={() => ruleBased && setRunMode("auto")}
                disabled={!ruleBased}
                className={
                  "flex-1 rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 " +
                  (runMode === "auto" ? "border-accent bg-accent-subtle" : "border-border")
                }
              >
                <div className="text-[13.5px] font-semibold text-ink">Recurring pull content automation</div>
                <div className="mt-0.5 text-[11.5px] text-ink-faint">Check for matching content on a schedule and send it to wxrks automatically.</div>
              </button>
            </div>
            {!ruleBased && (
              <p className="mt-2 rounded-md bg-status-progress-bg px-3 py-2 text-[11.5px] text-status-progress-fg">
                Recurring runs on conditions, not a fixed list. Select an entire collection/folder or use filters (not individual entries) to schedule it.
              </p>
            )}
          </div>

          {runMode === "auto" && (
            <div className="space-y-5 border-t border-border pt-4">
              <div>
                <div className="mb-2 text-sm font-medium text-ink-soft">How often should it check?</div>
                <div className="flex gap-2.5">
                  {CADENCE_OPTIONS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setCadenceKind(c.value)}
                      className={"flex-1 rounded-lg border p-2.5 text-left " + (cadenceKind === c.value ? "border-accent bg-accent-subtle" : "border-border")}
                    >
                      <div className="text-[13px] font-semibold text-ink">{c.label}</div>
                      <div className="text-[11px] text-ink-faint">{c.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 text-[13.5px]">
                {cadenceKind === "hourly" && (
                  <>
                    <span>Every</span>
                    <div className="flex items-center overflow-hidden rounded-md border border-border-strong">
                      <button type="button" onClick={() => setEveryHours((h) => Math.max(1, h - 1))} className="h-8 w-8 bg-surface-sunken text-base">
                        −
                      </button>
                      <span className="w-8 text-center font-mono text-sm font-semibold">{everyHours}</span>
                      <button type="button" onClick={() => setEveryHours((h) => Math.min(12, h + 1))} className="h-8 w-8 bg-surface-sunken text-base">
                        +
                      </button>
                    </div>
                    <span>hours, starting at</span>
                    <select value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-sm">
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {cadenceKind === "weekly" && (
                  <>
                    <span>Every</span>
                    <select value={weekday} onChange={(e) => setWeekday(e.target.value)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm">
                      {WEEKDAY_OPTIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <span>at</span>
                    <select value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-sm">
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {cadenceKind === "daily" && (
                  <>
                    <span>Every day at</span>
                    <select value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-sm">
                      {TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>

              <div className="rounded-lg bg-accent-subtle p-3.5 text-[13.5px] font-semibold text-ink">{cadenceSummary(cadence)}</div>

              <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                <input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} className="mt-0.5" />
                <span>
                  <div className="text-[13px] font-semibold text-ink">Include existing content on the first run</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-faint">Leave off to only translate future content.</div>
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
              Content · {contentCount} items · {contentWords.toLocaleString()} words
            </div>
            <div className="text-[13.5px] font-semibold text-ink">{contentLabel}</div>
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Run</div>
            <div className="text-[13.5px] font-semibold text-ink">{runMode === "auto" ? cadenceSummary(cadence) : "One-time send — now"}</div>
            <div className="mt-0.5 text-xs text-ink-faint">
              {runMode === "auto" ? (includeExisting ? "Includes existing content on first run" : "Future matching content only") : "Creates one translation project immediately"}
            </div>
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Translation</div>
            <div className="text-[13.5px] font-semibold text-ink">
              {orgUnits.find((o) => o.uuid === orgUnitUUID)?.name || "—"} · {targetLocales.length} languages
            </div>
            <div className="mt-0.5 text-xs text-ink-soft">Workflow: {workflowSteps.map((s) => WORKFLOW_LABELS[s]).join(" → ")}</div>
            <div className="mt-0.5 text-xs text-ink-soft">Project name: {projectName || `${contentLabel} · ${new Date().toLocaleDateString()}`}</div>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <div className="mt-5 flex items-center gap-3 border-t border-border pt-4">
        <span className="text-xs text-ink-faint">Nothing is sent until you confirm.</span>
        <div className="ml-auto flex gap-2.5">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className={btnGhost}>
              Back
            </button>
          )}
          <button type="button" onClick={handleNext} disabled={submitting || targetLocales.length === 0 || !orgUnitUUID} className={btnPrimary}>
            {submitting
              ? "Sending…"
              : step === 2
              ? runMode === "auto"
                ? includeExisting
                  ? "Send to translation & create automation"
                  : "Create automation"
                : "Send to wxrks"
              : "Continue"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
