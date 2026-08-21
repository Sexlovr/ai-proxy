"use strict";
// lib/discordAuth.js — Discord OAuth2 + guild membership gate.
// Env:
//   DISCORD_CLIENT_ID     — OAuth2 client id
//   DISCORD_CLIENT_SECRET — OAuth2 client secret
//   DISCORD_BOT_TOKEN     — bot token used to check guild membership
//   DISCORD_GUILD_ID      — the designated server users MUST be a member of
//   DISCORD_REDIRECT_URL  — optional override (default: <origin>/auth/discord/callback)
//
// If DISCORD_CLIENT_ID is not set, Discord login is disabled and the auth pages
// show a friendly "not configured yet" notice instead of failing hard.

const crypto = require("crypto");

const API = "https://discord.com/api/v10";

const CFG = {
  client_id:     process.env.DISCORD_CLIENT_ID     || "",
  client_secret: process.env.DISCORD_CLIENT_SECRET || "",
  bot_token:     process.env.DISCORD_BOT_TOKEN     || "",
  guild_id:      process.env.DISCORD_GUILD_ID      || "",
  redirect_url:  process.env.DISCORD_REDIRECT_URL  || "",
};

function discordEnabled() { return !!(CFG.client_id && CFG.client_secret); }
function guildGateEnabled() { return !!(CFG.bot_token && CFG.guild_id); }

function buildRedirectUri(req) {
  if (CFG.redirect_url) return CFG.redirect_url;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/auth/discord/callback`;
}

function makeState() { return crypto.randomBytes(16).toString("hex"); }

const _states = new Map(); // state -> expires ms
function stashState(state) { _states.set(state, Date.now() + 10 * 60 * 1000); if (_states.size > 500) pruneStates(); }
function consumeState(state) {
  const exp = _states.get(state);
  _states.delete(state);
  return !!exp && exp > Date.now();
}
function pruneStates() {
  const now = Date.now();
  for (const [k, v] of _states) if (v < now) _states.delete(k);
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: CFG.client_id,
    client_secret: CFG.client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const r = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token exchange failed (" + r.status + ")");
  return r.json();
}

async function fetchDiscordUser(accessToken) {
  const r = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error("failed to load discord user (" + r.status + ")");
  return r.json();
}

async function fetchUserGuilds(accessToken) {
  const r = await fetch(`${API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error("failed to load guilds (" + r.status + ")");
  return r.json();
}

// Bot-based membership check (most reliable; works even when user hides mutual guilds).
async function isMemberViaBot(userId) {
  if (!CFG.bot_token || !CFG.guild_id) return null; // not configured
  try {
    const r = await fetch(`${API}/guilds/${CFG.guild_id}/members/${userId}`, {
      headers: { Authorization: `Bot ${CFG.bot_token}` },
    });
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    if (r.status === 403) return null; // bot lacks access
    return null;
  } catch (_) { return null; }
}

// Combined gate: user must be in the designated guild.
// Priority: bot check (exact) → user-guilds check (approximate).
async function checkGuildMembership(accessToken, userId) {
  if (!CFG.guild_id) return { ok: true, configured: false };
  const viaBot = await isMemberViaBot(userId);
  if (viaBot !== null) return { ok: viaBot, configured: true };
  try {
    const guilds = await fetchUserGuilds(accessToken);
    const ok = Array.isArray(guilds) && guilds.some(g => g.id === CFG.guild_id);
    return { ok, configured: true };
  } catch (_) {
    return { ok: false, configured: true, reason: "guild_check_failed" };
  }
}

module.exports = {
  CFG, API,
  discordEnabled, guildGateEnabled,
  buildRedirectUri, makeState, stashState, consumeState,
  exchangeCode, fetchDiscordUser, fetchUserGuilds,
  checkGuildMembership, isMemberViaBot,
};
