"use strict";

// ─────────────────────────────────────────────────────────────────────────
// store.js — JSON-file persistence for ai-proxy, designed to live under a
// Hugging Face Storage Bucket mounted at /data (read-write NFS/FUSE volume).
//
// Why JSON, not SQLite:
//   HF Storage Buckets are mounted via NFS/FUSE. SQLite WAL mode is unsafe
//   over network filesystems (lock corruption + mmap fsync semantics). And a
//   full SQLite lock + rollback journal is heavier than we need for this
//   config-shaped data. So we keep everything as small JSON files with atomic
//   temp→rename writes. Each file is rewritten whole only on configuration
//   change; traffic counters + round-robin cursors are debounced.
//
// Files under DATA_DIR:
//   providers.json        — provider list (id, base_url, …)
//   api_keys.json         — keys per provider (value always masked at API edge)
//   mappings.json         — 1→1 model→provider map (legacy tab)
//   model_groups.json     — 1→N model→provider(s) advanced round-robin tab
//   sessions.json         — admin session tokens (small, low-write)
//   state.json            — round-robin cursors + per-hour aggregates + all-time
//   logs/requests.jsonl   — append-only request log (pruned to 30d)
//   logs/tokens.jsonl     — append-only token usage log (30d)
//   logs/errors.jsonl     — append-only error log (30d)
// ─────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");
const { execSync, exec } = require("child_process");

// ─── HF bucket sync ─────────────────────────────────────────────────────────
// The FUSE mount at /data is NOT writable (EACCES from every UID — HF platform
// issue). We use `hf buckets sync` CLI as the persistence layer instead.
// HF_TOKEN and SPACE_ID are auto-injected by HF Spaces — NO extra secrets needed.
// The bucket name is auto-detected from the Space's runtime via the HF API.
const HF_TOKEN  = process.env.HF_TOKEN || "";
const SPACE_ID  = process.env.SPACE_ID || "";
let _bucketId   = "";

function detectBucketId() {
  if (!HF_TOKEN || !SPACE_ID) return;
  try {
    const py = `import json,urllib.request
r=urllib.request.Request("https://huggingface.co/api/spaces/${SPACE_ID}",headers={"Authorization":"Bearer ${HF_TOKEN}"})
d=json.loads(urllib.request.urlopen(r,timeout=10).read())
for v in d.get("runtime",{}).get("volumes",[]):
 if v.get("mountPath")=="/data": print(v["source"])`;
    const out = execSync(`python3 -c '${py}'`, { timeout: 15000, stdio: "pipe" }).toString().trim();
    if (out) { _bucketId = out; console.log("[store] bucket detected:", _bucketId); }
  } catch (e) { console.warn("[store] bucket detect failed:", e.message); }
}

function bucketSyncFrom() {
  if (!_bucketId) return;
  try {
    console.log("[store] restoring from bucket:", _bucketId);
    execSync(`hf buckets sync "hf://buckets/${_bucketId}/" "${DATA_DIR}/" --ignore-times`, {
      timeout: 30000, stdio: "pipe", env: { ...process.env, HF_TOKEN }
    });
    console.log("[store] restore complete");
  } catch (e) { console.warn("[store] restore failed:", e.message); }
}

function bucketSyncTo() {
  if (!_bucketId) return;
  try {
    execSync(`hf buckets sync "${DATA_DIR}/" "hf://buckets/${_bucketId}/" --ignore-times`, {
      timeout: 30000, stdio: "pipe", env: { ...process.env, HF_TOKEN }
    });
  } catch (e) { console.warn("[store] sync failed:", e.message); }
}

let _syncTimer = null;
function scheduleBucketSync() {
  if (!_bucketId) return;
  if (_syncTimer) return;
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    exec(`hf buckets sync "${DATA_DIR}/" "hf://buckets/${_bucketId}/" --ignore-times`, {
      timeout: 30000, env: { ...process.env, HF_TOKEN }
    }, (err) => { if (err) console.warn("[store] sync error:", err.message); });
  }, 5000);
}

