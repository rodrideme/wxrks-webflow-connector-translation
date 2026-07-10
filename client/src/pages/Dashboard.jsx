import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import { wxrksProjectUrl } from "../wxrksLinks.js";
import { formatDateTime } from "../formatDate.js";
import { modeLabel, cadenceLabel } from "../runLabels.js";
import { useAuth } from "../context/AuthContext.jsx";
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
 * state when incomplete -- just a neutral "Optional" pill. "failed" is a
 * distinct third state from "not set up" -- something IS configured but
 * has actually stopped working (e.g. wxrks rejecting a regenerated key),
 * which needs to read as urgent (red), not the same neutral grey as never
 * having been set up at all.
 */
function ChecklistRow({ label, detail, complete, optional = false, failed = false, to }) {
  const variant = failed ? "error" : complete ? "success" : "draft";
  const pillLabel = failed ? "Failed" : complete ? "Done" : optional ? "Optional" : "Not set up";
  return (
    <div className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
      <StatusPill variant={variant} label={pillLabel} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink">{label}</div>
        <div className="mt-0.5 text-xs text-ink-faint">{detail}</div>
      </div>
      <Link to={to} className={linkClass + " flex-none text-[13px]"}>
        {failed ? "Reconnect" : complete ? "Manage" : "Set up"} →
      </Link>
    </div>
  );
}

export default function Dashboard() {
  const { logout } = useAuth();
  const [locales, setLocales] = useState(null);
  const [fieldsSummary, setFieldsSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [history, setHistory] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // wxrksConnected only means "a credential is stored" -- a key regenerated
  // on wxrks's own side silently invalidates the old one, so this re-checks
  // for real (same live check as Settings > wxrks connection) instead of
  // leaving the checklist showing "Done" for a connection that's actually
  // broken. null = not checked yet (or nothing to check).
  const [wxrksHealthy, setWxrksHealthy] = useState(null);

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
        if (settingsRes?.wxrksConnected) {
          api.testWxrksConnection().then((res) => setWxrksHealthy(res.ok)).catch(() => setWxrksHealthy(false));
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-ink-soft">Loading dashboard...</p>;
  if (error) return <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>;

  const timezone = settings?.timezone;
  const recentRuns = history.slice(0, 3);
  const activeAutomations = automations.filter((a) => a.enabled && !a.archived);
  const runningAutomations = activeAutomations.slice(0, 3);
  const webhookStatuses = [settings?.autoSyncWebhook?.status, settings?.sitePublishWebhook?.status].filter(Boolean);
  const webhooksAllActive = webhookStatuses.length > 0 && webhookStatuses.every((s) => s === "active");
  const webhooksFailed = webhookStatuses.some((s) => s !== "active" && s !== "not_registered");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">Dashboard</h1>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Setup</p>
        <Card className="mb-8">
          <ChecklistRow
            label="Webflow connected"
            detail={
              <span>
                <span className="block">
                  {locales?.site?.displayName ? `${locales.site.displayName} — ${locales.site.url}` : "Connected"}
                </span>
                <span className="mt-0.5 block">
                  You're already connected — this app supports one Webflow site per login. To switch sites,{" "}
                  <button type="button" onClick={logout} className="font-medium text-accent-text hover:underline">
                    sign out
                  </button>{" "}
                  and sign back in with the other one.
                </span>
              </span>
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
            label="We automatically mapped out the translatable fields"
            detail={
              fieldsSummary
                ? `We selected ${fieldsSummary.totalTranslatableFields} fields across ${fieldsSummary.collectionCount} collections that will be sent to translation` +
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
            detail={
              !settings?.wxrksConnected
                ? "Not connected"
                : wxrksHealthy === false
                ? "wxrks rejected these credentials — they may have been regenerated. Reconnect below."
                : settings.wxrksAccessKeyMasked
            }
            complete={Boolean(settings?.wxrksConnected) && wxrksHealthy !== false}
            failed={Boolean(settings?.wxrksConnected) && wxrksHealthy === false}
            to="/settings/wxrks"
          />
          <ChecklistRow
            label="Webhook health"
            detail={
              activeAutomations.length === 0
                ? "Optional — enables automations to catch new/changed content automatically."
                : webhooksFailed
                ? "One or more webhooks stopped responding — this retries automatically every hour, or reconnect now."
                : webhooksAllActive
                ? "Webflow webhooks are healthy."
                : "Setting up…"
            }
            complete={activeAutomations.length > 0 && webhooksAllActive}
            optional={activeAutomations.length === 0}
            failed={activeAutomations.length > 0 && webhooksFailed}
            to="/runs"
          />
          <ChecklistRow
            label="Timezone & work unit naming (optional)"
            detail="Set the timezone used for schedules and timestamps, and how wxrks names each translated resource."
            complete
            optional
            to="/settings/account"
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
                    <div key={p.wxrksProjectUUID} className="border-t border-border px-4 py-3 first:border-t-0">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                          {modeLabel(p.mode, p.automationName)}
                        </span>
                        {errCount > 0 ? (
                          <StatusPill variant="error" label={`${errCount} error${errCount === 1 ? "" : "s"}`} />
                        ) : (
                          <StatusPill variant="success" label="Delivered" />
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[11.5px] text-ink-faint">
                        <span>{formatDateTime(p.createdAt, timezone)}</span>
                        <span className="font-mono tabular-nums">
                          {delivered.toLocaleString()} / {total.toLocaleString()} words
                        </span>
                        <a href={wxrksProjectUrl(p.wxrksProjectUUID)} target="_blank" rel="noreferrer" className={linkClass + " ml-auto"}>
                          wxrks ↗
                        </a>
                        <Link to={`/runs#${p.wxrksProjectUUID}`} className={linkClass}>
                          Runs
                        </Link>
                      </div>
                      {p.mode === "automation" &&
                        (() => {
                          const auto = automations.find((a) => a.name === p.automationName);
                          return auto ? (
                            <div className="mt-0.5 truncate text-[11px] text-ink-faint">
                              Project name: <span className="font-mono">{auto.projectName || `Automation "${auto.name}" · <send time>`}</span>
                            </div>
                          ) : null;
                        })()}
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
                  <div key={a.id} className="border-t border-border px-4 py-3 first:border-t-0">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{a.name}</span>
                      <StatusPill variant="success" label="Running" />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11.5px] text-ink-faint">
                      <span>{cadenceLabel(a.cadence)}</span>
                      {a.pendingCount > 0 && <span className="font-mono">{a.pendingCount} pending</span>}
                      <Link to={`/runs#automation-${a.id}`} className={linkClass + " ml-auto"}>
                        Runs
                      </Link>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-faint">
                      Project name: <span className="font-mono">{a.projectName || `Automation "${a.name}" · <send time>`}</span>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card accent className="p-5">
            <h3 className="text-[13.5px] font-semibold text-ink">Sync entire website</h3>
            <p className="mt-1 text-xs text-ink-faint">Send everything on your site to wxrks for translation in one go.</p>
            <Link
              to="/translate?autoSend=1"
              className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong"
            >
              Sync entire website →
            </Link>
          </Card>

          <Card className="p-5">
            <h3 className="text-[13.5px] font-semibold text-ink">Webflow Localization best practices (optional)</h3>
            <p className="mt-1 text-xs text-ink-faint">
              Understand the pros and cons of a full-site sync vs. managing content individually.
            </p>
            <a
              href="/docs/translating-content.html#sync-modes"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-[13px] font-medium text-accent-text hover:underline"
            >
              Read more →
            </a>
          </Card>
        </div>
      </div>
    </div>
  );
}
