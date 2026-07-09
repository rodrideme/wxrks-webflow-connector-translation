import { Routes, Route, Navigate } from "react-router-dom";
import NavBar from "./components/NavBar.jsx";
import LoadingState from "./components/LoadingState.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Translate from "./pages/Translate.jsx";
import Runs from "./pages/Runs.jsx";
import Templates from "./pages/Templates.jsx";
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

  if (!user) {
    return <Login />;
  }

  return (
    <div className="flex min-h-screen bg-canvas">
      <NavBar />
      <main className="min-w-0 flex-1 px-8 py-7">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/select-and-send" element={<Navigate to="/translate" replace />} />
          <Route path="/automation" element={<Navigate to="/runs" replace />} />
          <Route path="/logs" element={<Navigate to="/runs" replace />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