// ─── pickDataDir ─────────────────────────────────────────────────────────────
// Tries /data (FUSE mount). If not writable (EACCES on HF), falls back to a
// local dir for writes — but bucketSyncFrom() still restores reads from the
// bucket via the `hf` CLI before we load.
function pickDataDir() {
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(process.env.DATA_DIR);
  candidates.push("/data", path.resolve(__dirname, "..", "data"));
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tf = path.join(dir, ".__wtest_" + process.pid);
      fs.writeFileSync(tf, "ok"); fs.unlinkSync(tf);
      fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
      console.log("[store] data dir:", dir);
      return dir;
    } catch (e) { console.warn("[store] candidate", dir, "unusable:", e.message); }
  }
  const tmp = path.join(os.tmpdir(), "ai-proxy-data");
  fs.mkdirSync(path.join(tmp, "logs"), { recursive: true });
  console.warn("[store] WARNING — falling back to tmp:", tmp, " (data lost on restart!)");
  return tmp;
}
const DATA_DIR = pickDataDir();

// Auto-detect the bucket name from the HF API, then restore state from bucket.
detectBucketId();
bucketSyncFrom();
const LOG_DIR  = path.join(DATA_DIR, "logs");

// Restore state from the HF bucket BEFORE loading into memory — if FUSE
// isn't synced, this ensures we see data written in a previous run.


const NOW = () => Math.floor(Date.now() / 1000);

// ─── atomic, NFS-safe write ────────────────────────────────────────────────
function atomicWrite(file, obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = file + ".tmp." + process.pid;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  scheduleBucketSync();
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return fallback; }
}
function appendLine(file, line) {
  try { fs.appendFileSync(file, line + "\n", { flag: "a" }); } catch (e) {
    console.warn("[store] append failed", file, e.message);
  }
}

// ─── file map ──────────────────────────────────────────────────────────────
const F = {
  providers:  "providers.json",
  apiKeys:    "api_keys.json",
  mappings:   "mappings.json",
  groups:     "model_groups.json",
  sessions:   "sessions.json",
  state:      "state.json",
};
const fp = (k) => path.join(DATA_DIR, F[k]);
const L = {
  requests: path.join(LOG_DIR, "requests.jsonl"),
  tokens:   path.join(LOG_DIR, "tokens.jsonl"),
  errors:   path.join(LOG_DIR, "errors.jsonl"),
};

// ─── defaults ──────────────────────────────────────────────────────────────
const HOUR = 3600, DAY = 86400;
function newState() {
  return { cursors: {}, allTime: { totalRequests: 0, totalErrors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }, hourly: {} };
}
const SEED = {
  providers: [], apiKeys: [], mappings: [], groups: [], sessions: {},
  state: newState(),
};

// ─── load all into memory ──────────────────────────────────────────────────
const state = {
  providers: readJson(fp("providers"),  SEED.providers),
  apiKeys:   readJson(fp("apiKeys"),    SEED.apiKeys),
  mappings:  readJson(fp("mappings"),   SEED.mappings),
  groups:    readJson(fp("groups"),     SEED.groups),
  sessions:  readJson(fp("sessions"),   SEED.sessions),
  state:     Object.assign(newState(), readJson(fp("state"), {})),
};

// Validate loaded state — protect against corrupted/malformed files in the bucket
// (e.g. a test file accidentally uploaded as providers.json)
if (!Array.isArray(state.providers)) state.providers = [];
if (!Array.isArray(state.apiKeys))   state.apiKeys = [];
if (!Array.isArray(state.mappings))  state.mappings = [];
if (!Array.isArray(state.groups))    state.groups = [];
if (typeof state.sessions !== "object" || state.sessions === null || Array.isArray(state.sessions)) state.sessions = {};
state.providers = state.providers.filter(p => p && typeof p === "object" && p.provider_id);
state.apiKeys   = state.apiKeys.filter(k => k && typeof k === "object" && k.key_value);
state.mappings  = state.mappings.filter(m => m && typeof m === "object" && m.clean_name);
state.groups    = state.groups.filter(g => g && typeof g === "object" && g.clean_name);

// Normalize / migrate any half-broken state.json
if (!state.state.cursors || typeof state.state.cursors !== "object") state.state.cursors = {};
if (!state.state.allTime || typeof state.state.allTime !== "object") state.state.allTime = { totalRequests:0, totalErrors:0, promptTokens:0, completionTokens:0, totalTokens:0 };
if (!state.state.hourly || typeof state.state.hourly !== "object")  state.state.hourly  = {};

