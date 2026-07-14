import { useEffect, useState } from "react";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import Card from "../components/Card.jsx";
import Chip from "../components/Chip.jsx";
import SegmentedControl from "../components/SegmentedControl.jsx";
import { formatDateTime } from "../formatDate.js";

const TABS = [
  ["members", "Members"],
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
  // Recorded by routes/environments.js -- shown here since that action
  // still belongs to THIS account's own activity log even though the
  // Generate/Revoke UI itself lives on the separate Environments page.
  "invite.create": "Generated an environment link",
  "invite.revoke": "Revoked an environment link",
  "invite.redeemed": "An environment link was redeemed",
};

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
        {TABS.map(([value, label]) => (
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
