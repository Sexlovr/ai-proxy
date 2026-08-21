"use strict";
// routes/auth.js — Discord OAuth login + user panel API.
// Mount points (added in server.js):
//   GET  /auth/discord          — start OAuth flow
//   GET  /auth/discord/callback — finish OAuth, gate guild, create session
//   POST /auth/logout           — kill user session
//   GET  /api/me                — current user info + personal key
//   POST /api/me/regenerate-key — rotate personal proxy key
//   GET  /api/me/usage          — per-user usage (requests/tokens)

const express = require("express");
const path = require("path");
const router = express.Router();
const discord = require("../lib/discordAuth");
const users = require("../lib/users");
const userAuth = require("../lib/userAuth");

const COOKIE = "user_session";

function setUserCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${userAuth.TTL}; Path=/`);
}
function clearUserCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

function currentUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  const sess = userAuth.get(token);
  if (!sess) return null;
  const u = users.readUsers().find(x => x.id === sess.userId);
  return u && u.is_active ? u : null;
}

// ── pages ────────────────────────────────────────────────────────────────
router.get("/discord", (req, res) => {
  if (!discord.discordEnabled()) {
    return res.redirect("/login?error=not_configured");
  }
  const state = discord.makeState();
  discord.stashState(state);
  const redirectUri = discord.buildRedirectUri(req);
  const url = "https://discord.com/oauth2/authorize?" + new URLSearchParams({
    client_id: discord.CFG.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state,
    prompt: "consent",
  }).toString();
  res.redirect(url);
});

router.get("/discord/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect("/login?error=" + encodeURIComponent(error));
  if (!code || !state || !discord.consumeState(String(state))) {
    return res.redirect("/login?error=invalid_state");
  }
  try {
    const redirectUri = discord.buildRedirectUri(req);
    const tokenSet = await discord.exchangeCode(String(code), redirectUri);
    const profile = await discord.fetchDiscordUser(tokenSet.access_token);

    // designated-server gate
    const gate = await discord.checkGuildMembership(tokenSet.access_token, profile.id);
    if (!gate.ok) {
      const reason = gate.reason === "guild_check_failed" ? "guild_check_failed" : "not_member";
      return res.redirect("/login?error=" + reason);
    }

    const user = users.upsertFromDiscord(profile);
    if (!user.is_active) return res.redirect("/login?error=disabled");

    const token = userAuth.create(user.id);
    setUserCookie(res, token);
    return res.redirect("/dashboard");
  } catch (e) {
    console.warn("[auth] discord callback failed:", e.message);
    return res.redirect("/login?error=callback_failed");
  }
});

router.post("/logout", (req, res) => {
  const token = req.cookies && req.cookies[COOKIE];
  userAuth.destroy(token);
  clearUserCookie(res);
  res.json({ ok: true });
});

// ── user panel API ───────────────────────────────────────────────────────
function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  req.user = u;
  next();
}

router.get("/me", requireUser, (req, res) => {
  res.json({ user: users.publicUser(req.user), base_url: req.protocol + "://" + req.get("host") + "/v1" });
});

router.get("/me/full-key", requireUser, (req, res) => {
  res.json({ key: req.user.key });
});

router.post("/me/regenerate-key", requireUser, (req, res) => {
  const newKey = users.regenerateKey(req.user.id);
  if (!newKey) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true, key: newKey });
});

router.get("/me/usage", requireUser, (req, res) => {
  res.json({ requests: req.user.requests || 0, tokens: req.user.tokens || 0 });
});

module.exports = { router, COOKIE, currentUser, requireUser, setUserCookie, clearUserCookie };
