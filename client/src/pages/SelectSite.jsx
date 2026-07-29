import { useState } from "react";
import { Navigate } from "react-router-dom";
import api from "../services/api.js";
import dataCache from "../services/dataCache.js";
import { useAuth } from "../context/AuthContext.jsx";
import Card from "../components/Card.jsx";
import LoadingState from "../components/LoadingState.jsx";

/**
 * Post-OAuth site picker (see routes/auth.js's callback redirect). A
 * Webflow OAuth grant is CUMULATIVE -- introspection lists every site this
 * user ever authorized, not just the one they meant this time -- so the
 * server never guesses: any user with more than one account lands here and
 * says which environment this session is for. Also reachable any time via
 * the sidebar switcher's underlying endpoint. The chosen account is
 * applied with a full page load (not a client-side navigate): every page
 * holds fetched state outside the dataCache too, and remounting the world
 * is the only thing that makes stale cross-account state impossible.
 */
export default function SelectSite() {
  const { loading, user, account, accounts } = useAuth();
  const [submittingId, setSubmittingId] = useState(null);
  const [error, setError] = useState(null);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <LoadingState label="Loading" />
      </div>
    );
  }
  if (!user || accounts.length <= 1) {
    return <Navigate to="/" replace />;
  }

  // Newest first -- the account a user just OAuth'd for the first time is
  // almost always the newest one, i.e. the one they came for.
  const sorted = [...accounts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  async function choose(target) {
    setSubmittingId(target.id);
    setError(null);
    try {
      if (target.id !== account.id) {
        await api.switchAccount(target.id);
      }
      dataCache.clearAll();
      window.location.assign("/");
    } catch (err) {
      setError(err.message);
      setSubmittingId(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-8">
        <img src="/wxrks-logo.svg" alt="wxrks" className="mx-auto mb-4 h-12 w-12" />
        <h1 className="text-center text-[17px] font-semibold text-ink">Choose a site</h1>
        <p className="mt-1.5 text-center text-[13px] text-ink-faint">
          Your Webflow login has access to more than one connected site. Pick the one to work on --
          you can switch any time from the sidebar.
        </p>

        {error && <p className="mt-3 text-center text-sm font-medium text-status-error-fg">Error: {error}</p>}

        <div className="mt-5 flex flex-col gap-2">
          {sorted.map((a) => {
            const host = a.siteUrl ? a.siteUrl.replace(/^https?:\/\//, "") : null;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => choose(a)}
                disabled={submittingId !== null}
                className="flex w-full items-center gap-3 rounded-md border border-border-strong bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">{a.name || host || "Unnamed site"}</div>
                  {host && <div className="truncate text-[11px] text-ink-faint">{host}</div>}
                </div>
                {a.id === account.id && (
                  <span className="flex-none text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Current</span>
                )}
                {submittingId === a.id && <span className="flex-none text-[11px] text-ink-faint">Switching…</span>}
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