// Seed default provider if none defined and an env UPSTREAM_BASE was given.
if (state.providers.length === 0 && process.env.UPSTREAM_BASE && process.env.UPSTREAM_BASE.trim()) {
  state.providers.push({ id: 1, provider_id: "provider_1", nickname: "Main Provider", base_url: process.env.UPSTREAM_BASE.trim(), is_active: 1, added_at: NOW() });
  atomicWrite(fp("providers"), state.providers);
}
// Seed default keys from UPSTREAM_KEYS env (comma-separated) into provider_1.
if (state.apiKeys.length === 0 && process.env.UPSTREAM_KEYS) {
  const pid = state.providers[0]?.provider_id || "provider_1";
  let id = 1;
  for (const raw of String(process.env.UPSTREAM_KEYS).split(",")) {
    const k = raw.trim();
    if (!k) continue;
    state.apiKeys.push({ id: id++, provider_id: pid, key_value: k, nickname: "", is_active: 1, added_at: NOW(), last_used: null, req_count: 0, err_429: 0 });
  }
  if (state.apiKeys.length) atomicWrite(fp("apiKeys"), state.apiKeys);
}

console.log("[store] loaded:",
  state.providers.length, "providers,",
  state.apiKeys.length,  "keys,",
  state.mappings.length, "mappings,",
  state.groups.length,   "groups",
  "| allTime reqs:", state.state.allTime.totalRequests, "errs:", state.state.allTime.totalErrors);

