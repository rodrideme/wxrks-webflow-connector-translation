const express = require("express");
const store = require("../store");
const webflow = require("../services/webflow");
const autoSyncSelfWrites = require("../services/autoSyncSelfWrites");

const router = express.Router();

/**
 * GET /api/slug-suggestions
 * Pending candidate slugs awaiting approval (settings.slugHandling.finalization
 * === "review") -- see routes/webhooks.js's wxrks-webhook handler for where
 * these get created.
 */
router.get("/", async (req, res) => {
  try {
    const suggestions = await store.listPendingSlugSuggestions(req.account.id);
    res.json({ suggestions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/slug-suggestions/:id/resolve
 * body: { action: "approve"|"reject", editedSlug? }
 * On approve, re-validates the (possibly admin-edited) slug through the
 * same sanitizer used when the suggestion was first computed -- never
 * trusts a stored or hand-typed string as already valid -- then patches it
 * into Webflow directly (this is the only field being written here, unlike
 * the normal translation write-back which patches a whole batch of fields
 * at once).
 */
router.post("/:id/resolve", async (req, res) => {
  try {
    const { action, editedSlug } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "action must be \"approve\" or \"reject\"" });
    }
    const suggestion = await store.getPendingSlugSuggestion(req.account.id, req.params.id);
    if (!suggestion) return res.status(404).json({ error: "Suggestion not found" });
    if (suggestion.status !== "pending") {
      return res.status(409).json({ error: `Suggestion already ${suggestion.status}` });
    }

    let appliedSlug;
    if (action === "approve") {
      const settings = await store.getSettings(req.account.id);
      const slug = webflow.sanitizeSlug(editedSlug || suggestion.candidateSlug, {
        maxLength: settings.slugHandling.maxLength,
        fallback: suggestion.sourceSlug,
      });
      await webflow.patchItemLocale(suggestion.webflowCollectionId, suggestion.webflowItemId, suggestion.locale, {
        slug,
      });
      autoSyncSelfWrites.markSelfWrite(suggestion.webflowCollectionId, suggestion.webflowItemId);
      if (settings.autoPublish) {
        await webflow.publishItems(suggestion.webflowCollectionId, [suggestion.webflowItemId]);
      }
      appliedSlug = slug;
    }

    const resolved = await store.resolvePendingSlugSuggestion(req.account.id, req.params.id, { action, appliedSlug });
    res.json(resolved);
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
