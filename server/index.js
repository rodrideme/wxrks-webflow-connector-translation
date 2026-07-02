require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const store = require("./store");
const collectionsRouter = require("./routes/collections");
const syncRouter = require("./routes/sync");
const webhooksRouter = require("./routes/webhooks");
const settingsRouter = require("./routes/settings");
const configRouter = require("./routes/config");
const autoSyncWebhook = require("./services/autoSyncWebhook");
const autoSyncQueue = require("./services/autoSyncQueue");
const autoSyncReconciliation = require("./services/autoSyncReconciliation");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Captures the raw request body buffer alongside the parsed JSON -- needed
// to verify the Webflow webhook's HMAC signature, which is computed over
// the exact bytes received, not a re-serialized version of req.body. A
// no-op for every other route, since nothing else reads req.rawBody.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// RENDER_GIT_COMMIT is set automatically by Render for git-deployed services;
// falls back to a local git lookup for dev. Lets us verify which commit is
// actually live instead of inferring it from deploy logs/timestamps.
const deployedCommit = (() => {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  try {
    return require("child_process").execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

app.get("/api/health", (req, res) => res.json({ status: "ok", commit: deployedCommit }));

app.use("/api/collections", collectionsRouter);
app.get("/api/backlog", collectionsRouter.backlogHandler);
app.use("/api/sync", syncRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/config", configRouter);

// Serve the built React app in production.
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

db.migrate()
  .then(async () => {
    // Auto Sync startup self-heal: if it's enabled but never successfully
    // registered a webhook (e.g. a prior attempt crashed, or APP_BASE_URL
    // wasn't set yet when it was first turned on), retry once at boot.
    // Cheap and idempotent -- ensureWebhookRegistered() lists existing
    // webhooks before creating one.
    const settings = await store.getSettings();
    if (settings.autoSync.enabled) {
      if (!settings.autoSync.webhook.webflowWebhookId) {
        autoSyncWebhook
          .ensureWebhookRegistered()
          .catch((err) => console.error("Auto Sync webhook self-heal failed:", err.message));
      }
      autoSyncQueue.startFlushLoop(settings.autoSync.flushesPerDay);
      autoSyncReconciliation.startReconciliationLoop();
    }

    app.listen(PORT, () => {
      console.log(`Webflow Translation Sync server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to run database migrations:", err.message);
    process.exit(1);
  });
