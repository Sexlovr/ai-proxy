"use strict";
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
function pickDataDir() {
  const envDataDir = process.env.DATA_DIR;
  if (envDataDir) {
    try {
      if (!fs.existsSync(envDataDir)) fs.mkdirSync(envDataDir, { recursive: true });
      const tf = path.join(envDataDir, ".__write_test");
      fs.writeFileSync(tf, "ok"); fs.unlinkSync(tf);
      console.log("[db] using explicit DATA_DIR: " + envDataDir);
      return envDataDir;
    } catch (err) {
      console.warn("[db] DATA_DIR not writable: " + err.message + " — falling back");
    }
  }
  for (const dir of ["/data", "/home/node/data"]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const tf = path.join(dir, ".__write_test");
      fs.writeFileSync(tf, "ok"); fs.unlinkSync(tf);
      console.log("[db] using data directory: " + dir);
      return dir;
    } catch (err) { console.warn("[db] candidate " + dir + " not usable: " + err.message); }
  }
  const tmp = path.join(os.tmpdir(), "proxy-data");
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  console.warn("[db] WARNING: using tmp " + tmp + " - data will be lost on restart!");
  return tmp;
}
const DATA_DIR = pickDataDir();
const DB_PATH = path.join(DATA_DIR, "proxy.db");
const db = new Database(DB_PATH);
console.log("[db] database: " + DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL DEFAULT (unixepoch()), model TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT 'provider_1', success INTEGER NOT NULL DEFAULT 1, error_type TEXT, response_ms INTEGER, client_type TEXT NOT NULL DEFAULT 'Unknown', session_id TEXT NOT NULL DEFAULT ''); CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts); CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model); CREATE TABLE IF NOT EXISTS token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL DEFAULT (unixepoch()), model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_token_ts ON token_usage(ts); CREATE INDEX IF NOT EXISTS idx_token_model ON token_usage(model); CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL DEFAULT 'provider_1', key_value TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used INTEGER, req_count INTEGER NOT NULL DEFAULT 0, err_429 INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL DEFAULT (unixepoch())); CREATE TABLE IF NOT EXISTS model_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL DEFAULT 'provider_1', clean_name TEXT NOT NULL UNIQUE, real_name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL DEFAULT (unixepoch())); CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT (unixepoch()), expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL DEFAULT (unixepoch()), error_code TEXT NOT NULL, model TEXT, provider_id TEXT, detail TEXT); CREATE INDEX IF NOT EXISTS idx_error_ts ON error_log(ts);");
const seedProvider = db.prepare("INSERT OR IGNORE INTO providers (provider_id, nickname, base_url) VALUES ('provider_1', 'Main Provider', @base_url)");
seedProvider.run({ base_url: process.env.UPSTREAM_BASE || "" });
function makeSessionId(ua) { const day = Math.floor(Date.now() / 86400000); return crypto.createHash("sha256").update((ua||"unknown")+"|"+day).digest("hex").slice(0,16); }
function detectClient(ua) { if(!ua)return"Unknown"; const s=ua.toLowerCase(); if(s.includes("sillytavern"))return"SillyTavern"; if(s.includes("janitorai")||s.includes("janitor"))return"Janitor AI"; if(s.includes("chub"))return"Chub.ai"; if(s.includes("openai"))return"OpenAI SDK"; if(s.includes("python"))return"Python"; if(s.includes("curl"))return"cURL"; return"Unknown"; }
const stmts = {};
stmts.insertRequest = db.prepare("INSERT INTO requests (model,provider_id,success,error_type,response_ms,client_type,session_id) VALUES (@model,@provider_id,@success,@error_type,@response_ms,@client_type,@session_id)");
stmts.overviewStats = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS errors, COUNT(DISTINCT session_id) AS unique_users, AVG(response_ms) AS avg_ms, SUM(CASE WHEN error_type='429' THEN 1 ELSE 0 END) AS rpm_hits FROM requests WHERE ts >= unixepoch() - @window_secs");
stmts.hourlyBuckets = db.prepare("SELECT (ts/3600)*3600 AS bucket, COUNT(*) AS total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS err FROM requests WHERE ts >= unixepoch()-86400 GROUP BY bucket ORDER BY bucket");
stmts.topModels = db.prepare("SELECT model, COUNT(*) AS total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS err, MAX(ts) AS last_used FROM requests WHERE ts >= unixepoch()-@window_secs GROUP BY model ORDER BY total DESC LIMIT 50");
stmts.clientBreakdown = db.prepare("SELECT client_type, COUNT(DISTINCT session_id) AS unique_users, COUNT(*) AS total_requests FROM requests WHERE ts >= unixepoch()-@window_secs GROUP BY client_type ORDER BY total_requests DESC");
stmts.errorBreakdown = db.prepare("SELECT COALESCE(error_type,'unknown') AS error_type, COUNT(*) AS count, MAX(ts) AS last_at FROM requests WHERE success=0 AND ts >= unixepoch()-@window_secs GROUP BY error_type ORDER BY count DESC");
stmts.insertTokenUsage = db.prepare("INSERT INTO token_usage (model,prompt_tokens,completion_tokens,total_tokens) VALUES (@model,@prompt_tokens,@completion_tokens,@total_tokens)");
stmts.tokenStatsByModel = db.prepare("SELECT model, COUNT(*) AS requests, SUM(prompt_tokens) AS total_prompt, SUM(completion_tokens) AS total_completion, SUM(total_tokens) AS grand_total, MAX(ts) AS last_used FROM token_usage WHERE ts >= unixepoch()-@window_secs GROUP BY model ORDER BY grand_total DESC");
stmts.tokenTotalSummary = db.prepare("SELECT SUM(total_tokens) AS tokens, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, COUNT(*) AS reqs FROM token_usage WHERE ts >= unixepoch()-@window_secs");
stmts.getAllKeys = db.prepare("SELECT id,provider_id,key_value,nickname,is_active,added_at,last_used,req_count,err_429 FROM api_keys ORDER BY provider_id,added_at");
stmts.getActiveKeysByProvider = db.prepare("SELECT key_value FROM api_keys WHERE provider_id=? AND is_active=1 ORDER BY added_at");
stmts.insertKey = db.prepare("INSERT INTO api_keys (provider_id,key_value,nickname) VALUES (@provider_id,@key_value,@nickname)");
stmts.deleteKey = db.prepare("DELETE FROM api_keys WHERE id=?");
stmts.toggleKey = db.prepare("UPDATE api_keys SET is_active=CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=?");
stmts.bumpKeyUsed = db.prepare("UPDATE api_keys SET req_count=req_count+1, last_used=unixepoch() WHERE provider_id=? AND key_value=?");
stmts.bump429 = db.prepare("UPDATE api_keys SET err_429=err_429+1 WHERE provider_id=? AND key_value=?");
stmts.getAllProviders = db.prepare("SELECT id,provider_id,nickname,base_url,is_active,added_at FROM providers ORDER BY added_at");
stmts.getActiveProviders = db.prepare("SELECT provider_id,base_url FROM providers WHERE is_active=1");
stmts.insertProvider = db.prepare("INSERT INTO providers (provider_id,nickname,base_url) VALUES (@provider_id,@nickname,@base_url)");
stmts.deleteProvider = db.prepare("DELETE FROM providers WHERE provider_id=?");
stmts.toggleProvider = db.prepare("UPDATE providers SET is_active=CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE provider_id=?");
stmts.updateProviderUrl = db.prepare("UPDATE providers SET base_url=@base_url WHERE provider_id=@provider_id");
stmts.getAllMappings = db.prepare("SELECT id,provider_id,clean_name,real_name,is_active,added_at FROM model_mappings ORDER BY provider_id,clean_name");
stmts.getActiveMappings = db.prepare("SELECT clean_name,real_name,provider_id FROM model_mappings WHERE is_active=1");
stmts.insertMapping = db.prepare("INSERT OR REPLACE INTO model_mappings (provider_id,clean_name,real_name) VALUES (@provider_id,@clean_name,@real_name)");
stmts.deleteMapping = db.prepare("DELETE FROM model_mappings WHERE id=?");
stmts.toggleMapping = db.prepare("UPDATE model_mappings SET is_active=CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=?");
stmts.insertSession = db.prepare("INSERT INTO admin_sessions (token,expires_at) VALUES (@token,@expires_at)");
stmts.getSession = db.prepare("SELECT token FROM admin_sessions WHERE token=? AND expires_at > unixepoch()");
stmts.deleteSession = db.prepare("DELETE FROM admin_sessions WHERE token=?");
stmts.pruneExpiredSessions = db.prepare("DELETE FROM admin_sessions WHERE expires_at <= unixepoch()");
stmts.pruneOldRequests = db.prepare("DELETE FROM requests WHERE ts < unixepoch()-(30*86400)");
stmts.logError = db.prepare("INSERT INTO error_log (error_code,model,provider_id,detail) VALUES (@error_code,@model,@provider_id,@detail)");
stmts.getErrorLog = db.prepare("SELECT * FROM error_log WHERE ts >= unixepoch()-@window_secs ORDER BY ts DESC LIMIT 200");
stmts.errorLogStats = db.prepare("SELECT error_code, COUNT(*) AS count, MAX(ts) AS last_at FROM error_log WHERE ts >= unixepoch()-@window_secs GROUP BY error_code ORDER BY count DESC");
function logRequest(o) { try { stmts.insertRequest.run({model:o.model,provider_id:o.provider_id||"provider_1",success:o.success?1:0,error_type:o.error_type||null,response_ms:o.response_ms||null,client_type:detectClient(o.userAgent),session_id:makeSessionId(o.userAgent)}); } catch(_) {} }
function logTokenUsage(m,pt,ct,tt) { try { stmts.insertTokenUsage.run({model:m,prompt_tokens:pt||0,completion_tokens:ct||0,total_tokens:tt||0}); } catch(_) {} }
function logErrorRecord(ec,m,pid,d) { try { stmts.logError.run({error_code:String(ec),model:m||null,provider_id:pid||null,detail:d?String(d).slice(0,500):null}); } catch(_) {} }
function getDashboardData(ws) { try { stmts.pruneExpiredSessions.run(); } catch(_) {} return { overview: stmts.overviewStats.get({window_secs:ws})||{}, hourly: stmts.hourlyBuckets.all(), topModels: stmts.topModels.all({window_secs:ws}), clientBreakdown: stmts.clientBreakdown.all({window_secs:ws}), errors: stmts.errorBreakdown.all({window_secs:ws}), tokenSummary: stmts.tokenTotalSummary.get({window_secs:ws})||{}, tokenModels: stmts.tokenStatsByModel.all({window_secs:ws}), providers: stmts.getAllProviders.all(), keys: stmts.getAllKeys.all(), mappings: stmts.getAllMappings.all() }; }
function getLiveMappings() { const rows=stmts.getActiveMappings.all(); const m={}; for(const r of rows) m[r.clean_name]={real:r.real_name,provider:r.provider_id}; return m; }
function getProviderUrl(pid) { const r=stmts.getActiveProviders.all().find(p=>p.provider_id===pid); return r?r.base_url:null; }
function getActiveKeys(pid) { return stmts.getActiveKeysByProvider.all(pid).map(r=>r.key_value); }
module.exports = { db, stmts, logRequest, logTokenUsage, logErrorRecord, getDashboardData, getLiveMappings, getProviderUrl, getActiveKeys };
