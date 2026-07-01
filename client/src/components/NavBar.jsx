import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/sync", label: "Sync Panel" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

export default function NavBar() {
  return (
    <nav className="bg-slate-900">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="text-sm font-semibold tracking-wide text-white">Webflow Translation Sync</div>
        <div className="flex gap-1">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (isActive ? "bg-brand-500 text-white" : "text-slate-300 hover:bg-white/10 hover:text-white")
              }
            >
              {link.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
