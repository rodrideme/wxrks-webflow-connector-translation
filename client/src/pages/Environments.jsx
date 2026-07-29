import { useEffect, useState } from "react";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import Card from "../components/Card.jsx";
import Chip from "../components/Chip.jsx";
import { formatDateTime } from "../formatDate.js";

function statusLabel(status) {
  if (status === "redeemed") return "Redeemed";
  if (status === "expired") return "Expired";
  if (status === "revoked") return "Revoked";
  return "Pending";
}

/**
 * Operator-only (see middleware/auth.js's requireOriginalAccount) --
 * provisions a brand-new, fully independent environment for another
 * company/workspace this app's "Sign in with Webflow" OAuth can never
 * reach on its own (an unapproved OAuth app only ever authorizes its own
 * registration workspace). Deliberately separate from the Teams page: the
 * environment created here is a completely independent account -- its own
 * Webflow connection, own settings, own members -- not a teammate added to
 * THIS account.
 */
export default function Environments() {
  const { account } = useAuth();
  const [environments, setEnvironments] = useState(null);
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newLink, setNewLink] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [timezone, setTimezone] = useState(undefined);
  const [error, setError] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [resettingId, setResettingId] = useState(null);
  const [resetResult, setResetResult] = useState(null);

  useEffect(() => {
    if (!account?.isOriginalAccount) return;
    api.listEnvironments().then((res) => setEnvironments(res.environments)).catch((err) => setError(err.message));
    api.listEnvironmentAccounts().then((res) => setAccounts(res.accounts)).catch((err) => setError(err.message));
    api.getSettings().then((s) => setTimezone(s.timezone)).catch(() => {});
  }, [account?.isOriginalAccount]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const created = await api.createEnvironment({ note: note || undefined });
      setNewLink(`${window.location.origin}/connect?invite=${created.token}`);
      setLinkCopied(false);
      setNote("");
      const res = await api.listEnvironments();
      setEnvironments(res.environments);
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(newLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  // What the operator must type to arm the reset button -- the site's
  // human-readable name when Webflow resolved one, else the raw site id.
  function confirmPhraseFor(env) {
    return env.siteName || env.webflowSiteId;
  }

  function startConfirming(env) {
    setConfirmingId(env.id);
    setConfirmText("");
    setResetResult(null);
    setError(null);
  }

  async function resetEnvironmentData(env) {
    setResettingId(env.id);
    setError(null);
    try {
      const result = await api.resetEnvironmentAccount(env.id, env.webflowSiteId);
      setResetResult({ env, result });
      setConfirmingId(null);
      setConfirmText("");
      const res = await api.listEnvironmentAccounts();
      setAccounts(res.accounts);
    } catch (err) {
      setError(err.message);
    } finally {
      setResettingId(null);
    }
  }

  async function revoke(id) {
    setRevokingId(id);
    try {
      const res = await api.revokeEnvironment(id);
      setEnvironments(res.environments);
    } catch (err) {
      setError(err.message);
    } finally {
      setRevokingId(null);
    }
  }

  if (!account?.isOriginalAccount) {
    return <p className="text-sm text-ink-faint">Not available for this account.</p>;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Environments</h1>
        <p className="mt-0.5 text-[13px] text-ink-faint">
          Provision an isolated environment for another company/workspace -- each one gets its own
          independent Webflow connection, settings, and members, entirely separate from yours.
        </p>
      </div>

      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <Card className="mb-5 p-5">
        <h2 className="mb-1 text-[13.5px] font-semibold text-ink">Provision a new environment</h2>
        <p className="text-xs text-ink-faint">
          "Sign in with Webflow" only reaches sites in this app's own workspace -- a Webflow
          platform restriction on unapproved OAuth apps. Generate a one-time link instead, and
          share it directly with whoever manages the other workspace.{" "}
          <a
            href="/docs/connecting-accounts.html#webflow-manual-token"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            How this works →
          </a>
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. the company or contact's name)"
            className="w-full max-w-sm rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="flex-none rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate link"}
          </button>
        </div>

        {newLink && (
          <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
            <p className="mb-2 text-xs font-medium text-status-error-fg">
              Copy this now -- you won't be able to see the full link again.
            </p>
            <div className="flex items-center gap-2">
              <input type="text" readOnly value={newLink} className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 font-mono text-xs text-ink" />
              <button
                type="button"
                onClick={copyLink}
                className="flex-none rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold hover:border-ink-faint"
              >
                {linkCopied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        {environments === null ? (
          <p className="p-4 text-sm text-ink-faint">Loading…</p>
        ) : environments.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No environments provisioned yet.</p>
        ) : (
          environments.map((env) => (
            <div key={env.id} className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-ink">{env.note || "Untitled"}</div>
                <div className="truncate font-mono text-xs text-ink-faint">{env.tokenMasked}</div>
              </div>
              <Chip>{statusLabel(env.status)}</Chip>
              <span className="w-36 flex-none text-right text-xs text-ink-faint">
                {env.status === "pending" ? `Expires ${formatDateTime(env.expiresAt, timezone)}` : formatDateTime(env.createdAt, timezone)}
              </span>
              {env.status === "pending" && (
                <button
                  type="button"
                  onClick={() => revoke(env.id)}
                  disabled={revokingId === env.id}
                  className="flex-none text-xs font-medium text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Revoke
                </button>
              )}
            </div>
          ))
        )}
      </Card>

      <div className="mb-2 mt-8">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">Connected environments</h2>
        <p className="mt-0.5 text-[13px] text-ink-faint">
          Every account currently connected to this app. Resetting one erases all of its connector
          data -- runs, history, automations, settings, members, and credentials -- and removes this
          app's webhooks from the Webflow site, so the next "Sign in with Webflow" goes through the
          full first-time setup again. The Webflow site itself (content, locales, published
          translations) is not touched, and projects already created on wxrks stay there.
        </p>
      </div>

      {resetResult && (
        <p className="mb-3 text-sm font-medium text-ink">
          Environment {confirmPhraseFor(resetResult.env)} was reset -- it now looks like a brand-new
          connection.
          {resetResult.result?.webhookTeardown?.ok === false &&
            " (Warning: its Webflow webhooks couldn't be removed automatically -- delete them in Webflow's site settings.)"}
        </p>
      )}

      <Card>
        {accounts === null ? (
          <p className="p-4 text-sm text-ink-faint">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No environments connected yet.</p>
        ) : (
          accounts.map((env) => (
            <div key={env.id} className="border-t border-border px-4 py-3 first:border-t-0">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">
                    {env.siteName || "Unknown site"}
                    {env.isOriginalAccount && (
                      <span className="ml-2 align-middle text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                        This account
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-ink-faint">{env.webflowSiteId}</div>
                </div>
                <Chip>{env.status === "active" ? "Connected" : env.status}</Chip>
                <span className="w-36 flex-none text-right text-xs text-ink-faint">
                  {formatDateTime(env.createdAt, timezone)}
                </span>
                {!env.isOriginalAccount && confirmingId !== env.id && (
                  <button
                    type="button"
                    onClick={() => startConfirming(env)}
                    className="flex-none text-xs font-medium text-status-error-fg hover:underline"
                  >
                    Reset…
                  </button>
                )}
              </div>

              {confirmingId === env.id && (
                <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
                  <p className="mb-2 text-xs text-ink">
                    This permanently erases all connector data for{" "}
                    <span className="font-semibold">{confirmPhraseFor(env)}</span>. Type{" "}
                    <span className="font-mono font-semibold">{confirmPhraseFor(env)}</span> to
                    confirm.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={confirmPhraseFor(env)}
                      className="w-full max-w-xs rounded-md border border-border-strong bg-surface px-3 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button
                      type="button"
                      onClick={() => resetEnvironmentData(env)}
                      disabled={confirmText !== confirmPhraseFor(env) || resettingId === env.id}
                      className="flex-none rounded-md bg-status-error-fg px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {resettingId === env.id ? "Resetting…" : "Erase environment data"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      disabled={resettingId === env.id}
                      className="flex-none text-xs font-medium text-ink-faint hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
