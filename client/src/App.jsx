import { Routes, Route } from "react-router-dom";
import NavBar from "./components/NavBar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import SyncPanel from "./pages/SyncPanel.jsx";
import Settings from "./pages/Settings.jsx";
import History from "./pages/History.jsx";

export default function App() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <NavBar />
      <main className="min-w-0 flex-1 px-8 py-7">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sync" element={<SyncPanel />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
