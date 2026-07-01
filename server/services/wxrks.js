const axios = require("axios");
const FormData = require("form-data");
const AdmZip = require("adm-zip");

const WXRKS_API_URL = process.env.WXRKS_API_URL || "https://app.wxrks.com/api/v3";

// Cached session token. Re-authenticated lazily when missing/expired.
let session = {
  token: null,
  expiresAt: null,
};

const client = axios.create({ baseURL: WXRKS_API_URL });

function isTokenValid() {
  return Boolean(session.token) && (!session.expiresAt || Date.now() < session.expiresAt);
}

/**
 * POST /auth with { accessKey, secret }. wxrks returns the session token as
 * an X-AUTH-TOKEN response header (not in the JSON body).
 */
async function authenticate() {
  const { WXRKS_ACCESS_KEY, WXRKS_SECRET } = process.env;
  if (!WXRKS_ACCESS_KEY || !WXRKS_SECRET) {
    throw new Error("WXRKS_ACCESS_KEY / WXRKS_SECRET are not configured");
  }

  const response = await client.post("/auth", {
    accessKey: WXRKS_ACCESS_KEY,
    secret: WXRKS_SECRET,
  });

  const token = response.headers["x-auth-token"];
  if (!token) {
    throw new Error("wxrks auth response did not include an X-AUTH-TOKEN header");
  }

  session = {
    token,
    // wxrks doesn't document a TTL; default to 50 minutes and rely on the
    // 401/403 retry below to cover early expiry.
    expiresAt: Date.now() + 50 * 60 * 1000,
  };

  return session.token;
}

async function getToken() {
  // A static token (e.g. copied from an existing session) takes precedence
  // over the accessKey/secret login flow, but can't be auto-refreshed.
  if (process.env.WXRKS_API_TOKEN) {
    return process.env.WXRKS_API_TOKEN;
  }
  if (!isTokenValid()) {
    await authenticate();
  }
  return session.token;
}

/**
 * Authenticated request helper. wxrks expects the session token in a custom
 * X-AUTH-TOKEN header. Retries once after re-authenticating on a 401/403 —
 * only meaningful for the accessKey/secret flow, since a static token can't
 * be refreshed.
 */
async function request(config) {
  const token = await getToken();
  try {
    return await client.request({
      ...config,
      headers: { ...(config.headers || {}), "X-AUTH-TOKEN": token },
    });
  } catch (err) {
    const status = err.response?.status;
    if ((status === 401 || status === 403) && !process.env.WXRKS_API_TOKEN) {
      const freshToken = await authenticate();
      return client.request({
        ...config,
        headers: { ...(config.headers || {}), "X-AUTH-TOKEN": freshToken },
      });
    }
    throw err;
  }
}

/**
 * Resolves the org unit UUID to create projects under. If WXRKS_ORG_UNIT_UUID
 * is set (recommended when the account has more than one org unit), it's
 * used directly. Otherwise falls back to the first org unit returned by
 * GET /client.
 */
async function getOrgUnit() {
  if (process.env.WXRKS_ORG_UNIT_UUID) {
    return process.env.WXRKS_ORG_UNIT_UUID;
  }

  const { data } = await request({ method: "GET", url: "/client" });
  const orgUnit = data?.content?.[0];
  const uuid = orgUnit?.uuid;
  if (!uuid) {
    throw new Error(
      "Could not resolve an org unit UUID from wxrks /client response. Set WXRKS_ORG_UNIT_UUID explicitly if the account has multiple org units."
    );
  }
  return uuid;
}

/**
 * Lists org units for the Settings UI dropdown, including each one's
 * configured default source language and target languages (used to suggest
 * defaults for the app's own locale settings).
 */
