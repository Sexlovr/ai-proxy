"use strict";
// admin/auth.js — admin session auth backed by store.sessions (persisted JSON).
// PROXY_KEY (downstream) and ADMIN_PASSWORD (upstream-key/UI gate) are env-driven.
// Upstream API keys + provider URLs live in the store module and are never
// exposed here; the dashboard API masks them at the boundary (see routes.js).

const store = require("../store/store");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PROXY_KEY     = process.env.PROXY_KEY     || "want-free-ai?here-you-go-gemini";
const SESSION_TTL   = 24 * 60 * 60; // seconds

function createSession() {
  const token = store.createSession(SESSION_TTL);
  return token;
}
function validateSession(token) { return store.validateSession(token); }
function destroySession(token)  { store.destroySession(token); }

function requireAdminAuth(req, res, next) {
  // GET /admin → serve login page (no session needed).
  if (req.method === "GET" && (req.path === "/" || req.path === "")) return next();
  // POST /admin/login, /admin/logout → open endpoints.
  if (req.method === "POST" && (req.path === "/login" || req.path === "/logout")) return next();

  const token = req.cookies && req.cookies.admin_token;
  if (!validateSession(token)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/admin");
  }
  next();
}

module.exports = {
  ADMIN_PASSWORD, PROXY_KEY, SESSION_TTL,
  createSession, validateSession, destroySession, requireAdminAuth,
};
