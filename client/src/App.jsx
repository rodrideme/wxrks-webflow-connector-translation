import { Routes, Route, Navigate } from "react-router-dom";
import NavBar from "./components/NavBar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import SelectAndSend from "./pages/SelectAndSend.jsx";
import Automation from "./pages/Automation.jsx";
import Templates from "./pages/Templates.jsx";
import Settings from "./pages/Settings.jsx";
import Logs from "./pages/Logs.jsx";

export default function App() {
  return (
    <div className="flex min-h-screen bg-canvas">
      <NavBar />
      <main className="min-w-0 flex-1 px-8 py-7">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/select-and-send" element={<SelectAndSend />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/translate" element={<Navigate to="/select-and-send" replace />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
