"use strict";
// lib/users.js — user accounts, personal proxy keys and per-user usage tracking.
// Users sign up with Discord OAuth. Each user gets a personal proxy key
// (sk-...) usable against /v1/*. The admin can enable/disable users.

const crypto = require("crypto");
const store = require("../store/store");

// users live in their own file via the store's generic helpers: users.json
const USERS_FILE = store.DATA_DIR + "/users.json";
const fs = require("fs");

function readUsers() {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr.filter(u => u && typeof u === "object" && u.discord_id);
  } catch (_) { return []; }
}

function writeUsers(users) {
  const tmp = USERS_FILE + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function publicUser(u) {
  return {
    id: u.id,
    discord_id: u.discord_id,
    username: u.username,
    display_name: u.display_name,
    avatar: u.avatar, // full CDN url built at signup/update time
    created_at: u.created_at,
    last_login: u.last_login,
    is_active: u.is_active,
    key_preview: maskKey(u.key),
    requests: u.requests || 0,
    tokens: u.tokens || 0,
    is_admin: !!u.is_admin,
  };
}

function maskKey(k) {
  k = String(k || "");
  return k.length <= 12 ? "••••••••" : k.slice(0, 7) + "••••" + k.slice(-4);
}

function findByDiscordId(discordId) { return readUsers().find(u => u.discord_id === discordId) || null; }
function findByKey(key) {
  if (!key || typeof key !== "string") return null;
  return readUsers().find(u => u.key === key && u.is_active) || null;
}

function avatarUrl(discordId, avatarHash) {
  if (!avatarHash) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=128`;
}

function upsertFromDiscord(profile) {
  const users = readUsers();
  let u = users.find(x => x.discord_id === profile.id);
  const now = Math.floor(Date.now() / 1000);
  if (!u) {
    let maxId = 0; for (const x of users) if (x.id > maxId) maxId = x.id;
    u = {
      id: maxId + 1,
      discord_id: profile.id,
      username: profile.username || ("user-" + profile.id),
      display_name: profile.global_name || profile.username || ("user-" + profile.id),
      avatar: avatarUrl(profile.id, profile.avatar),
      key: "sk-proxy-" + crypto.randomBytes(24).toString("hex"),
      created_at: now,
      last_login: now,
      is_active: 1,
      requests: 0,
      tokens: 0,
      is_admin: 0,
    };
    users.push(u);
  } else {
    u.username = profile.username || u.username;
    u.display_name = profile.global_name || profile.username || u.display_name;
    u.avatar = avatarUrl(profile.id, profile.avatar) || u.avatar;
    u.last_login = now;
  }
  writeUsers(users);
  return u;
}

function setActive(userId, active) {
  const users = readUsers();
  const u = users.find(x => x.id === userId);
  if (!u) return false;
  u.is_active = active ? 1 : 0;
  writeUsers(users);
  return true;
}

function regenerateKey(userId) {
  const users = readUsers();
  const u = users.find(x => x.id === userId);
  if (!u) return null;
  u.key = "sk-proxy-" + crypto.randomBytes(24).toString("hex");
  writeUsers(users);
  return u.key;
}

// …usage bump helpers called by the proxy hot path…………………………
let _dirty = false;
let _cache = null;
function bumpUsage(key, reqDelta, tokDelta) {
  try {
    if (_cache === null) _cache = readUsers();
    const u = _cache.find(x => x.key === key);
    if (!u) return;
    u.requests += reqDelta || 0;
    u.tokens += tokDelta || 0;
    _dirty = true;
    if (!_timer) flushLoop();
  } catch (_) {}
}
let _timer = null;
function flushLoop() {
  _timer = setTimeout(() => {
    _timer = null;
    if (_dirty) { try { writeUsers(_cache); } catch (_) {} _dirty = false; }
  }, 5000);
  if (_timer.unref) _timer.unref();
}

function allUsersPublic() { return readUsers().map(publicUser); }

module.exports = {
  readUsers, writeUsers, publicUser, maskKey,
  findByDiscordId, findByKey, upsertFromDiscord,
  setActive, regenerateKey, bumpUsage, allUsersPublic,
};