// ─── debounced persisters ─────────────────────────────────────────────────
const timers = {};
function debounce(key, ms, writeFn) {
  if (timers[key]) return;
  timers[key] = setTimeout(() => { timers[key] = null; try { writeFn(); } catch (e) { console.warn("[store] flush", key, e.message); } }, ms);
}
const FLUSH_MS = 500;
function persistStateNow()  { atomicWrite(fp("state"),    state.state); }
function persistApiKeysNow() { atomicWrite(fp("apiKeys"),  state.apiKeys); }
function markStateDirty()    { debounce("state",    FLUSH_MS, persistStateNow); scheduleBucketSync(); }
function markKeysDirty()     { debounce("apiKeys",  FLUSH_MS, persistApiKeysNow); scheduleBucketSync(); }
function persistAllNow() {
  for (const k of Object.keys(timers)) { clearTimeout(timers[k]); delete timers[k]; }
  atomicWrite(fp("state"),    state.state);
  atomicWrite(fp("apiKeys"),  state.apiKeys);
  atomicWrite(fp("sessions"), state.sessions);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
process.on("exit",    () => { try { persistAllNow(); } catch (_) {} });
function shutdown() {
  try { persistAllNow(); } catch (_) {}
  try { bucketSyncTo();   } catch (_) {}
  console.log("[store] flushed & exiting");
  process.exit(0);
}

// ─── session-id / client detection (matches prior behavior) ────────────────
function makeSessionId(ua) {
  const day = Math.floor(Date.now() / 86400000);
  return crypto.createHash("sha256").update((ua || "unknown") + "|" + day).digest("hex").slice(0, 16);
}
function detectClient(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (s.includes("sillytavern"))            return "SillyTavern";
  if (s.includes("janitorai") || s.includes("janitor")) return "Janitor AI";
  if (s.includes("chub"))                   return "Chub.ai";
  if (s.includes("openai"))                 return "OpenAI SDK";
  if (s.includes("python"))                 return "Python";
  if (s.includes("curl"))                   return "cURL";
  return "Unknown";
}

// ─── providers ─────────────────────────────────────────────────────────────
function getAllProviders()   { return state.providers.slice(); }
function getActiveProviders(){ return state.providers.filter(p => p.is_active); }
function getProvider(pid)    { return state.providers.find(p => p.provider_id === pid); }
function getProviderUrl(pid) { const p = getProvider(pid); return p ? p.base_url : null; }

function nextProviderId() {
  let max = 0;
  for (const p of state.providers) { const m = String(p.provider_id).match(/^provider_(\d+)$/); if (m) max = Math.max(max, +m[1]); }
  return "provider_" + (max + 1);
}
function addProvider({ nickname, base_url }) {
  const url = normalizeUrl(base_url);
  const pid = nextProviderId();
  state.providers.push({ id: state.providers.reduce((m,p)=>Math.max(m,p.id),0) + 1, provider_id: pid, nickname: nickname || pid, base_url: url, is_active: 1, added_at: NOW() });
  atomicWrite(fp("providers"), state.providers);
  return pid;
}
function updateProviderUrl(pid, base_url) {
  const p = getProvider(pid); if (!p) return;
  p.base_url = normalizeUrl(base_url);
  atomicWrite(fp("providers"), state.providers);
}
function toggleProvider(pid) { const p = getProvider(pid); if (p) { p.is_active = p.is_active ? 0 : 1; atomicWrite(fp("providers"), state.providers); } }
function deleteProvider(pid) {
  state.providers = state.providers.filter(p => p.provider_id !== pid);
  state.apiKeys   = state.apiKeys.filter(k => k.provider_id !== pid);
  atomicWrite(fp("providers"), state.providers);
  atomicWrite(fp("apiKeys"),   state.apiKeys);
}

// ─── api keys ──────────────────────────────────────────────────────────────
function getAllKeys()        { return state.apiKeys.slice(); }
function getActiveKeys(pid)  { return state.apiKeys.filter(k => k.provider_id === pid && k.is_active).sort((a,b)=>a.added_at-b.added_at).map(k => k.key_value); }
function addKey({ provider_id, key_value, nickname }) {
  if (state.apiKeys.some(k => k.key_value === key_value)) throw new Error("Key already exists");
  const id = state.apiKeys.reduce((m,k)=>Math.max(m,k.id),0) + 1;
  state.apiKeys.push({ id, provider_id, key_value, nickname: nickname || "", is_active: 1, added_at: NOW(), last_used: null, req_count: 0, err_429: 0 });
  atomicWrite(fp("apiKeys"), state.apiKeys);
}
function deleteKey(id) {
  state.apiKeys = state.apiKeys.filter(k => k.id !== id);
  atomicWrite(fp("apiKeys"), state.apiKeys);
}
function toggleKey(id) { const k = state.apiKeys.find(k => k.id === id); if (k) { k.is_active = k.is_active ? 0 : 1; atomicWrite(fp("apiKeys"), state.apiKeys); } }
function bumpKeyUsed(pid, key) {
  const k = state.apiKeys.find(x => x.provider_id === pid && x.key_value === key);
  if (k) { k.req_count++; k.last_used = NOW(); markKeysDirty(); }
}
function bumpKey429(pid, key) {
  const k = state.apiKeys.find(x => k_id_match(x, pid, key));
  if (k) { k.err_429++; markKeysDirty(); }
}
function k_id_match(x, pid, key) { return x.provider_id === pid && x.key_value === key; }

// ─── mappings (1→1 legacy tab) ─────────────────────────────────────────────
function getAllMappings() { return state.mappings.slice(); }
function getActiveMappings() {
  const m = {};
  for (const r of state.mappings) if (r.is_active) m[r.clean_name] = { real: r.real_name, provider_id: r.provider_id };
  return m;
}
function addMapping({ provider_id, clean_name, real_name }) {
  clean_name = clean_name.trim(); real_name = real_name.trim();
  const idx = state.mappings.findIndex(m => m.clean_name === clean_name);
  const row = { id: idx >= 0 ? state.mappings[idx].id : state.mappings.reduce((m,x)=>Math.max(m,x.id),0)+1,
                provider_id, clean_name, real_name, is_active: 1, added_at: NOW() };
  if (idx >= 0) state.mappings[idx] = row; else state.mappings.push(row);
  atomicWrite(fp("mappings"), state.mappings);
}
function bulkMappings({ provider_id, mappings }) {
  const entries = Object.entries(mappings);
  for (const [cn, rn] of entries) {
    const clean = cn.trim(), real = String(rn).trim();
    const idx = state.mappings.findIndex(m => m.clean_name === clean);
    const row = { id: idx >= 0 ? state.mappings[idx].id : state.mappings.reduce((m,x)=>Math.max(m,x.id),0)+1,
                  provider_id, clean_name: clean, real_name: real, is_active: 1, added_at: NOW() };
    if (idx >= 0) state.mappings[idx] = row; else state.mappings.push(row);
  }
  atomicWrite(fp("mappings"), state.mappings);
}
function toggleMapping(id) { const m = state.mappings.find(x => x.id === id); if (m) { m.is_active = m.is_active ? 0 : 1; atomicWrite(fp("mappings"), state.mappings); } }
function deleteMapping(id) { state.mappings = state.mappings.filter(m => m.id !== id); atomicWrite(fp("mappings"), state.mappings); }

// ─── model groups (new advanced round-robin tab) ───────────────────────────
// Each group row: one downstream model <-> one (provider + upstream_model_id).
// Downstream model `clean_name` may have many rows (multiple providers); the
// rotation module interleaves them round-robin first across providers, then
// across each provider's keys.
function getAllGroups() { return state.groups.slice(); }
function getActiveGroupRows(cleanName) {
  return state.groups
    .filter(g => g.is_active && g.clean_name === cleanName)
    .sort((a,b) => (a.order ?? 0) - (b.order ?? 0) || a.added_at - b.added_at);
}
function cleanNamesWithGroups() { return [...new Set(state.groups.filter(g => g.is_active).map(g => g.clean_name))]; }
function addGroup({ clean_name, provider_id, upstream_model_id, order }) {
  clean_name = clean_name.trim(); upstream_model_id = upstream_model_id.trim();
  const id = state.groups.reduce((m,g)=>Math.max(m,g.id),0) + 1;
  state.groups.push({ id, clean_name, provider_id, upstream_model_id, is_active: 1, added_at: NOW(), order: Number.isFinite(+order) ? +order : id });
  atomicWrite(fp("groups"), state.groups);
}
function setGroupOrder(id, order) { const g = state.groups.find(x => x.id === id); if (g) { g.order = +order; atomicWrite(fp("groups"), state.groups); } }
function toggleGroup(id) { const g = state.groups.find(x => x.id === id); if (g) { g.is_active = g.is_active ? 0 : 1; atomicWrite(fp("groups"), state.groups); } }
function deleteGroup(id) { state.groups = state.groups.filter(g => g.id !== id); atomicWrite(fp("groups"), state.groups); }

// ─── round-robin cursors (persisted in state.json) ─────────────────────────
function getCursor(name) { return state.state.cursors[name] || 0; }
function setCursor(name, v) { state.state.cursors[name] = v; markStateDirty(); }

// ─── aggregates + all-time counters ────────────────────────────────────────
function bucketOf(ts) { const t = ts - (ts % HOUR); return t; }
function currentBucket() { return bucketOf(NOW()); }
function pruneBuckets() {
  const cutoff = NOW() - 30 * DAY;
  for (const b of Object.keys(state.state.hourly)) if (+b < cutoff) delete state.state.hourly[b];
}
function ensureBucket(b) {
  if (!state.state.hourly[b]) state.state.hourly[b] = {
    total: 0, ok: 0, err: 0, avgMsSum: 0, avgMsCount: 0,
    byModel: {}, byClient: {}, byError: {}, sessions: {}
  };
  const bk = state.state.hourly[b];
  if (!bk.sessions || typeof bk.sessions !== "object") bk.sessions = {};
  return bk;
}
function bumpModelInBucket(b, model, ok, err, ms) {
  if (!b.byModel[model]) b.byModel[model] = { total:0, ok:0, err:0, pt:0, ct:0, tt:0, last:0, avgMsSum:0, avgMsCount:0 };
  const m = b.byModel[model]; m.total++; m.ok += ok; m.err += err; m.last = NOW();
  if (ms != null) { m.avgMsSum += ms; m.avgMsCount++; }
}
function bumpClientInBucket(b, client, sid, total) {
  if (!b.byClient[client]) b.byClient[client] = { total: 0, users: 0, sessions: {} };
  const c = b.byClient[client];
  c.total += total;
  if (!c.sessions[sid]) { c.sessions[sid] = 1; c.users++; }
  if (!b.sessions) b.sessions = {};
  if (!b.sessions[sid]) b.sessions[sid] = 1;
}
function bumpErrorInBucket(b, code) { b.byError[code] = (b.byError[code] || 0) + 1; }

// ─── logRequest — request + aggregate + all-time counter ───────────────────
function logRequest(o) {
  try {
    const ts = NOW();
    const b = ensureBucket(bucketOf(ts));
    const ok = o.success ? 1 : 0, err = o.success ? 0 : 1;
    b.total++; b.ok += ok; b.err += err;
    if (o.response_ms != null) { b.avgMsSum += o.response_ms; b.avgMsCount++; }
    if (o.model) bumpModelInBucket(b, o.model, ok, err, o.response_ms || null);
    const client = detectClient(o.userAgent);
    const sid = makeSessionId(o.userAgent);
    bumpClientInBucket(b, client, sid, 1);
    if (!o.success && o.error_type) bumpErrorInBucket(b, String(o.error_type));

    // all-time counters
    state.state.allTime.totalRequests++;
    if (!o.success) state.state.allTime.totalErrors++;

    // raw JSONL record (skip if file inaccessible; we don't block on it)
    appendLine(L.requests, JSON.stringify({
      ts, model: o.model || null, provider_id: o.provider_id || null,
      success: ok, error_type: o.error_type || null,
      response_ms: o.response_ms ?? null, client_type: client, session_id: sid
    }));
    markStateDirty();
    if (ts % 3600 < 30) pruneBuckets();   // cheap prune occasionally
  } catch (e) { console.warn("[store] logRequest", e.message); }
}

// ─── token usage ────────────────────────────────────────────────────────────
function logTokenUsage(model, pt, ct, tt) {
  try {
    pt = pt || 0; ct = ct || 0; tt = tt || 0;
    if (tt <= 0) return;
    const ts = NOW();
    const b = ensureBucket(bucketOf(ts));
    if (b.byModel[model]) { b.byModel[model].pt += pt; b.byModel[model].ct += ct; b.byModel[model].tt += tt; }
    state.state.allTime.promptTokens     += pt;
    state.state.allTime.completionTokens += ct;
    state.state.allTime.totalTokens      += tt;
    appendLine(L.tokens, JSON.stringify({ ts, model, prompt_tokens: pt, completion_tokens: ct, total_tokens: tt }));
    markStateDirty();
  } catch (e) { console.warn("[store] logTokenUsage", e.message); }
}

// ─── error log ──────────────────────────────────────────────────────────────
function logErrorRecord(code, model, pid, detail) {
  try {
    const ts = NOW();
    appendLine(L.errors, JSON.stringify({ ts, error_code: String(code), model: model || null, provider_id: pid || null, detail: detail ? String(detail).slice(0,500) : null }));
  } catch (e) { console.warn("[store] logErrorRecord", e.message); }
}

// ─── dashboard query ────────────────────────────────────────────────────────
function emptyOverview() { return { total: 0, successes: 0, errors: 0, unique_users: 0, avg_ms: 0, rpm_hits: 0 }; }
function getDashboardData(windowSecs) {
  const now = NOW(), from = now - windowSecs;
  let total = 0, succ = 0, err = 0, uniqueUsers = 0, rpm = 0, msSum = 0, msCount = 0;
  const byModel = {}, byClient = {}, byErr = {}, hourly = [], uniqueSessionsSet = {};

  for (const [bk, b] of Object.entries(state.state.hourly)) {
    const t = +bk;
    if (t + HOUR < from) continue;                   // bucket ended before window
    // overlapping hourly — include if bucket start >= (now - window - HOUR) basically we use any bucket whose window overlaps
    if (t < from && (t + HOUR) <= from) continue;
    const inWindow = (t + HOUR) > from;
    if (!inWindow) continue;
    hourly.push({ bucket: t, total: b.total, ok: b.ok, err: b.err });
    total += b.total; succ += b.ok; err += b.err; rpm += b.byError["429"] || 0;
    msSum += b.avgMsSum; msCount += b.avgMsCount;
    for (const [m, mv] of Object.entries(b.byModel)) {
      if (!byModel[m]) byModel[m] = { total:0, ok:0, err:0, last:0 };
      byModel[m].total += mv.total; byModel[m].ok += mv.ok; byModel[m].err += mv.err;
      byModel[m].last = Math.max(byModel[m].last, mv.last);
    }
    for (const [c, cv] of Object.entries(b.byClient)) {
      if (!byClient[c]) byClient[c] = { total:0, users:0 };
      byClient[c].total += cv.total; byClient[c].users += cv.users;
      // approximate unique — count distinct sessions across buckets is heavy; we sum approximations
    }
    for (const s of Object.keys(b.sessions || {})) uniqueSessionsSet[s] = 1;
    for (const [code, n] of Object.entries(b.byError)) byErr[code] = (byErr[code] || 0) + n;
  }
  // Re-compute unique users across window from per-bucket sessions (more accurate):
  uniqueUsers = Object.keys(uniqueSessionsSet).length;

  const overview = { total, successes: succ, errors: err, unique_users: uniqueUsers, avg_ms: msCount ? Math.round(msSum / msCount) : 0, rpm_hits: rpm };
  const topModels = Object.entries(byModel)
    .map(([model, v]) => ({ model, total: v.total, ok: v.ok, err: v.err, last_used: v.last }))
    .sort((a,b)=>b.total-a.total).slice(0, 50);
  const clientBreakdown = Object.entries(byClient)
    .map(([client_type, v]) => ({ client_type, unique_users: v.users || 0, total_requests: v.total }))
    .sort((a,b)=>b.total_requests-a.total_requests);
  const errors = Object.entries(byErr)
    .map(([error_type, count]) => ({ error_type, count }))
    .sort((a,b)=>b.count-a.count);

  // Token usage aggregates within window (from per-model per-hour buckets).
  const tokenSummary = { tokens:0, prompt:0, completion:0, reqs:0 };
  const tokenByModel = {};
  for (const [bk, b] of Object.entries(state.state.hourly)) {
    const t = +bk;
    if (t + HOUR <= from) continue;
    for (const [m, mv] of Object.entries(b.byModel)) {
      if ((mv.tt || 0) <= 0) continue;
      tokenSummary.tokens += mv.tt || 0; tokenSummary.prompt += mv.pt || 0; tokenSummary.completion += mv.ct || 0;
      tokenSummary.reqs += (mv.tt > 0 ? mv.total : 0);
      if (!tokenByModel[m]) tokenByModel[m] = { requests:0, total_prompt:0, total_completion:0, grand_total:0, last_used:0 };
      tokenByModel[m].requests += mv.total;
      tokenByModel[m].total_prompt += mv.pt || 0;
      tokenByModel[m].total_completion += mv.ct || 0;
      tokenByModel[m].grand_total += mv.tt || 0;
      tokenByModel[m].last_used = Math.max(tokenByModel[m].last_used, mv.last);
    }
  }
  const tokenModels = Object.entries(tokenByModel)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a,b)=>b.grand_total-a.grand_total);

  const allTime = { ...state.state.allTime };

  return {
    overview, hourly, topModels, clientBreakdown, errors,
    tokenSummary, tokenModels,
    allTime,
    providers: getAllProviders(),
    keys:      getAllKeys(),
    mappings:  getAllMappings(),
    groups:    getAllGroups(),
  };
}

