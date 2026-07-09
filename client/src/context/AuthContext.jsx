import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "../services/api.js";

const AuthContext = createContext(null);

/**
 * Checks GET /api/auth/me once on mount to establish whether there's a
 * valid session -- App.jsx renders Login.jsx instead of the router tree
 * while logged out. Also registers itself as api.js's "on 401" handler
 * (see services/api.js) so a session that expires or gets revoked
 * mid-use (not just a fresh page load) correctly drops back to the login
 * screen instead of every subsequent request just silently erroring.
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, account: null, accounts: [] });

  const refresh = useCallback(() => {
    return api
      .getMe()
      .then(({ user, account, accounts }) => setState({ loading: false, user, account, accounts: accounts || [] }))
      .catch(() => setState({ loading: false, user: null, account: null, accounts: [] }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    api.onUnauthorized = () => setState({ loading: false, user: null, account: null, accounts: [] });
    return () => {
      api.onUnauthorized = null;
    };
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setState({ loading: false, user: null, account: null, accounts: [] });
  }

  return <AuthContext.Provider value={{ ...state, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
