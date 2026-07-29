import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "../services/api.js";
import dataCache from "../services/dataCache.js";

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
      .then(({ user, account, accounts }) => {
        // BEFORE setState, so every page effect that mounts as a result of
        // this state flip already reads/writes the cache under the right
        // account's namespace (and an account CHANGE wipes the previous
        // account's entries -- see dataCache.setNamespace).
        dataCache.setNamespace(account?.id || null);
        setState({ loading: false, user, account, accounts: accounts || [] });
      })
      .catch(() => {
        dataCache.setNamespace(null);
        setState({ loading: false, user: null, account: null, accounts: [] });
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    api.onUnauthorized = () => {
      // A revoked/expired session must not leave this account's data warm
      // for whoever logs in next in this tab.
      dataCache.clearAll();
      dataCache.setNamespace(null);
      setState({ loading: false, user: null, account: null, accounts: [] });
    };
    return () => {
      api.onUnauthorized = null;
    };
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    dataCache.clearAll();
    dataCache.setNamespace(null);
    setState({ loading: false, user: null, account: null, accounts: [] });
  }

  // Derived once here rather than in every consuming component -- account
  // already carries role/accessLevel straight from GET /api/auth/me (see
  // store.js's getSessionWithUserAndAccount). true whenever accessLevel
  // isn't loaded yet too, so a still-loading page doesn't flash every
  // control as disabled before the real value arrives.
  const canEdit = state.account?.accessLevel !== "reviewer";

  return <AuthContext.Provider value={{ ...state, canEdit, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