// ─── token & error-log endpoints (re-scan JSONL within window) ─────────────
function readJsonlWindow(file, windowSecs, maxLines) {
  const out = [];
  try {
    const txt = fs.readFileSync(file, "utf8");
    const lines = txt.split("\n").filter(Boolean);
    const from = NOW() - windowSecs;
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch (_) { continue; }
      if (o.ts < from) break;
      out.unshift(o);
      if (out.length >= maxLines) break;
    }
  } catch (_) {}
  return out;
}
function getTokenData(windowSecs) {
  const rows = readJsonlWindow(L.tokens, windowSecs, 100000);
  const sum = { tokens:0, prompt:0, completion:0, reqs: rows.length };
  const byModel = {};
  for (const r of rows) {
    sum.tokens += r.total_tokens || 0; sum.prompt += r.prompt_tokens || 0; sum.completion += r.completion_tokens || 0;
    if (!byModel[r.model]) byModel[r.model] = { requests:0, total_prompt:0, total_completion:0, grand_total:0, last_used:0 };
    byModel[r.model].requests++; byModel[r.model].total_prompt += r.prompt_tokens||0;
    byModel[r.model].total_completion += r.completion_tokens||0; byModel[r.model].grand_total += r.total_tokens||0;
    byModel[r.model].last_used = Math.max(byModel[r.model].last_used, r.ts);
  }
  return { summary: sum, models: Object.entries(byModel).map(([m,v])=>({model:m, ...v})).sort((a,b)=>b.grand_total-a.grand_total) };
}
function getErrorLogData(windowSecs) {
  const recent = readJsonlWindow(L.errors, windowSecs, 200);
  const stats = {};
  for (const r of recent) stats[r.error_code] = (stats[r.error_code] || 0) + 1;
  return {
    stats: Object.entries(stats).map(([error_code, count]) => ({ error_code, count })).sort((a,b)=>b.count-a.count),
    recent
  };
}

