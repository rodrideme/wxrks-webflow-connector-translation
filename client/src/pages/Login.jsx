import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const labelClass = "flex flex-col gap-1 text-left text-sm font-medium text-ink-soft";
const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

/**
 * Rendered by App.jsx instead of the router tree while logged out --
 * there's nothing else reachable, so no route/path is needed for this. The
 * OAuth button is a plain top-level navigation (not a fetch call): the
 * whole point of that flow is a real browser redirect to webflow.com and
 * back, which only a full navigation can do.
 *
 * The password form below it is only for accounts connected via
 * routes/connect.js's invite flow (a workspace OAuth can't reach) -- those
 * users have no "Sign in with Webflow" option at all, so this is their
 * only way back in. Collapsed behind a toggle rather than shown by
 * default, since it's the uncommon path.
 */
export default function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function submitPasswordLogin(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.loginWithPassword(email, password);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <img src="/wxrks-logo.svg" alt="wxrks" className="mx-auto mb-4 h-12 w-12" />
        <h1 className="text-[17px] font-semibold text-ink">wxrks Sync</h1>
        <p className="mt-1.5 text-[13px] text-ink-faint">Sign in with your Webflow account to continue.</p>

        <a
          href="/api/auth/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong"
        >
          Sign in with Webflow
        </a>

        <p className="mt-4 text-[11.5px] text-ink-faint">
          You'll need to be a collaborator on the connected Webflow site.
        </p>

        {!showPasswordForm ? (
          <button
            type="button"
            onClick={() => setShowPasswordForm(true)}
            className="mt-5 text-[12px] font-medium text-accent-text hover:underline"
          >
            Connected without Webflow sign-in? Log in with email &amp; password
          </button>
        ) : (
          <form onSubmit={submitPasswordLogin} className="mt-5 flex flex-col gap-3 text-left">
            <label className={labelClass}>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </label>

            {error && <p className="text-sm font-medium text-status-error-fg">{error}</p>}

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Logging in…" : "Log in"}
            </button>
            <div className="flex items-center justify-between text-[12px]">
              <Link to="/forgot-password" className="font-medium text-accent-text hover:underline">
                Forgot password?
              </Link>
              <button type="button" onClick={() => setShowPasswordForm(false)} className="text-ink-faint hover:underline">
                Back
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
