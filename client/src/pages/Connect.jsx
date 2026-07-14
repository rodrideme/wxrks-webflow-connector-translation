import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import LoadingState from "../components/LoadingState.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const labelClass = "flex flex-col gap-1 text-left text-sm font-medium text-ink-soft";
const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Keep in sync with server/services/passwordHash.js's MIN_PASSWORD_LENGTH
// -- no shared package between client/server in this repo to import it from.
const MIN_PASSWORD_LENGTH = 12;

/**
 * Reachable regardless of session state (see App.jsx) -- redemption for
 * two different invite kinds (see routes/connect.js's docblock):
 * "environment" (generated from the Environments page -- connects a
 * brand-new, independent Webflow site via a Site API token) and
 * "team_member" (generated from the Teams page's Invites tab -- joins an
 * EXISTING account directly, no Webflow token needed at all). There's no
 * link to this page from the plain Login page on purpose; an existing
 * account owner shares the URL directly either way.
 */
export default function Connect() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const inviteToken = searchParams.get("invite") || "";

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [inviteKind, setInviteKind] = useState("environment");
  const isTeamMemberInvite = inviteKind === "team_member";

  const [webflowApiToken, setWebflowApiToken] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword;

  useEffect(() => {
    if (!inviteToken) {
      setChecking(false);
      setValid(false);
      return;
    }
    api
      .checkInvite(inviteToken)
      .then((res) => {
        setValid(Boolean(res.valid));
        setInviteKind(res.kind || "environment");
      })
      .catch(() => setValid(false))
      .finally(() => setChecking(false));
  }, [inviteToken]);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.redeemInvite({ inviteToken, webflowApiToken, firstName, lastName, email, password });
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <LoadingState label="Checking invite…" />
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <Card className="w-full max-w-sm p-8 text-center">
          <h1 className="text-[17px] font-semibold text-ink">Invite not valid</h1>
          <p className="mt-1.5 text-[13px] text-ink-faint">
            This invite link is invalid, has expired, or has already been used. Ask whoever sent it
            to generate a new one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-sm p-8">
        <div className="text-center">
          <img src="/wxrks-logo.svg" alt="wxrks" className="mx-auto mb-4 h-12 w-12" />
          <h1 className="text-[17px] font-semibold text-ink">
            {isTeamMemberInvite ? "Join your team" : "Connect your Webflow site"}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-faint">
            {isTeamMemberInvite
              ? "Set up your login to join the account that invited you."
              : 'Paste a Webflow Site API token to connect this workspace directly, without "Sign in with Webflow".'}
          </p>
        </div>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          {!isTeamMemberInvite && (
            <label className={labelClass}>
              Webflow Site API token
              <input
                type="password"
                autoComplete="off"
                required
                value={webflowApiToken}
                onChange={(e) => setWebflowApiToken(e.target.value)}
                placeholder="Paste your token"
                className={inputClass}
              />
            </label>
          )}
          <label className={labelClass}>
            First name
            <input
              type="text"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Last name
            <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              className={inputClass}
            />
          </label>
          {passwordTooShort && (
            <p className="-mt-2 text-xs text-status-error-fg">Must be at least {MIN_PASSWORD_LENGTH} characters.</p>
          )}
          <label className={labelClass}>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputClass}
            />
          </label>
          {passwordsMismatch && <p className="-mt-2 text-xs text-status-error-fg">Passwords don't match.</p>}
          <p className="text-xs text-ink-faint">
            {isTeamMemberInvite
              ? "This is how you'll log back in here later."
              : 'This is separate from your Webflow token -- it\'s how you\'ll log back in here later, since there\'s no "Sign in with Webflow" for this connection.'}
          </p>

          {!isTeamMemberInvite && (
            <p className="text-xs text-ink-faint">
              Validated against Webflow before your account is created.{" "}
              <a
                href="/docs/connecting-accounts.html#webflow-manual-token"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-text hover:underline"
              >
                How to generate a Site API token →
              </a>
            </p>
          )}

          {error && <p className="text-sm font-medium text-status-error-fg">{error}</p>}

          <button
            type="submit"
            disabled={submitting || (!isTeamMemberInvite && !webflowApiToken) || !firstName || !email || !passwordValid}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Connecting…" : isTeamMemberInvite ? "Join" : "Connect"}
          </button>
        </form>
      </Card>
    </div>
  );
}