// ─── admin sessions (stored in sessions.json, low frequency writes) ────────
function createSession(ttlSecs) {
  const token = crypto.randomBytes(32).toString("hex");
  state.sessions[token] = { expires_at: NOW() + ttlSecs };
  pruneExpiredSessions();
  atomicWrite(fp("sessions"), state.sessions);
  return token;
}
function validateSession(token) {
  if (!token) return false;
  const s = state.sessions[token];
  if (!s) return false;
  if (!s || typeof s !== "object" || !s.expires_at) { delete state.sessions[token]; return false; }
  if (s.expires_at <= NOW()) { delete state.sessions[token]; atomicWrite(fp("sessions"), state.sessions); return false; }
  return true;
}
function destroySession(token) {
  if (state.sessions[token]) { delete state.sessions[token]; atomicWrite(fp("sessions"), state.sessions); }
}
function pruneExpiredSessions() {
  const now = NOW(); let dirty = false;
  for (const t of Object.keys(state.sessions)) if (state.sessions[t].expires_at <= now) { delete state.sessions[t]; dirty = true; }
  if (dirty) atomicWrite(fp("sessions"), state.sessions);
}

// ─── model list shown to public ────────────────────────────────────────────
// Merged: clean names from (1) legacy 1→1 mappings, (2) model-group clean_names.
// Group rows act as the cleaner view; legacy mappings still respected when no group exists for that clean name.
function getPublicModelList() {
  const seen = new Set();
  const data = [];
  const push = (id) => { if (!seen.has(id)) { seen.add(id); data.push({ id, object:"model", created:1700000000, owned_by:"openai", permission:[], root:id, parent:null }); } };
  for (const g of state.groups) if (g.is_active) push(g.clean_name);
  for (const m of state.mappings) if (m.is_active) push(m.clean_name);
  return { object:"list", data };
}

