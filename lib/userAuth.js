"use strict";
// lib/userAuth.js — session management for logged-in Discord users.
// Sessions are stored inside the existing store sessions file under a
// separate namespace prefix so they don't collide with admin sessions.

const store = require("../store/store");
const crypto = require("crypto");

const USER_SESSION_PREFIX = "usr:";
const TTL = 7 * 24 * 60 * 60; // 7 days

function create(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  // reuse the store session map; store keyed sessions transparently.
  store.state.sessions[USER_SESSION_PREFIX + token] = {
    user_id: userId,
    expires_at: Math.floor(Date.now() / 1000) + TTL,
  };
  // persist via the store's own writer (it writes the whole sessions object)
  store.persistAllNow();
  return token;
}

function get(token) {
  if (!token) return null;
  const s = store.state.sessions[USER_SESSION_PREFIX + token];
  if (!s || typeof s !== "object") return null;
  if (s.expires_at <= Math.floor(Date.now() / 1000)) {
    delete store.state.sessions[USER_SESSION_PREFIX + token];
    return null;
  }
  return { userId: s.user_id };
}

function destroy(token) {
  if (token && store.state.sessions[USER_SESSION_PREFIX + token]) {
    delete store.state.sessions[USER_SESSION_PREFIX + token];
    store.persistAllNow();
  }
}

module.exports = { create, get, destroy, TTL, USER_SESSION_PREFIX };
