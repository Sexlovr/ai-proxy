"use strict";

const crypto = require("crypto");
const { stmts } = require("../db/database");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SESSION_TTL    = 24 * 60 * 60; // seconds

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createSession() {
  const token     = generateToken();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL;
  stmts.insertSession.run({ token, expires_at: expiresAt });
  try { stmts.pruneExpiredSessions.run(); } catch (_) {}
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const row = stmts.getSession.get(token);
  return !!row;
}

function destroySession(token) {
  try { stmts.deleteSession.run(token); } catch (_) {}
}

function requireAdminAuth(req, res, next) {
  // GET /admin => req.path === "/"
  if (req.method === "GET" && (req.path === "/" || req.path === "")) return next();

  // Allow login/logout endpoints without session
  // POST /admin/login => req.path === "/login"
  if (req.method === "POST" && (req.path === "/login" || req.path === "/logout")) return next();

  const token = req.cookies?.admin_token;

  if (!validateSession(token)) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/admin");
  }

  next();
}

module.exports = {
  ADMIN_PASSWORD,
  createSession,
  validateSession,
  destroySession,
  requireAdminAuth,
};
