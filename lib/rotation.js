"use strict";
// lib/rotation.js — builds the slot list used by the proxy for the two routing modes.
//   group   : one downstream model → N providers (advanced interleaved round-robin)
//   single  : one downstream model → one provider (legacy per-key rotation)
//
// The interleaved group ordering is:
//   ProviderA·key1  → ProviderB·key1  → ProviderC·key1
//   → ProviderA·key2 → ProviderB·key2 → ProviderC·key2 → …
// i.e. round-robin across providers first (outer loop), then across keys (inner).
// This is achieved by nesting the iteration:
//     for keyIdx in 0..maxKeys-1:
//       for row in rows (by order):
//         if provider has key at keyIdx: emit slot
//
// The proxy controller drives the retry loop using the per-name cursor in store.state.cursors,
// calling bumpKeyUsed / bumpKey429 as it tries each slot. That logic lives in server.js.

const store = require("../store/store");

function buildGroupSlots(cleanName) {
  const rows = store.getActiveGroupRows(cleanName);
  if (!rows || rows.length === 0) return null;
  const slots = [];
  let maxKeys = 0;
  for (const r of rows) {
    const n = store.getActiveKeys(r.provider_id).length;
    if (n > maxKeys) maxKeys = n;
  }
  if (maxKeys === 0) return null;
  for (let k = 0; k < maxKeys; k++) {
    for (const r of rows) {
      const keys = store.getActiveKeys(r.provider_id);
      if (k >= keys.length) continue;            // this provider has no k-th key
      const url = store.getProviderUrl(r.provider_id);
      if (!url) continue;                        // provider inactive / no url
      slots.push({
        provider_id:        r.provider_id,
        upstream_model_id:  r.upstream_model_id,
        url, key: keys[k], keyIdx: k,
      });
    }
  }
  return slots;
}

function buildSimpleSlots(provider_id, realName) {
  const url = store.getProviderUrl(provider_id);
  if (!url) return null;
  const keys = store.getActiveKeys(provider_id);
  if (!keys || keys.length === 0) return null;
  return keys.map((k, i) => ({
    provider_id, upstream_model_id: realName, url, key: k, keyIdx: i,
  }));
}

module.exports = { buildGroupSlots, buildSimpleSlots };
