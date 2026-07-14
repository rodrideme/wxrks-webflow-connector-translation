import { Link } from "react-router-dom";
import Card from "../components/Card.jsx";

/**
 * Reachable regardless of session state (see App.jsx), at /fast --
 * "Sign in with Webflow" OAuth, split out from the default root Login
 * page (see that file's docblock for why: OAuth only works for the one
 * workspace this app's OAuth client is registered in, so it's a dead end
 * for most real users; this path exists for whoever that OAuth path
 * actually works for). The button is a plain top-level navigation (not a
 * fetch call): the whole point of this flow is a real browser redirect to
 * webflow.com and back, which only a full navigation can do.
 */
export default function FastLogin() {
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

        <Link to="/" className="mt-5 inline-block text-[12px] font-medium text-accent-text hover:underline">
          Back to login
        </Link>
      </Card>
    </div>
  );
}
