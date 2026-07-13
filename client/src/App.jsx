import { Routes, Route, Navigate } from "react-router-dom";
import NavBar from "./components/NavBar.jsx";
import LoadingState from "./components/LoadingState.jsx";
import Login from "./pages/Login.jsx";
import Connect from "./pages/Connect.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Translate from "./pages/Translate.jsx";
import Runs from "./pages/Runs.jsx";
import Teams from "./pages/Teams.jsx";
import Settings from "./pages/Settings.jsx";
import { useAuth } from "./context/AuthContext.jsx";

export default function App() {
  const { loading, user } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <LoadingState label="Loading" />
      </div>
    );
  }

  return (
    <Routes>
      {/* Reachable regardless of session state -- unlike Login, this needs
          a real route since it's shared as a link, not just "whatever
          renders when logged out" (see Connect.jsx's own docblock). */}
      <Route path="/connect" element={<Connect />} />
      <Route
        path="*"
        element={
          !user ? (
            <Login />
          ) : (
            <div className="flex min-h-screen bg-canvas">
              <NavBar />
              <main className="min-w-0 flex-1 px-8 py-7">
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/translate" element={<Translate />} />
                  <Route path="/runs" element={<Runs />} />
                  <Route path="/teams" element={<Teams />} />
                  <Route path="/select-and-send" element={<Navigate to="/translate" replace />} />
                  <Route path="/automation" element={<Navigate to="/runs" replace />} />
                  <Route path="/logs" element={<Navigate to="/runs" replace />} />
                  <Route path="/templates" element={<Navigate to="/settings" replace />} />
                  <Route path="/settings/*" element={<Settings />} />
                </Routes>
              </main>
            </div>
          )
        }
      />
    </Routes>
  );
}
