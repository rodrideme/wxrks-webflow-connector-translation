import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";

// Served as-is from client/public/ (not a Vite-processed src import) so the
// docs site's static HTML pages can reference this exact same URL/file
// instead of keeping a second copy of the logo.
const logo = "/wxrks-logo.svg";

const BASE_LINKS = [
  { to: "/", label: "Dashboard", end: true, icon: "▦" },
  { to: "/translate", label: "Translate", icon: "⇄" },
  { to: "/runs", label: "Runs", icon: "☰" },
  { to: "/teams", label: "Teams", icon: "☺" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

// Only the one account that predates multi-tenancy entirely can provision
// a new environment for another, unrelated company (see middleware/auth.js's
// requireOriginalAccount) -- hidden from every other account's nav rather
// than shown and then just 403ing.
const ENVIRONMENTS_LINK = { to: "/environments", label: "Environments", icon: "🧩" };

export default function NavBar() {
  const { user, account, logout } = useAuth();
  const [site, setSite] = useState(null);
  const links = account?.isOriginalAccount ? [...BASE_LINKS, ENVIRONMENTS_LINK] : BASE_LINKS;

  // Fetched once -- NavBar sits outside <Routes> in App.jsx and never
  // remounts on navigation, so this doesn't refire per page.
  useEffect(() => {
    api.getWebflowLocales().then((res) => setSite(res?.site || null)).catch(() => setSite(null));
  }, []);

  const siteUrl = site?.url;
  const siteHost = siteUrl ? siteUrl.replace(/^https?:\/\//, "") : null;

  return (
    <nav className="sticky top-0 flex h-screen w-[13.5rem] flex-none flex-col gap-0.5 border-r border-border bg-surface-sunken p-3">
      <div className="flex items-center gap-2 px-2 pb-4 pt-1">
        <img src={logo} alt="wxrks" className="h-[22px] w-[22px] flex-none rounded-md" />
        <span className="text-[12.5px] font-semibold text-ink">wxrks Sync</span>
      </div>

      <div className="flex flex-col gap-0.5">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={({ isActive }) =>
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors " +
              (isActive ? "bg-accent-subtle text-accent-text" : "text-ink-soft hover:text-ink")
            }
          >
            <span className="w-[15px] text-center text-[13px] opacity-85">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </div>

      <a
        href="/docs/index.html"
        target="_blank"
        rel="noreferrer"
        className="mt-auto flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
      >
        <span className="w-[15px] text-center text-[13px] opacity-85">📖</span>
        Docs
      </a>

      <div className="flex flex-col gap-2 border-t border-border px-2 pt-3">
        {siteUrl ? (
          <a
            href={siteUrl}
            target="_blank"
            rel="noreferrer"
            title={siteUrl}
            className="flex items-center gap-2.5 rounded-md py-1 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            <span className="w-[15px] flex-none text-center text-[13px] opacity-85">🌐</span>
            <span className="truncate">{siteHost}</span>
          </a>
        ) : account?.name || account?.webflowSiteId ? (
          <span className="flex items-center gap-2.5 truncate py-1 text-[12.5px] font-medium text-ink-soft" title={account.name || account.webflowSiteId}>
            <span className="w-[15px] flex-none text-center text-[13px] opacity-85">🌐</span>
            {account.name || account.webflowSiteId}
          </span>
        ) : null}
        {user?.email && <span className="truncate px-0.5 text-[11px] text-ink-faint">{user.email}</span>}
        <button type="button" onClick={logout} className="self-start px-0.5 text-left text-[11px] text-accent-text hover:underline">
          Sign out
        </button>
      </div>
    </nav>
  );
}
