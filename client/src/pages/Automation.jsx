import { useEffect, useState } from "react";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import StatusPill from "../components/StatusPill.jsx";
import NewAutomationModal from "../components/NewAutomationModal.jsx";
import { formatDateTime } from "../formatDate.js";

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong";
const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

function scopeSummary(scope) {
  if (scope.type === "all") return "All content";
  if (scope.type === "cms") {
    return scope.allCollectionsEnabled ? "All collections" : `${scope.enabledCollectionIds.length} collection(s)`;
  }
  if (scope.type === "pages") return `${scope.pageFolderIds.length} folder(s)`;
  return "All components";
}

function webhookPill(status) {
  if (status === "active") return <StatusPill variant="success" label="Webhook active" />;
  if (status === "not_registered") return <StatusPill variant="draft" label="Webhook not registered" />;
  return <StatusPill variant="error" label={`Webhook ${status.replace("_", " ")}`} />;
}

export default function Automation() {
  const [automations, setAutomations] = useState(null);
  const [webhook, setWebhook] = useState(null);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState(null);
  const [reregistering, setReregistering] = useState(false);

  function load() {
    api
      .listAutomations()
      .then((res) => {
        setAutomations(res.automations || []);
        setWebhook(res.webhook);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(load, []);

  function openCreate() {
    setEditingAutomation(null);
    setModalOpen(true);
  }

  function openEdit(automation) {
    setEditingAutomation(automation);
    setModalOpen(true);
  }

  async function togglePause(automation) {
    try {
      if (automation.enabled) {
        await api.pauseAutomation(automation.id);
      } else {
        await api.resumeAutomation(automation.id);
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(automation) {
    if (!window.confirm(`Delete automation "${automation.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteAutomation(automation.id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reregisterWebhook() {
    setReregistering(true);
    try {
      await api.reregisterAutoSyncWebhook();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setReregistering(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Automation</h1>
        <button onClick={openCreate} className={btnPrimary}>
          New automation
        </button>
      </div>

      {webhook && (
        <div className="mb-4 flex items-center gap-3">
          {webhookPill(webhook.status)}
          {webhook.status !== "active" && webhook.status !== "not_registered" && (
            <button onClick={reregisterWebhook} disabled={reregistering} className={linkButtonClass}>
              {reregistering ? "Registering..." : "Re-register webhook"}
            </button>
          )}
        </div>
      )}

      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      {automations === null ? (
        <p className="text-sm text-ink-faint">Loading...</p>
      ) : automations.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-ink-soft">No automations yet.</p>
          <button onClick={openCreate} className={btnPrimary + " mt-4"}>
            Create your first automation
          </button>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{a.name}</span>
                  <StatusPill variant={a.enabled ? "success" : "draft"} label={a.enabled ? "Running" : "Paused"} />
                </div>
                <div className="mt-0.5 text-xs text-ink-faint">
                  {scopeSummary(a.contentScope)} · sends {a.flushTimes.length}x/day
                  {a.pendingCount > 0 && ` · ${a.pendingCount} pending`}
                </div>
              </div>
              <div className="font-mono text-xs text-ink-faint">
                {a.enabled && a.nextFlushAt ? `Next: ${formatDateTime(a.nextFlushAt)}` : "—"}
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => togglePause(a)} className={linkButtonClass}>
                  {a.enabled ? "Pause" : "Resume"}
                </button>
                <button onClick={() => openEdit(a)} className={linkButtonClass}>
                  Edit
                </button>
                <button onClick={() => remove(a)} className="text-xs font-medium text-status-error-fg hover:underline">
                  Delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <NewAutomationModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={load}
        automation={editingAutomation}
      />
    </div>
  );
}
