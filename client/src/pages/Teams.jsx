import { useEffect, useState } from "react";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import Card from "../components/Card.jsx";
import Chip from "../components/Chip.jsx";
import SegmentedControl from "../components/SegmentedControl.jsx";
import { formatDateTime } from "../formatDate.js";

const TABS = [
  ["members", "Members"],
  ["invites", "Invites"],
  ["activity", "Activity Log"],
];

// One label per `action` string recorded by store.recordActivity (see the
// server route handlers that call it) -- kept as a flat lookup rather than
// a shared file since nothing outside this page needs it.
const ACTION_LABELS = {
  "sync.item": "Sent a collection item sync",
  "sync.combined": "Sent a combined sync",
  "sync.pages_item": "Sent a pages sync",
  "sync.components_item": "Sent a components sync",
  "automation.create": "Created an automation",
  "automation.update": "Updated an automation",
  "automation.delete": "Deleted an automation",
  "automation.pause": "Paused an automation",
  "automation.resume": "Resumed an automation",
  "automation.archive": "Archived an automation",
  "automation.unarchive": "Unarchived an automation",
  "automation.flush": "Manually flushed an automation",
  "automation.flush_all": "Flushed the pending queue",
  "settings.update": "Updated settings",
  "wxrks_connection.save": "Connected wxrks",
  "wxrks_connection.delete": "Disconnected wxrks",
  "llm_connection.save": "Connected an LLM key",
  "llm_connection.delete": "Disconnected the LLM key",
  "webhook.reregister_cms": "Reregistered the Webflow CMS webhook",
  "webhook.reregister_pages": "Reregistered the Pages/Components webhook",
  "field_exclusions.update": "Updated field exclusions",
  "team.access_level_update": "Changed a teammate's access level",
  "invite.create": "Generated an invite",
  "invite.revoke": "Revoked an invite",
  "invite.redeemed": "An invite was redeemed",
};

