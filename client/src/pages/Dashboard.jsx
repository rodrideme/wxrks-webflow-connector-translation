import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";
import { modeLabel, cadenceLabel } from "../runLabels.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import Chip from "../components/Chip.jsx";

const linkClass = "font-medium text-accent-text hover:underline";

function projectErrorCount(p) {
  return (p.updates || []).reduce(
    (sum, u) =>
      sum + (u.resultsByItem || []).reduce((s, r) => s + (r.resultsByLocale || []).filter((rl) => rl.error).length, 0),
    0
  );
}

function projectWordsDelivered(p) {
  return (p.updates || []).reduce((sum, u) => sum + (u.wordCount || 0), 0);
}

function projectTotalWords(p) {
  return (p.items || []).reduce((sum, i) => sum + (i.wordCount || 0), 0);
}

/**
 * Checklist row: a StatusPill + label + detail text + a link to the
 * relevant Settings tab. "Optional" rows never render as an error/blocking
 * state when incomplete -- just a neutral "Optional" pill.
 */
function ChecklistRow({ label, detail, complete, optional = false, to }) {
  return (
    <div className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
      <StatusPill variant={complete ? "success" : "draft"} label={complete ? "Done" : optional ? "Optional" : "Not set up"} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink">{label}</div>
        <div className="mt-0.5 text-xs text-ink-faint">{detail}</div>
      </div>
      <Link to={to} className={linkClass + " flex-none text-[13px]"}>
        {complete ? "Manage" : "Set up"} →
      </Link>
    </div>
  );
}

export default function Dashboard() {
  const [locales, setLocales] = useState(null);
  const [fieldsSummary, setFieldsSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [history, setHistory] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getWebflowLocales().catch(() => null),
      api.getFieldsSummary().catch(() => null),
      api.getSettings().catch(() => null),
      api.getSyncHistory().catch(() => ({ history: [] })),
      api.listAutomations().catch(() => ({ automations: [] })),
    ])
      .then(([localesRes, fieldsRes, settingsRes, historyRes, automationsRes]) => {
        setLocales(localesRes);
        setFieldsSummary(fieldsRes);
        setSettings(settingsRes);
        setHistory(historyRes.history || []);
        setAutomations(automationsRes.automations || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-ink-soft">Loading dashboard...</p>;
  if (error) return <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>;

  const timezone = settings?.timezone;
  const recentRuns = history.slice(0, 3);
  const runningAutomations = automations.filter((a) => a.enabled && !a.archived).slice(0, 3);

  return (
    <div>
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">Dashboard</h1>

      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Setup</p>
      <Card className="mb-8">
        <ChecklistRow
          label="Webflow connected"
          detail={
            locales?.site?.displayName
              ? `${locales.site.displayName} — ${locales.site.url}`
              : "Connected"
          }
          complete
          to="/settings/account"
        />
        <ChecklistRow
          label="Localization enabled"
          detail={
            (locales?.secondary || []).length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {locales.secondary.map((l) => (
                  <Chip key={l.tag}>{l.tag}</Chip>
                ))}
              </span>
            ) : (
              "No secondary locales enabled yet"
            )
          }
          complete={(locales?.secondary || []).length > 0}
          to="/settings/account"
        />
        <ChecklistRow
          label="Automatic field adjustment"
          detail={
            fieldsSummary
              ? `${fieldsSummary.totalTranslatableFields} fields across ${fieldsSummary.collectionCount} collections auto-selected` +
                (fieldsSummary.excludedFieldCount > 0
                  ? ` (${fieldsSummary.excludedFieldCount} excluded in ${fieldsSummary.collectionsWithExclusions} collection${fieldsSummary.collectionsWithExclusions === 1 ? "" : "s"})`
                  : "")
              : "—"
          }
          complete
          to="/settings/fields"
        />
        <ChecklistRow
          label="wxrks connected"
          detail={settings?.wxrksConnected ? settings.wxrksAccessKeyMasked : "Not connected"}
          complete={Boolean(settings?.wxrksConnected)}
          to="/settings/wxrks"
        />
        <ChecklistRow
          label="LLM connector (optional)"
          detail={
            settings?.llmConnected
              ? settings.llmApiKeyMasked
              : "Optional — enables transliteration fallback and future marketing features"
          }
          complete={Boolean(settings?.llmConnected)}
          optional
          to="/settings/llm"
        />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Latest runs</p>
          <Card>
            {recentRuns.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No runs yet.</p>
            ) : (
              recentRuns.map((p) => {
                const errCount = projectErrorCount(p);
                const delivered = projectWordsDelivered(p);
                const total = projectTotalWords(p);
                return (
                  <div key={p.wxrksProjectUUID} className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ink">{modeLabel(p.mode, p.automationName)}</div>
                      <div className="mt-0.5 text-[11px] text-ink-faint">{formatDateTime(p.createdAt, timezone)}</div>
                    </div>
                    {errCount > 0 ? (
                      <StatusPill variant="error" label={`${errCount} error${errCount === 1 ? "" : "s"}`} />
                    ) : (
                      <StatusPill variant="success" label="Delivered" />
                    )}
                    <div className="text-[12px] text-ink-soft">
                      <span className="font-mono font-semibold tabular-nums text-ink">{delivered.toLocaleString()}</span> /{" "}
                      <span className="font-mono tabular-nums">{total.toLocaleString()}</span> words
                    </div>
                    <div className="ml-auto flex gap-3 whitespace-nowrap text-xs">
                      <a href={wxrksProjectUrl(p.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass}>
                        wxrks ↗
                      </a>
                      <Link to={`/runs#${p.wxrksProjectUUID}`} className={linkClass}>
                        Runs
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Running automations</p>
          <Card>
            {runningAutomations.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No automations running.</p>
            ) : (
              runningAutomations.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-ink">{a.name}</div>
                    <div className="mt-0.5 text-[11px] text-ink-faint">{cadenceLabel(a.cadence)}</div>
                  </div>
                  <StatusPill variant="success" label="Running" />
                  {a.pendingCount > 0 && (
                    <span className="font-mono text-[11.5px] text-ink-faint">{a.pendingCount} pending</span>
                  )}
                  <Link to={`/runs#automation-${a.id}`} className={linkClass + " ml-auto text-xs"}>
                    Runs
                  </Link>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
