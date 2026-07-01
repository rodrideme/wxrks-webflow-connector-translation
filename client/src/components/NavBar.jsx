import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/sync", label: "Sync Panel" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

export default function NavBar() {
  return (
    <nav className="navbar">
      <div className="navbar-brand">Webflow Translation Sync</div>
      <div className="navbar-links">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={({ isActive }) => "navbar-link" + (isActive ? " active" : "")}
          >
            {link.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
