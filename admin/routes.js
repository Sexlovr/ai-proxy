"use strict";
const express = require("express");
const path = require("path");
const router = express.Router();
const { ADMIN_PASSWORD, createSession, destroySession, requireAdminAuth } = require("./auth");
const store = require("../store/store");

router.use(requireAdminAuth);

router.get(["/", ""], (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));

// ── Login / Logout ──────────────────────────────────────────────────────────
router.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid password" });
  const token = createSession();
  const maxAge = 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `admin_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/${secure}`);
  res.json({ ok: true });
});
router.post("/logout", (req, res) => {
  const token = req.cookies && req.cookies.admin_token;
  if (token) destroySession(token);
  res.setHeader("Set-Cookie", "admin_token=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/");
  res.json({ ok: true });
});

// ── Dashboard ───────────────────────────────────────────────────────────────
router.get("/api/dashboard", (req, res) => {
  const windowSecs = parseInt(req.query.window, 10) || 86400;
  const data = store.getDashboardData(windowSecs);
  // NEVER expose raw upstream keys client-side — even to the logged-in admin.
  if (Array.isArray(data.keys)) data.keys = data.keys.map(k => ({ ...k, key_value: store.maskKey(k.key_value) }));
  res.json(data);
});

// ── Providers ───────────────────────────────────────────────────────────────
router.get("/api/providers", (_req, res) => res.json(store.getAllProviders()));
router.post("/api/providers", (req, res) => {
  const { nickname, base_url } = req.body || {};
  if (!base_url || !String(base_url).trim()) return res.status(400).json({ error: "base_url is required" });
  try {
    const pid = store.addProvider({ nickname: nickname || "", base_url });
    res.json({ ok: true, provider_id: pid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/api/providers/:id", (req, res) => {
  const { base_url } = req.body || {};
  if (!base_url || !String(base_url).trim()) return res.status(400).json({ error: "base_url is required" });
  store.updateProviderUrl(req.params.id, base_url);
  res.json({ ok: true });
});
router.patch("/api/providers/:id/toggle", (req, res) => { store.toggleProvider(req.params.id); res.json({ ok: true }); });
router.delete("/api/providers/:id", (req, res) => { store.deleteProvider(req.params.id); res.json({ ok: true }); });

// ── API keys (upstream) — always masked in GET endpoints ────────────────────
router.post("/api/keys", (req, res) => {
  const { provider_id, key_value, nickname } = req.body || {};
  if (!provider_id || !String(provider_id).trim()) return res.status(400).json({ error: "provider_id is required" });
  if (!key_value || !String(key_value).trim())  return res.status(400).json({ error: "key_value is required" });
  try { store.addKey({ provider_id: String(provider_id).trim(), key_value: String(key_value).trim(), nickname: nickname || "" }); res.json({ ok: true }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
router.delete("/api/keys/:id", (req, res) => { store.deleteKey(+req.params.id); res.json({ ok: true }); });
router.patch("/api/keys/:id/toggle", (req, res) => { store.toggleKey(+req.params.id); res.json({ ok: true }); });

// ── Model mappings (legacy 1→1 tab) ──────────────────────────────────────────
router.get("/api/mappings", (_req, res) => res.json(store.getAllMappings()));
router.post("/api/mappings", (req, res) => {
  const { provider_id, clean_name, real_name } = req.body || {};
  if (!provider_id || !clean_name || !real_name) return res.status(400).json({ error: "provider_id, clean_name, real_name are required" });
  store.addMapping({ provider_id: String(provider_id).trim(), clean_name: String(clean_name).trim(), real_name: String(real_name).trim() });
  res.json({ ok: true });
});
router.post("/api/mappings/bulk", (req, res) => {
  const { provider_id, mappings } = req.body || {};
  if (!provider_id || !mappings || typeof mappings !== "object") return res.status(400).json({ error: "provider_id and mappings object are required" });
  store.bulkMappings({ provider_id, mappings });
  res.json({ ok: true, count: Object.keys(mappings).length });
});
router.patch("/api/mappings/:id/toggle", (req, res) => { store.toggleMapping(+req.params.id); res.json({ ok: true }); });
router.delete("/api/mappings/:id", (req, res) => { store.deleteMapping(+req.params.id); res.json({ ok: true }); });

// ── Model Groups — new advanced round-robin tab ──────────────────────────────
// Each row: { clean_name (downstream), provider_id (links to provider's base_url),
//             upstream_model_id (what we send to that upstream), order, is_active }.
// Downstream model = `clean_name` shared among many rows.
router.get("/api/groups", (_req, res) => res.json(store.getAllGroups()));
router.post("/api/groups", (req, res) => {
  const { clean_name, provider_id, upstream_model_id, order } = req.body || {};
  if (!clean_name || !provider_id || !upstream_model_id)
    return res.status(400).json({ error: "clean_name, provider_id, upstream_model_id are required" });
  if (!store.getProvider(provider_id))
    return res.status(400).json({ error: "Provider not found" });
  store.addGroup({ clean_name: String(clean_name).trim(), provider_id: String(provider_id).trim(), upstream_model_id: String(upstream_model_id).trim(), order });
  res.json({ ok: true });
});
router.patch("/api/groups/:id/order", (req, res) => {
  const { order } = req.body || {};
  if (!Number.isFinite(+order)) return res.status(400).json({ error: "order must be a number" });
  store.setGroupOrder(+req.params.id, +order);
  res.json({ ok: true });
});
router.patch("/api/groups/:id/toggle", (req, res) => { store.toggleGroup(+req.params.id); res.json({ ok: true }); });
router.delete("/api/groups/:id", (req, res) => { store.deleteGroup(+req.params.id); res.json({ ok: true }); });

// ── Token usage + error log (windowed JSONL scans) ────────────────────────────
router.get("/api/tokens", (req, res) => {
  const w = parseInt(req.query.window, 10) || 86400;
  res.json(store.getTokenData(w));
});
router.get("/api/error-log", (req, res) => {
  const w = parseInt(req.query.window, 10) || 86400;
  res.json(store.getErrorLogData(w));
});

module.exports = router;