function inviteStatusLabel(status) {
  if (status === "redeemed") return "Redeemed";
  if (status === "expired") return "Expired";
  if (status === "revoked") return "Revoked";
  return "Pending";
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function personName({ firstName, lastName, email }) {
  return [firstName, lastName].filter(Boolean).join(" ") || email;
}

// Most detail shapes are just "the name of the thing acted on" -- a few
// need their own formatting (word/item counts, which settings fields
// changed). See each route handler's store.recordActivity(...) call for
// the matching detail shape.
function activityDetailText({ action, detail: d }) {
  if (!d) return null;
  switch (action) {
    case "sync.item":
      return `${d.collectionName || "collection"} · ${d.itemCount} item${d.itemCount === 1 ? "" : "s"}`;
    case "sync.combined":
      return `${d.groupCount} group${d.groupCount === 1 ? "" : "s"} · ${d.itemCount} item${d.itemCount === 1 ? "" : "s"}`;
    case "sync.pages_item":
    case "sync.components_item":
      return `${d.itemCount} item${d.itemCount === 1 ? "" : "s"}`;
    case "automation.flush_all":
      return `${d.itemsSynced} item${d.itemsSynced === 1 ? "" : "s"} synced`;
    case "settings.update":
      return (d.fields || []).join(", ") || null;
    case "field_exclusions.update":
      return `${d.excludedCount} field${d.excludedCount === 1 ? "" : "s"} excluded`;
    case "team.access_level_update":
      return d.accessLevel === "reviewer" ? "Set to read-only" : "Set to full access";
    default:
      return d.name || null;
  }
}

export default function Teams() {
  const [activeTab, setActiveTab] = useState("members");
  const [members, setMembers] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [timezone, setTimezone] = useState(undefined);
  const [activity, setActivity] = useState(null);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingUserId, setSavingUserId] = useState(null);
  const [error, setError] = useState(null);
  const { account } = useAuth();
  const isOwner = account?.role === "owner";
  const visibleTabs = TABS.filter(([value]) => value !== "invites" || isOwner);

  const [invites, setInvites] = useState(null);
  const [inviteNote, setInviteNote] = useState("");
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [newInviteLink, setNewInviteLink] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [revokingId, setRevokingId] = useState(null);

  function loadMembers() {
    api
      .getTeam()
      .then((res) => {
        setMembers(res.members);
        setCurrentUserId(res.currentUserId);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadMembers();
    api.getSettings().then((s) => setTimezone(s.timezone)).catch(() => {});
  }, []);

  // Activity is fetched lazily, only once the tab is actually opened --
  // no point paying for it on every Teams page visit if someone only ever
  // checks Members.
  useEffect(() => {
    if (activeTab !== "activity" || activity !== null) return;
    api
      .getActivity(0)
      .then((res) => {
        setActivity(res.items);
        setActivityHasMore(res.hasMore);
        setActivityOffset(res.items.length);
      })
      .catch((err) => setError(err.message));
  }, [activeTab, activity]);

  function loadMoreActivity() {
    setLoadingMore(true);
    api
      .getActivity(activityOffset)
      .then((res) => {
        setActivity((prev) => [...prev, ...res.items]);
        setActivityHasMore(res.hasMore);
        setActivityOffset((prev) => prev + res.items.length);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }

  // Lazy-loaded like Activity above -- and owner-only, so a non-owner never
  // even triggers the request.
  useEffect(() => {
    if (activeTab !== "invites" || invites !== null || !isOwner) return;
    api
      .listInvites()
      .then((res) => setInvites(res.invites))
      .catch((err) => setError(err.message));
  }, [activeTab, invites, isOwner]);

  async function generateInvite() {
    setGeneratingInvite(true);
    setError(null);
    try {
      const invite = await api.createInvite({ note: inviteNote || undefined });
      setNewInviteLink(`${window.location.origin}/connect?invite=${invite.token}`);
      setLinkCopied(false);
      setInviteNote("");
      const res = await api.listInvites();
      setInvites(res.invites);
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingInvite(false);
    }
  }

  function copyInviteLink() {
    navigator.clipboard.writeText(newInviteLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  async function revokeInvite(id) {
    setRevokingId(id);
    try {
      const res = await api.revokeInvite(id);
      setInvites(res.invites);
    } catch (err) {
      setError(err.message);
    } finally {
      setRevokingId(null);
    }
  }

  async function changeAccessLevel(targetUserId, accessLevel) {
    setSavingUserId(targetUserId);
    try {
      const res = await api.setTeamMemberAccessLevel(targetUserId, accessLevel);
      setMembers(res.members);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingUserId(null);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Teams</h1>
        <p className="mt-0.5 text-[13px] text-ink-faint">Everyone with access to this workspace, and what they've done.</p>
      </div>

      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <div className="mb-5 flex gap-1 border-b border-border">
        {visibleTabs.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setActiveTab(value)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors " +
              (activeTab === value ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "members" && (
        <Card>
          {members === null ? (
            <p className="p-4 text-sm text-ink-faint">Loading…</p>
          ) : (
            members.map((m) => (
              <div key={m.id} className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">
                    {personName(m)} {m.id === currentUserId && <span className="font-normal text-ink-faint">(you)</span>}
                  </div>
                  <div className="truncate text-xs text-ink-faint">{m.email}</div>
                </div>
                <Chip>{m.role === "owner" ? "Owner" : "Member"}</Chip>
                {isOwner && m.id !== currentUserId ? (
                  <div className={savingUserId === m.id ? "pointer-events-none opacity-50" : ""}>
                    <SegmentedControl
                      options={[
                        { value: "full", label: "Full access" },
                        { value: "reviewer", label: "Read-only" },
                      ]}
                      value={m.accessLevel}
                      onChange={(v) => changeAccessLevel(m.id, v)}
                    />
                  </div>
                ) : (
                  <span className="w-[7.5rem] flex-none text-right text-xs text-ink-faint">
                    {m.accessLevel === "reviewer" ? "Read-only" : "Full access"}
                  </span>
                )}
              </div>
            ))
          )}
        </Card>
      )}

      {activeTab === "invites" && isOwner && (
        <>
          <Card className="mb-5 p-5">
            <h2 className="mb-1 text-[13.5px] font-semibold text-ink">Invite a workspace</h2>
            <p className="text-xs text-ink-faint">
              "Sign in with Webflow" only reaches sites in this app's own workspace. Generate a
              one-time link for a different workspace to connect via API token instead --{" "}
              <a
                href="/docs/connecting-accounts.html#webflow-manual-token"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-text hover:underline"
              >
                how this works →
              </a>
            </p>

            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={inviteNote}
                onChange={(e) => setInviteNote(e.target.value)}
                placeholder="Optional note (e.g. a client or teammate's name)"
                className="w-full max-w-sm rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                type="button"
                onClick={generateInvite}
                disabled={generatingInvite}
                className="flex-none rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generatingInvite ? "Generating…" : "Generate invite"}
              </button>
            </div>

            {newInviteLink && (
              <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
                <p className="mb-2 text-xs font-medium text-status-error-fg">
                  Copy this now -- you won't be able to see the full link again.
                </p>
                <div className="flex items-center gap-2">
                  <input type="text" readOnly value={newInviteLink} className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 font-mono text-xs text-ink" />
                  <button
                    type="button"
                    onClick={copyInviteLink}
                    className="flex-none rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold hover:border-ink-faint"
                  >
                    {linkCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            )}
          </Card>

          <Card>
            {invites === null ? (
              <p className="p-4 text-sm text-ink-faint">Loading…</p>
            ) : invites.length === 0 ? (
              <p className="p-4 text-sm text-ink-faint">No invites yet.</p>
            ) : (
              invites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{inv.note || "Untitled invite"}</div>
                    <div className="truncate font-mono text-xs text-ink-faint">{inv.tokenMasked}</div>
                  </div>
                  <Chip>{inviteStatusLabel(inv.status)}</Chip>
                  <span className="w-36 flex-none text-right text-xs text-ink-faint">
                    {inv.status === "pending" ? `Expires ${formatDateTime(inv.expiresAt, timezone)}` : formatDateTime(inv.createdAt, timezone)}
                  </span>
                  {inv.status === "pending" && (
                    <button
                      type="button"
                      onClick={() => revokeInvite(inv.id)}
                      disabled={revokingId === inv.id}
                      className="flex-none text-xs font-medium text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))
            )}
          </Card>
        </>
      )}

      {activeTab === "activity" && (
        <Card>
          {activity === null ? (
            <p className="p-4 text-sm text-ink-faint">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="p-4 text-sm text-ink-faint">No activity yet.</p>
          ) : (
            <>
              {activity.map((entry) => (
                <div key={entry.id} className="flex items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{actionLabel(entry.action)}</div>
                    <div className="truncate text-xs text-ink-faint">
                      {entry.user ? personName(entry.user) : "Someone (no longer on the team)"}
                      {activityDetailText(entry) && <> · {activityDetailText(entry)}</>}
                    </div>
                  </div>
                  <span className="flex-none font-mono text-[11.5px] text-ink-faint">{formatDateTime(entry.createdAt, timezone)}</span>
                </div>
              ))}
              {activityHasMore && (
                <div className="border-t border-border p-3 text-center">
                  <button
                    onClick={loadMoreActivity}
                    disabled={loadingMore}
                    className="text-sm font-semibold text-accent-text hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
