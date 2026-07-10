import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

const links = [
  { to: "/", label: "Dashboard", end: true, icon: "▦" },
  { to: "/translate", label: "Translate", icon: "⇄" },
  { to: "/runs", label: "Runs", icon: "☰" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export default function NavBar() {
  const { user, account, logout } = useAuth();

  return (
    <nav className="sticky top-0 flex h-screen w-[13.5rem] flex-none flex-col gap-0.5 border-r border-border bg-surface-sunken p-3">
      <div className="flex items-center gap-2 px-2 pb-4 pt-1">
        <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent-strong text-[10px] font-bold text-white">
          W→
        </div>
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

      <div className="flex flex-col gap-1.5 border-t border-border px-2 pt-3 text-[11px] text-ink-faint">
        {account?.name || account?.webflowSiteId ? (
          <span className="truncate font-medium text-ink-soft" title={account.name || account.webflowSiteId}>
            {account.name || account.webflowSiteId}
          </span>
        ) : null}
        {user?.email && <span className="truncate">{user.email}</span>}
        <button type="button" onClick={logout} className="self-start text-left text-accent-text hover:underline">
          Sign out
        </button>
      </div>
    </nav>
  );
}
