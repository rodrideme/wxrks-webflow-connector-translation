const express = require("express");
const webflow = require("../services/webflow");
const wxrks = require("../services/wxrks");

const router = express.Router();

/**
 * GET /api/config/org-units
 * wxrks org units for the Settings UI dropdown.
 */
router.get("/org-units", async (req, res) => {
  try {
    const orgUnits = await wxrks.listOrgUnits();
    res.json({ orgUnits });
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/config/org-units/:uuid/resources
 * The Translation Memories and Glossaries bound to this org unit -- shown
 * read-only in Settings for visibility. The app doesn't let users pick
 * these; wxrks attaches them to each project automatically via
 * inferDefaultSettings=true at project creation.
 */
router.get("/org-units/:uuid/resources", async (req, res) => {
  try {
    const resources = await wxrks.getOrgUnitResources(req.params.uuid);
    res.json(resources);
  } catch (err) {
    if (err.code === "WXRKS_NOT_CONNECTED") {
      return res.status(409).json({ error: err.message, code: "wxrks_not_connected" });
    }
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/config/webflow-locales
 * The site's real registered locale tags. Webflow silently falls back to the
 * primary locale for any unrecognized `locale` value, so the UI must only
 * ever offer these — never a hardcoded or free-typed list.
 */
router.get("/webflow-locales", async (req, res) => {
  try {
    const locales = await webflow.getSiteLocales();
    res.json(locales);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
