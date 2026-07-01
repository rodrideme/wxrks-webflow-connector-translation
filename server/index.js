require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const collectionsRouter = require("./routes/collections");
const syncRouter = require("./routes/sync");
const webhooksRouter = require("./routes/webhooks");
const settingsRouter = require("./routes/settings");
const configRouter = require("./routes/config");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Webflow Translation Sync server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to run database migrations:", err.message);
    process.exit(1);
  });
