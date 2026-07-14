import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import api from "../services/api.js";
import Card from "../components/Card.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const labelClass = "flex flex-col gap-1 text-left text-sm font-medium text-ink-soft";
const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Keep in sync with server/services/passwordHash.js's MIN_PASSWORD_LENGTH.
const MIN_PASSWORD_LENGTH = 12;

/**
 * Reachable regardless of session state (see App.jsx) -- reached only via
 * the link in the password-reset email (routes/auth.js's /forgot-password,
 * services/email.js). On success, this also invalidates every other
 * active session for the account server-side and logs this browser in
 * with a fresh one, mirroring a successful invite redemption.
 */
export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = searchParams.get("token") || "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const passwordTooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const passwordValid = newPassword.length >= MIN_PASSWORD_LENGTH && newPassword === confirmPassword;

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.resetPassword(token, newPassword);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <Card className="w-full max-w-sm p-8 text-center">
          <h1 className="text-[17px] font-semibold text-ink">Reset link missing</h1>
          <p className="mt-1.5 text-[13px] text-ink-faint">
            This page needs a reset link from your email.{" "}
            <Link to="/forgot-password" className="font-medium text-accent-text hover:underline">
              Request a new one
            </Link>
            .
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <img src="/wxrks-logo.svg" alt="wxrks" className="mx-auto mb-4 h-12 w-12" />
        <h1 className="text-[17px] font-semibold text-ink">Set a new password</h1>
        <p className="mt-1.5 text-[13px] text-ink-faint">This also signs you out everywhere else.</p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-3 text-left">
          <label className={labelClass}>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              className={inputClass}
            />
          </label>
          {passwordTooShort && (
            <p className="-mt-2 text-xs text-status-error-fg">Must be at least {MIN_PASSWORD_LENGTH} characters.</p>
          )}
          <label className={labelClass}>
            Confirm new password
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

          {error && <p className="text-sm font-medium text-status-error-fg">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !passwordValid}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Resetting…" : "Reset password"}
          </button>
        </form>
      </Card>
    </div>
  );
}
