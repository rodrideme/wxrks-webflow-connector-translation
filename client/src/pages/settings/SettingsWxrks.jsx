import { useEffect, useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";

const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const inputClass =
  "w-80 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";

/**
 * Every account's own wxrks credentials -- unlike Webflow (connected once
 * via OAuth at login), wxrks has no OAuth flow, so these are entered
 * manually here. The account that predates this system entirely keeps
 * using the shared env-configured credentials as a fallback (see
 * services/wxrks.js's resolveConnection()); every other account must
 * connect its own before any wxrks-dependent feature (the "Send to wxrks"
 * wizard, automations) will work.
 */
export default function SettingsWxrks({ wxrksConnected, wxrksAccessKeyMasked, onChange, settings, markDirty, saveFields }) {
  const [accessKey, setAccessKey] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [orgUnits, setOrgUnits] = useState([]);
  const [orgUnitsError, setOrgUnitsError] = useState(null);
  const [orgUnitsLoading, setOrgUnitsLoading] = useState(true);
  const [savingOrgUnit, setSavingOrgUnit] = useState(false);
  const [orgUnitSaved, setOrgUnitSaved] = useState(false);

  // wxrksConnected only means "a credential is stored" -- it says nothing
  // about whether wxrks still actually accepts it (e.g. a key regenerated
  // on wxrks's own side silently invalidates the old one). Re-checked live
  // as soon as this tab loads, so "Connected" here always reflects reality
  // instead of just "something is configured."
  const [connectionTest, setConnectionTest] = useState(null); // null | "checking" | { ok, error }

  useEffect(() => {
    api
      .getOrgUnits()
      .then((res) => setOrgUnits(res.orgUnits || []))
      .catch((err) => setOrgUnitsError(err.message))
      .finally(() => setOrgUnitsLoading(false));
  }, []);

  useEffect(() => {
    if (!wxrksConnected) return;
    checkConnection();
  }, [wxrksConnected]);

  async function checkConnection() {
    setConnectionTest("checking");
    try {
      const res = await api.testWxrksConnection();
      setConnectionTest(res);
    } catch (err) {
      setConnectionTest({ ok: false, error: err.message });
    }
  }

  async function saveOrgUnit() {
    setSavingOrgUnit(true);
    setOrgUnitSaved(false);
    try {
      await saveFields(["orgUnitUUID"]);
      setOrgUnitSaved(true);
    } finally {
      setSavingOrgUnit(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveWxrksConnection(accessKey, secret);
      setAccessKey("");
      setSecret("");
      setSaved(true);
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.deleteWxrksConnection();
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Card className="p-5">
      <h2 className="mb-3 text-[13.5px] font-semibold text-ink">wxrks connection</h2>

      {wxrksConnected && wxrksAccessKeyMasked && (
        <div className="mb-3 flex items-center gap-2 text-sm text-ink-soft">
          <span>
            Connected as <strong className="font-mono text-ink">{wxrksAccessKeyMasked}</strong>
          </span>
          {connectionTest === "checking" && <span className="text-xs text-ink-faint">Checking…</span>}
          {connectionTest && connectionTest !== "checking" && connectionTest.ok && (
            <span className="text-xs font-medium text-status-success-fg">✓ Verified just now</span>
          )}
          {connectionTest && connectionTest !== "checking" && !connectionTest.ok && (
            <span className="text-xs font-medium text-status-error-fg">✗ wxrks rejected this: {connectionTest.error}</span>
          )}
          {connectionTest !== "checking" && (
            <button type="button" onClick={checkConnection} className="text-xs font-medium text-accent-text hover:underline">
              Re-check
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label className={labelClass}>
          Access key
          <input
            type="password"
            autoComplete="off"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            placeholder={wxrksConnected ? "Enter a new access key to change it" : "wxrks access key"}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Secret
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={wxrksConnected ? "Enter a new secret to change it" : "wxrks secret"}
            className={inputClass}
          />
        </label>
      </div>

      <p className={`mt-2 ${hintClass}`}>
        Validated against wxrks before saving. Every automation and one-time send under this account uses these
        credentials -- without your own, translation features are unavailable.{" "}
        <a
          href="/docs/connecting-accounts.html#generating-keys"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          Watch: how to generate your wxrks keys →
        </a>
      </p>

      {error && <p className="mt-2 text-sm font-medium text-status-error-fg">{error}</p>}
      {saved && <p className="mt-2 text-sm font-medium text-status-success-fg">wxrks connection saved.</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !accessKey || !secret}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save & test connection"}
        </button>
        {wxrksConnected && wxrksAccessKeyMasked && (
          <button
            type="button"
            onClick={disconnect}
            disabled={saving}
            className="text-sm font-medium text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Disconnect
          </button>
        )}
      </div>
    </Card>

    <Card className="mt-5 p-5">
      <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Default org unit</h2>
      <p className={hintClass}>
        Pre-fills the org unit when starting a new send or automation -- you can always pick a
        different one at that point instead.
      </p>

      <label className={`mt-3 ${labelClass}`}>
        Org unit
        <select
          value={settings?.orgUnitUUID || ""}
          onChange={(e) => markDirty({ orgUnitUUID: e.target.value })}
          disabled={orgUnitsLoading}
          className={inputClass}
        >
          <option value="">— none —</option>
          {orgUnits.map((o) => (
            <option key={o.uuid} value={o.uuid}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      {orgUnitsError && (
        <p className="mt-2 text-xs font-medium text-status-error-fg">Couldn't load org units: {orgUnitsError}</p>
      )}
      {orgUnitSaved && <p className="mt-2 text-sm font-medium text-status-success-fg">Default org unit saved.</p>}

      <button
        type="button"
        onClick={saveOrgUnit}
        disabled={savingOrgUnit}
        className="mt-3 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        {savingOrgUnit ? "Saving..." : "Save"}
      </button>
    </Card>
    </>
  );
}
