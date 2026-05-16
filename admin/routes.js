"use strict";

const express = require("express");
const path    = require("path");
const router  = express.Router();

const {
  ADMIN_PASSWORD,
  createSession,
  destroySession,
  requireAdminAuth,
} = require("./auth");

const { db, stmts, getDashboardData } = require("../db/database");

router.use(requireAdminAuth);

router.get(["/", ""], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

router.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token  = createSession();
  const maxAge = 24 * 60 * 60; // seconds
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  // Express doesn't have res.cookie() unless cookie-parser is installed
  res.setHeader(
    "Set-Cookie",
    `admin_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/${secure}`
  );

  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) destroySession(token);

  res.setHeader(
    "Set-Cookie",
    "admin_token=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/"
  );

  res.json({ ok: true });
});

router.get("/api/dashboard", (req, res) => {
  const window = parseInt(req.query.window, 10) || 86400;
  const data   = getDashboardData(window);

  data.keys = (data.keys || []).map(k => ({
    ...k,
    key_value: k.key_value.slice(0, 8) + "••••••••" + k.key_value.slice(-4),
  }));

  res.json(data);
});

// KEYS
router.post("/api/keys", (req, res) => {
  const { provider_id, key_value, nickname } = req.body || {};

  if (!provider_id?.trim()) return res.status(400).json({ error: "provider_id is required" });
  if (!key_value?.trim())   return res.status(400).json({ error: "key_value is required" });

  try {
    stmts.insertKey.run({
      provider_id: provider_id.trim(),
      key_value:   key_value.trim(),
      nickname:    nickname?.trim() || "",
    });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Key already exists" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/keys/:id", (req, res) => {
  stmts.deleteKey.run(req.params.id);
  res.json({ ok: true });
});

router.patch("/api/keys/:id/toggle", (req, res) => {
  stmts.toggleKey.run(req.params.id);
  res.json({ ok: true });
});

// PROVIDERS
router.get("/api/providers", (_req, res) => {
  res.json(stmts.getAllProviders.all());
});

router.post("/api/providers", (req, res) => {
  const { nickname, base_url } = req.body || {};
  if (!base_url?.trim()) return res.status(400).json({ error: "base_url is required" });

  let url = base_url.trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) return res.status(400).json({ error: "base_url must end with /v1" });

  const existingCount = stmts.getAllProviders.all().length;
  const provider_id   = `provider_${existingCount + 1}`;

  stmts.insertProvider.run({
    provider_id,
    nickname: nickname?.trim() || `Provider ${existingCount + 1}`,
    base_url: url,
  });

  res.json({ ok: true, provider_id });
});

// Update base_url (needed for your “configure from website” plan)
router.patch("/api/providers/:id", (req, res) => {
  const { base_url } = req.body || {};
  if (!base_url?.trim()) return res.status(400).json({ error: "base_url is required" });

  let url = base_url.trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) return res.status(400).json({ error: "base_url must end with /v1" });

  stmts.updateProviderUrl.run({ provider_id: req.params.id, base_url: url });
  res.json({ ok: true });
});

router.patch("/api/providers/:id/toggle", (req, res) => {
  stmts.toggleProvider.run(req.params.id);
  res.json({ ok: true });
});

router.delete("/api/providers/:id", (req, res) => {
  stmts.deleteProvider.run(req.params.id);
  res.json({ ok: true });
});

// MAPPINGS
router.get("/api/mappings", (_req, res) => {
  res.json(stmts.getAllMappings.all());
});

router.post("/api/mappings", (req, res) => {
  const { provider_id, clean_name, real_name } = req.body || {};
  if (!provider_id || !clean_name || !real_name) {
    return res.status(400).json({ error: "provider_id, clean_name, real_name are required" });
  }

  stmts.insertMapping.run({
    provider_id: provider_id.trim(),
    clean_name:  clean_name.trim(),
    real_name:   real_name.trim(),
  });

  res.json({ ok: true });
});

router.post("/api/mappings/bulk", (req, res) => {
  const { provider_id, mappings } = req.body || {};
  if (!provider_id || !mappings || typeof mappings !== "object") {
    return res.status(400).json({ error: "provider_id and mappings object are required" });
  }

  const txn = db.transaction((entries) => {
    for (const [clean_name, real_name] of entries) {
      stmts.insertMapping.run({
        provider_id: provider_id.trim(),
        clean_name:  String(clean_name).trim(),
        real_name:   String(real_name).trim(),
      });
    }
  });

  txn(Object.entries(mappings));
  res.json({ ok: true, count: Object.keys(mappings).length });
});

router.patch("/api/mappings/:id/toggle", (req, res) => {
  stmts.toggleMapping.run(req.params.id);
  res.json({ ok: true });
});

router.delete("/api/mappings/:id", (req, res) => {
  stmts.deleteMapping.run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
