import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api.js";
import Card from "../components/Card.jsx";

const labelClass = "flex flex-col gap-1 text-left text-sm font-medium text-ink-soft";
const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

/**
 * Reachable regardless of session state (see App.jsx), like /connect and
 * /reset-password. Only ever relevant for accounts connected via
 * routes/connect.js's invite flow -- OAuth-connected accounts have no
 * password to reset (Webflow re-auth is their way back in). Always shows
 * the same message on submit, matching the server's same-response-either-
 * way behavior (see routes/auth.js's /forgot-password) -- this page never
 * learns whether the email was actually found.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.forgotPassword(email);
    } catch {
      // Ignored on purpose -- see docblock above.
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-8 text-center">
        <img src="/wxrks-logo.svg" alt="wxrks" className="mx-auto mb-4 h-12 w-12" />
        <h1 className="text-[17px] font-semibold text-ink">Reset your password</h1>

        {submitted ? (
          <p className="mt-3 text-[13px] text-ink-faint">
            If that email has password access enabled, we've sent a reset link. Check your inbox.
          </p>
        ) : (
          <>
            <p className="mt-1.5 text-[13px] text-ink-faint">
              Enter the email you connected with, and we'll send you a reset link.
            </p>
            <form onSubmit={submit} className="mt-5 flex flex-col gap-3 text-left">
              <label className={labelClass}>
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </label>
              <button
                type="submit"
                disabled={submitting || !email}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send reset link"}
              </button>
            </form>
          </>
        )}

        <Link to="/" className="mt-5 inline-block text-[12px] font-medium text-accent-text hover:underline">
          Back to login
        </Link>
      </Card>
    </div>
  );
}
