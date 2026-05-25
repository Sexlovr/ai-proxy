"use strict";

const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const os       = require("os");

function pickDataDir() {
  const envDataDir = process.env.DATA_DIR;
  const candidates = [
    envDataDir,
    "/data",
    path.join(__dirname, "..", "data"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.accessSync(dir, fs.constants.W_OK);

      const testFile = path.join(dir, ".__write_test");
      fs.writeFileSync(testFile, "ok");
      fs.unlinkSync(testFile);

      console.log(`[db] using data directory: ${dir}`);
      return dir;
    } catch (err) {
      console.warn(`[db] candidate directory ${dir} not usable: ${err.message}`);
    }
  }

  const tmp = path.join(os.tmpdir(), "proxy-data");
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  console.log(`[db] falling back to tmp directory: ${tmp}`);
  return tmp;
}

const DATA_DIR = pickDataDir();
const DB_PATH  = path.join(DATA_DIR, "proxy.db");
const db       = new Database(DB_PATH);

console.log(`[db] database: ${DB_PATH}`);

db.pragma("journal_mode = WAL");
db.pragma("synchronous  = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL DEFAULT (unixepoch()),
    model         TEXT    NOT NULL,
    provider_id   TEXT    NOT NULL DEFAULT 'provider_1',
    success       INTEGER NOT NULL DEFAULT 1,
    error_type    TEXT,
    response_ms   INTEGER,
    client_type   TEXT    NOT NULL DEFAULT 'Unknown',
    session_id    TEXT    NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_requests_ts    ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);

  CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT    NOT NULL DEFAULT 'provider_1',
    key_value   TEXT    NOT NULL UNIQUE,
    nickname    TEXT    NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used   INTEGER,
    req_count   INTEGER NOT NULL DEFAULT 0,
    err_429     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS providers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT    NOT NULL UNIQUE,
    nickname    TEXT    NOT NULL DEFAULT '',
    base_url    TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS model_mappings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT    NOT NULL DEFAULT 'provider_1',
    clean_name  TEXT    NOT NULL UNIQUE,
    real_name   TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT    PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
`);

const seedProvider = db.prepare(`
  INSERT OR IGNORE INTO providers (provider_id, nickname, base_url)
  VALUES ('provider_1', 'Main Provider', @base_url)
`);
seedProvider.run({ base_url: process.env.UPSTREAM_BASE || "" });

function makeSessionId(userAgent) {
  const day = Math.floor(Date.now() / 86_400_000);
  const raw = `${userAgent || "unknown"}|${day}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function detectClient(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (s.includes("sillytavern"))     return "SillyTavern";
  if (s.includes("janitorai") || s.includes("janitor")) return "Janitor AI";
  if (s.includes("chub"))            return "Chub.ai";
  return "Unknown";
}

