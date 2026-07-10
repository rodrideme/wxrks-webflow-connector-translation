import Card from "../components/Card.jsx";

/**
 * Rendered by App.jsx instead of the router tree while logged out --
 * there's nothing else reachable, so no route/path is needed for this. The
 * button is a plain top-level navigation (not a fetch call): the whole
 * point of the OAuth flow is a real browser redirect to webflow.com and
 * back, which only a full navigation can do.
 */
export default function Login() {
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
      </Card>
    </div>
  );
}