// resolve a downstream model to a routing decision.
// Returns:
//   { kind:"group",   cleanName, rows:[{provider_id, upstream_model_id}], cursor } → advanced rr
//   { kind:"single",  cleanName, provider_id, real_name } → simple per-provider key rr
//   { kind:"none" }
function resolveModel(cleanName) {
  const gr = getActiveGroupRows(cleanName);
  if (gr.length) return { kind:"group", cleanName, rows: gr };
  const m = state.mappings.find(x => x.clean_name === cleanName && x.is_active);
  if (m) return { kind:"single", cleanName, provider_id: m.provider_id, real_name: m.real_name };
  return { kind:"none" };
}

// ─── helpers ───────────────────────────────────────────────────────────────
function normalizeUrl(u) {
  let url = String(u || "").trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}
function maskKey(k) {
  k = String(k || "");
  return k.length <= 12 ? "••••••••" : (k.slice(0,8) + "••••••••" + k.slice(-4));
}

module.exports = {
  DATA_DIR, LOG_DIR,
  state,
  persistAllNow, markStateDirty, markKeysDirty,
  // providers
  getAllProviders, getActiveProviders, getProvider, getProviderUrl,
  addProvider, updateProviderUrl, toggleProvider, deleteProvider,
  // keys
  getAllKeys, getActiveKeys, addKey, deleteKey, toggleKey, bumpKeyUsed, bumpKey429, maskKey,
  // mappings
  getAllMappings, getActiveMappings, addMapping, bulkMappings, toggleMapping, deleteMapping,
  // groups
  getAllGroups, getActiveGroupRows, cleanNamesWithGroups, addGroup, setGroupOrder, toggleGroup, deleteGroup,
  // cursors
  getCursor, setCursor,
  // logging
  logRequest, logTokenUsage, logErrorRecord,
  // dashboard
  getDashboardData, getTokenData, getErrorLogData,
  // sessions
  createSession, validateSession, destroySession, pruneExpiredSessions,
  // models / routing
  getPublicModelList, resolveModel,
  NOW, HOUR, DAY,
};