const stmts = {
  insertRequest: db.prepare(`
    INSERT INTO requests (model, provider_id, success, error_type, response_ms, client_type, session_id)
    VALUES (@model, @provider_id, @success, @error_type, @response_ms, @client_type, @session_id)
  `),

  overviewStats: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors,
      COUNT(DISTINCT session_id) AS unique_users,
      AVG(response_ms) AS avg_ms,
      SUM(CASE WHEN error_type='429' THEN 1 ELSE 0 END) AS rpm_hits
    FROM requests
    WHERE ts >= unixepoch() - @window_secs
  `),

  hourlyBuckets: db.prepare(`
    SELECT (ts / 3600) * 3600 AS bucket,
           COUNT(*) AS total,
           SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS err
    FROM requests
    WHERE ts >= unixepoch() - 86400
    GROUP BY bucket
    ORDER BY bucket
  `),

  topModels: db.prepare(`
    SELECT model,
           COUNT(*) AS total,
           SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS err,
           MAX(ts) AS last_used
    FROM requests
    WHERE ts >= unixepoch() - @window_secs
    GROUP BY model
    ORDER BY total DESC
    LIMIT 50
  `),

  clientBreakdown: db.prepare(`
    SELECT client_type,
           COUNT(DISTINCT session_id) AS unique_users,
           COUNT(*) AS total_requests
    FROM requests
    WHERE ts >= unixepoch() - @window_secs
    GROUP BY client_type
    ORDER BY total_requests DESC
  `),

  errorBreakdown: db.prepare(`
    SELECT COALESCE(error_type, 'unknown') AS error_type,
           COUNT(*) AS count,
           MAX(ts) AS last_at
    FROM requests
    WHERE success = 0 AND ts >= unixepoch() - @window_secs
    GROUP BY error_type
    ORDER BY count DESC
  `),

  getAllKeys: db.prepare(`
    SELECT id, provider_id, key_value, nickname, is_active,
           added_at, last_used, req_count, err_429
    FROM api_keys
    ORDER BY provider_id, added_at
  `),

  getActiveKeysByProvider: db.prepare(`
    SELECT key_value FROM api_keys
    WHERE provider_id = ? AND is_active = 1
    ORDER BY added_at
  `),

  insertKey: db.prepare(`
    INSERT INTO api_keys (provider_id, key_value, nickname)
    VALUES (@provider_id, @key_value, @nickname)
  `),

  deleteKey: db.prepare(`DELETE FROM api_keys WHERE id = ?`),

  toggleKey: db.prepare(`
    UPDATE api_keys SET is_active = CASE WHEN is_active=1 THEN 0 ELSE 1 END
    WHERE id = ?
  `),

  bumpKeyUsed: db.prepare(`
    UPDATE api_keys SET req_count = req_count+1, last_used = unixepoch()
    WHERE provider_id = ? AND key_value = ?
  `),

  bump429: db.prepare(`
    UPDATE api_keys SET err_429 = err_429+1
    WHERE provider_id = ? AND key_value = ?
  `),

  getAllProviders: db.prepare(`
    SELECT id, provider_id, nickname, base_url, is_active, added_at
    FROM providers
    ORDER BY added_at
  `),

  getActiveProviders: db.prepare(`
    SELECT provider_id, base_url FROM providers WHERE is_active = 1
  `),

  insertProvider: db.prepare(`
    INSERT INTO providers (provider_id, nickname, base_url)
    VALUES (@provider_id, @nickname, @base_url)
  `),

  deleteProvider: db.prepare(`DELETE FROM providers WHERE provider_id = ?`),

  toggleProvider: db.prepare(`
    UPDATE providers SET is_active = CASE WHEN is_active=1 THEN 0 ELSE 1 END
    WHERE provider_id = ?
  `),

  updateProviderUrl: db.prepare(`
    UPDATE providers SET base_url = @base_url WHERE provider_id = @provider_id
  `),

  getAllMappings: db.prepare(`
    SELECT id, provider_id, clean_name, real_name, is_active, added_at
    FROM model_mappings
    ORDER BY provider_id, clean_name
  `),

  getActiveMappings: db.prepare(`
    SELECT clean_name, real_name, provider_id
    FROM model_mappings
    WHERE is_active = 1
  `),

  insertMapping: db.prepare(`
    INSERT OR REPLACE INTO model_mappings (provider_id, clean_name, real_name)
    VALUES (@provider_id, @clean_name, @real_name)
  `),

  deleteMapping: db.prepare(`DELETE FROM model_mappings WHERE id = ?`),

  toggleMapping: db.prepare(`
    UPDATE model_mappings SET is_active = CASE WHEN is_active=1 THEN 0 ELSE 1 END
    WHERE id = ?
  `),

  insertSession: db.prepare(`
    INSERT INTO admin_sessions (token, expires_at)
    VALUES (@token, @expires_at)
  `),

  getSession: db.prepare(`
    SELECT token FROM admin_sessions
    WHERE token = ? AND expires_at > unixepoch()
  `),

  deleteSession: db.prepare(`DELETE FROM admin_sessions WHERE token = ?`),

  pruneExpiredSessions: db.prepare(`
    DELETE FROM admin_sessions WHERE expires_at <= unixepoch()
  `),

  pruneOldRequests: db.prepare(`
    DELETE FROM requests WHERE ts < unixepoch() - (30 * 86400)
  `),
};

function logRequest({ model, provider_id="provider_1", success, error_type, response_ms, userAgent }) {
  try {
    stmts.insertRequest.run({
      model,
      provider_id,
      success: success ? 1 : 0,
      error_type: error_type || null,
      response_ms: response_ms || null,
      client_type: detectClient(userAgent),
      session_id: makeSessionId(userAgent),
    });
  } catch (_) {}
}

function getDashboardData(windowSecs = 86400) {
  try { stmts.pruneExpiredSessions.run(); } catch (_) {}
  return {
    overview: stmts.overviewStats.get({ window_secs: windowSecs }) || {},
    hourly: stmts.hourlyBuckets.all(),
    topModels: stmts.topModels.all({ window_secs: windowSecs }),
    clientBreakdown: stmts.clientBreakdown.all({ window_secs: windowSecs }),
    errors: stmts.errorBreakdown.all({ window_secs: windowSecs }),
    providers: stmts.getAllProviders.all(),
    keys: stmts.getAllKeys.all(),
    mappings: stmts.getAllMappings.all(),
  };
}

function getLiveMappings() {
  const rows = stmts.getActiveMappings.all();
  const map = {};
  for (const r of rows) map[r.clean_name] = { real: r.real_name, provider: r.provider_id };
  return map;
}

function getProviderUrl(provider_id) {
  const row = stmts.getActiveProviders.all().find(p => p.provider_id === provider_id);
  return row ? row.base_url : null;
}

function getActiveKeys(provider_id) {
  return stmts.getActiveKeysByProvider.all(provider_id).map(r => r.key_value);
}

module.exports = {
  db,
  stmts,
  logRequest,
  getDashboardData,
  getLiveMappings,
  getProviderUrl,
  getActiveKeys,
};