async function listOrgUnits() {
  const { data } = await request({ method: "GET", url: "/client?size=100" });
  return (data?.content || []).map((c) => ({
    uuid: c.uuid,
    name: c.name,
    defaultSourceLanguage: c.defaultSourceLanguage || null,
    targetLanguages: (c.clientLanguages || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
}

async function getProject(projectUuid) {
  const { data } = await request({ method: "GET", url: `/project/${projectUuid}` });
  return data;
}

async function getOrgUnitDetails(orgUnitUUID) {
  const { data } = await request({ method: "GET", url: `/client/${orgUnitUUID}` });
  return data;
}

/**
 * Glossaries and Translation Memories aren't directly filterable by org unit
 * in the API -- each item just carries an `orgUnits` array (Glossary uses
 * `.uuid`, TM uses `.id`, both hold the org unit UUID) that we filter
 * client-side. Read-only, informational -- the app doesn't let users change
 * which TM/glossary is bound to a project; wxrks infers that itself via
 * inferDefaultSettings=true at project creation.
 */
async function getOrgUnitResources(orgUnitUUID) {
  const orgUnit = await getOrgUnitDetails(orgUnitUUID);
  const organizationUuid = orgUnit.organization?.uuid;

  const glossariesReq = request({
    method: "GET",
    url: `/glossary?organizationUuid=${encodeURIComponent(organizationUuid || "")}&size=100`,
  });
  const v1Base = WXRKS_API_URL.replace(/\/v3\/?$/, "/v1");
  const tmsReq = request({ method: "GET", url: `${v1Base}/atlas-tm?pageSize=100` });

  const [glossariesRes, tmsRes] = await Promise.all([glossariesReq, tmsReq]);
  const belongsToOrgUnit = (entry) =>
    (entry.orgUnits || []).some((ou) => ou.uuid === orgUnitUUID || ou.id === orgUnitUUID);

  return {
    glossaries: (glossariesRes.data?.content || [])
      .filter(belongsToOrgUnit)
      .map((g) => ({ uuid: g.uuid, name: g.name })),
    translationMemories: (tmsRes.data?.content || [])
      .filter(belongsToOrgUnit)
      .map((tm) => ({ uuid: tm.uuid, name: tm.name })),
  };
}

async function updateProjectStatus(projectUuid, newStatus, { calculateCosts } = {}) {
  const { data } = await request({
    method: "POST",
    url: `/project/${projectUuid}/status`,
    data: { newStatus, ...(calculateCosts !== undefined ? { calculateCosts } : {}) },
  });
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for wxrks errors that mean "try again shortly", not "this failed":
 * BWX-002 (422 -- org-level automation is mid-transition on this project) and
 * 423 Locked (the project is locked while an async cost calculation, kicked
 * off by calculateCosts:true, is still running).
 */
function isRetryableStatusConflict(err) {
  const status = err.response?.status;
  if (status === 423) return true;
  if (status === 422 && err.response?.data?.code === "BWX-002") return true;
  return false;
}

/**
 * Drives a project from `fromStatus` to `toStatus`, polling the *real*
 * project state to confirm the transition actually landed rather than
 * trusting an optimistic 200 (status changes are eventually consistent on
 * wxrks's side -- immediately re-reading right after a successful POST can
 * still show the old status). Also tolerates wxrks locking the project while
 * its own background jobs (org automation, async cost calculation) are
 * still running, by simply waiting instead of erroring.
 */
async function waitForTransition(projectUuid, fromStatus, toStatus, opts, { timeoutMs = 45000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let triggered = false;

  while (Date.now() < deadline) {
    const { status } = await getProject(projectUuid);
    if (status !== fromStatus) return status;

    if (!triggered) {
      try {
        await updateProjectStatus(projectUuid, toStatus, opts);
        triggered = true;
      } catch (err) {
        if (!isRetryableStatusConflict(err)) throw err;
      }
    }
    await sleep(intervalMs);
  }

  return (await getProject(projectUuid)).status;
}

/**
 * Drives a freshly created project through to APPROVED so translation work
 * can start without a human manually approving it in the wxrks UI. Tolerant
 * of the project already being past DRAFT, and of wxrks's own org-level
 * automation concurrently advancing the same project (observed: some org
 * units auto-transition DRAFT -> PENDING a few seconds after work units are
 * created).
 */
async function approveProject(projectUuid) {
  let status = await waitForTransition(projectUuid, "DRAFT", "PENDING", { calculateCosts: true });
  if (status === "PENDING") {
    status = await waitForTransition(projectUuid, "PENDING", "APPROVED");
  }
  return status;
}

async function createProject({ reference, sourceLocale, orgUnitUUID, contactUUID, notes }) {
  const { data } = await request({
    method: "POST",
    url: "/project?inferDefaultSettings=true",
    data: {
      reference,
      orgUnitUUID,
      sourceLocale,
      ...(contactUUID ? { contactUUID } : {}),
      ...(notes ? { notes } : {}),
    },
  });
  const uuid = data?.uuid;
  if (!uuid) {
    throw new Error("wxrks did not return a project UUID");
  }
  return { uuid, raw: data };
}

/**
 * Creates a project resource entry. `name` must include a file extension
 * (e.g. "item123__heroTitle.json") — wxrks uses it to select a parser.
 */
async function createResource(projectUuid, { name, path, notes }) {
  const { data } = await request({
    method: "POST",
    url: `/project/${projectUuid}/resource`,
    data: { name, path: path || name, notes },
  });
  const resourceId = data?.uuid;
  if (!resourceId) {
    throw new Error("wxrks did not return a resource uuid");
  }
  return { resourceId, raw: data };
}

/**
 * Uploads the resource's file content as multipart/form-data (the API does
 * not accept a raw JSON body for this endpoint).
 */
async function uploadResourceContent(projectUuid, resourceId, buffer, filename) {
  const form = new FormData();
  form.append("file", buffer, { filename });

  const { data } = await request({
    method: "PUT",
    url: `/project/${projectUuid}/resource/${resourceId}/content`,
    data: form,
    headers: form.getHeaders(),
  });
  return data;
}

/**
 * workUnits: [{ resourceId, workflows: ["TRANSLATION"], targetLocales: [...] }]
 * wxrks expects a plain array body, not { workUnits: [...] }.
 */
async function createWorkUnitsBulk(projectUuid, workUnits) {
  const { data } = await request({
    method: "POST",
    url: `/project/${projectUuid}/work-unit?bulk=true`,
    data: workUnits.map((wu) => ({
      projectResourceUuid: wu.resourceId,
      workflows: wu.workflows || ["TRANSLATION"],
      targetLocales: wu.targetLocales,
    })),
  });
  return data;
}

async function getProjectResources(projectUuid) {
  const { data } = await request({ method: "GET", url: `/project/${projectUuid}/resource/simple` });
  return Array.isArray(data) ? data : [];
}

/**
 * Downloads translated file content for a single resource + locale.
 * Since our resources are uploaded as single-field JSON files, the response
 * for a single (resource, locale) filter is expected to be that same JSON
 * shape with the translated value substituted in.
 */
/**
 * The download endpoint always returns a ZIP archive (even filtered down to
 * one resource + one locale) with entries laid out as `{locale}/{filename}`.
 * Since we filter to exactly one resource, there's exactly one entry.
 */
/**
 * Retries on an empty ZIP -- observed live: the work-unit-DELIVERED webhook
 * can fire a moment before the translated file is actually downloadable
 * (eventually consistent, same as project status transitions), so an
 * immediate download right after the webhook can race it.
 */
async function downloadResourceTranslation(projectUuid, resourceId, locale, { retries = 4, retryDelayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await request({
      method: "GET",
      url: `/project/${projectUuid}/download?resources=${encodeURIComponent(resourceId)}&locales=${encodeURIComponent(locale)}`,
      responseType: "arraybuffer",
    });

    const zip = new AdmZip(Buffer.from(data));
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length > 0) {
      return JSON.parse(entries[0].getData().toString("utf-8"));
    }

    if (attempt >= retries) {
      throw new Error(`wxrks download for resource ${resourceId} (${locale}) contained no files`);
    }
    await sleep(retryDelayMs);
  }
}

module.exports = {
  authenticate,
  getToken,
  getOrgUnit,
  listOrgUnits,
  getOrgUnitDetails,
  getOrgUnitResources,
  getProject,
  updateProjectStatus,
  approveProject,
  createProject,
  createResource,
  uploadResourceContent,
  createWorkUnitsBulk,
  getProjectResources,
  downloadResourceTranslation,
};
