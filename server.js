"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Transform, Readable } = require("stream");
const { MODEL_MAP, MODELS_RESPONSE, REVERSE_MAP } = require("./models");
const { logRequest, logTokenUsage, logErrorRecord, getLiveMappings, getProviderUrl, getActiveKeys, stmts } = require("./db/database");
const adminRouter = require("./admin/routes");

const PROXY_KEY = process.env.PROXY_KEY || "want-free-ai?here-you-go-gemini";
const SPACE_PASSWORD = process.env.SPACE_PASSWORD || "";
const PORT = process.env.PORT || 7860;

console.log(`[proxy] port ${PORT} | space gate: ${SPACE_PASSWORD ? "ON" : "OFF"}`);

// ─── MODEL MAP ──────────────────────────────────────
function buildLiveModelMap() {
  const merged = {}, reverseMap = {};
  const staticUrl = process.env.UPSTREAM_BASE || "";
  for (const [clean, real] of Object.entries(MODEL_MAP)) {
    merged[clean] = { real, provider_id: "provider_1", base_url: staticUrl };
    reverseMap[real] = clean;
  }
  try {
    for (const [clean, { real, provider }] of Object.entries(getLiveMappings())) {
      const url = getProviderUrl(provider) || staticUrl;
      merged[clean] = { real, provider_id: provider, base_url: url };
      reverseMap[real] = clean;
    }
  } catch(e) { console.warn("[model-map]", e.message); }
  return { merged, reverseMap };
}

// ─── KEY ROTATION ──────────────────────────────────
const keyIndexMap = {};
function getAndAdvanceKeyIndex(pid, total) {
  if (keyIndexMap[pid] === undefined) keyIndexMap[pid] = 0;
  const cur = keyIndexMap[pid];
  keyIndexMap[pid] = (cur + 1) % total;
  return cur;
}

async function fetchWithRotation(provider_id, url, options) {
  let keys = getActiveKeys(provider_id);
  if (keys.length === 0 && provider_id === "provider_1")
    keys = (process.env.UPSTREAM_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("No active keys");
  const total = keys.length;
  let lastRes = null;
  const startIdx = getAndAdvanceKeyIndex(provider_id, total);
  for (let i = 0; i < total; i++) {
    const idx = (startIdx + i) % total;
    const res = await fetch(url, { ...options, headers: { ...options.headers, authorization: `Bearer ${keys[idx]}` }});
    if (res.status !== 429) { try { stmts.bumpKeyUsed.run(provider_id, keys[idx]); } catch(_) {} return res; }
    try { stmts.bump429.run(provider_id, keys[idx]); } catch(_) {}
    lastRes = res;
  }
  return lastRes;
}

// ─── CORS ───────────────────────────────────────────
const corsOptions = {
  origin: "*", methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-requested-with","x-stainless-os","x-stainless-lang","x-stainless-package-version","x-stainless-runtime","x-stainless-runtime-version","x-stainless-arch"],
  exposedHeaders: ["Content-Type"], credentials: false, maxAge: 86400,
};

// ─── HELPERS ────────────────────────────────────────
function scrubText(text, reverseMap) {
  let out = text;
  for (const [real, clean] of Object.entries(reverseMap)) out = out.split(real).join(clean);
  return out;
}

function isPingEvent(block) {
  const t = block.trim();
  if (!t || /^:\s*ping\s*$/i.test(t)) return true;
  const lines = t.split("\n").map(l => l.trimEnd());
  if (lines.some(l => /^event:\s*ping\s*$/i.test(l))) return true;
  const dataLines = lines.filter(l => l.startsWith("data:"));
  const nonData = lines.filter(l => !l.startsWith("data:") && !l.startsWith(":") && l !== "");
  if (dataLines.length > 0 && nonData.length === 0) {
    for (const dl of dataLines) {
      const raw = dl.slice(5).trim();
      if (raw === "" || raw === "{}") return true;
      try { const p = JSON.parse(raw); if (p.type === "ping") return true;
        if (Array.isArray(p.choices) && p.choices.length > 0 && p.choices.every(c => c.delta && Object.keys(c.delta).length === 0)) return true;
      } catch(_) {}
    }
  }
  return false;
}

function buildSafeHeaders(fetchResponse) {
  const allowed = new Set(["content-type","content-length","cache-control","transfer-encoding","x-ratelimit-limit-requests","x-ratelimit-remaining-requests"]);
  const safe = {};
  fetchResponse.headers.forEach((v, k) => { if (allowed.has(k.toLowerCase())) safe[k.toLowerCase()] = v; });
  return safe;
}

function makeScrubTransform(reverseMap) {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let _carry = "", _lastUsage = null;
  return Object.assign(new Transform({
    transform(chunk, _enc, cb) {
      try {
        const text = decoder.decode(chunk, { stream: true });
        const input = _carry + text;
        const parts = input.split(/\n\n/);
        _carry = parts.pop();
        const outParts = [];
        for (const block of parts) {
          if (isPingEvent(block)) continue;
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) {
              try { const d = JSON.parse(line.slice(5).trim()); if (d.usage && d.usage.total_tokens) _lastUsage = { prompt_tokens: d.usage.prompt_tokens || 0, completion_tokens: d.usage.completion_tokens || 0, total_tokens: d.usage.total_tokens || 0 }; } catch(_) {}
            }
          }
          outParts.push(scrubText(block, reverseMap));
        }
        if (outParts.length) cb(null, Buffer.from(encoder.encode(outParts.join("\n\n") + "\n\n")));
        else cb();
      } catch(e) { cb(e); }
    },
    flush(cb) {
      try {
        if (_carry && !isPingEvent(_carry)) {
          for (const line of _carry.split("\n")) {
            if (line.startsWith("data:")) {
              try { const d = JSON.parse(line.slice(5).trim()); if (d.usage && d.usage.total_tokens) _lastUsage = { prompt_tokens: d.usage.prompt_tokens || 0, completion_tokens: d.usage.completion_tokens || 0, total_tokens: d.usage.total_tokens || 0 }; } catch(_) {}
            }
          }
          cb(null, Buffer.from(encoder.encode(scrubText(_carry, reverseMap) + "\n\n")));
        } else cb();
      } catch(e) { cb(e); }
    },
  }), { getLastUsage: () => _lastUsage });
}

function buildModelsResponse() {
  const { merged } = buildLiveModelMap();
  return { object: "list", data: Object.keys(merged).map(id => ({ id, object: "model", created: 1700000000, owned_by: "openai", permission: [], root: id, parent: null })) };
}

function sanitizeError(bodyObj) {
  if (!bodyObj || typeof bodyObj !== "object") return bodyObj;
  const obj = JSON.parse(JSON.stringify(bodyObj));
  if (obj.error && obj.error.message) {
    const m = String(obj.error.message).toLowerCase();
    if (m.includes("api") && m.includes("key")) obj.error.message = "Authentication error (401)";
    else if (m.includes("rate") || m.includes("limit")) obj.error.message = "Rate limit exceeded (429)";
    else if (m.includes("not found") || m.includes("404")) obj.error.message = "Resource not found (404)";
    else if (m.includes("permission") || m.includes("forbidden")) obj.error.message = "Access denied (403)";
    else obj.error.message = "Upstream error (" + (obj.error.code || "unknown") + ")";
  }
  return obj;
}

const ERR = { 400:{message:"Bad request (400)",type:"invalid_request_error",code:"400"}, 401:{message:"Authentication error (401)",type:"authentication_error",code:"401"}, 403:{message:"Access denied (403)",type:"permission_error",code:"403"}, 404:{message:"Not found (404)",type:"invalid_request_error",code:"404"}, 408:{message:"Request timeout (408)",type:"timeout_error",code:"408"}, 429:{message:"Rate limit exceeded (429)",type:"rate_limit_error",code:"429"}, 441:{message:"Invalid response (441)",type:"api_error",code:"441"}, 500:{message:"Upstream error (500)",type:"api_error",code:"500"}, 502:{message:"Proxy error (502)",type:"api_error",code:"502"}, 503:{message:"Service unavailable (503)",type:"api_error",code:"503"}, 504:{message:"Gateway timeout (504)",type:"timeout_error",code:"504"} };

// ─── APP ────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};
  for (const part of raw.split(";")) { const [k, ...v] = part.trim().split("="); if (k) req.cookies[k.trim()] = decodeURIComponent(v.join("=")); }
  next();
});
app.use(express.json({ limit: "10mb" }));

// ─── SPACE GATE ────────────────────────────────────
function requireSpaceAuth(req, res, next) {
  if (!SPACE_PASSWORD) return next();
  if (req.path === "/_unlock") return next();
  if (req.path.startsWith("/v1/") || req.path === "/v1/models") return next();
  if (req.path.startsWith("/admin")) return next();
  if (req.path === "/health") return next();
  if (req.path === "/api/info") return next();
  if (req.cookies?.space_token === SPACE_PASSWORD) return next();
  if (req.query.space_key === SPACE_PASSWORD) return next();
  if (req.method === "GET" && (req.path === "/" || req.path.endsWith(".html") || req.path === ""))
    return res.sendFile(path.join(__dirname, "public", "gate.html"));
  return res.status(403).json(ERR[403]);
}
app.use(requireSpaceAuth);
app.use(express.static(path.join(__dirname, "public")));

app.post("/_unlock", (req, res) => {
  const { password } = req.body || {};
  if (!SPACE_PASSWORD) return res.json({ ok: true });
  if (password !== SPACE_PASSWORD) return res.status(403).json({ error: "Incorrect password" });
  res.setHeader("Set-Cookie", `space_token=${SPACE_PASSWORD}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`);
  res.json({ ok: true });
});

// ─── PROXY AUTH ────────────────────────────────────
function requireProxyAuth(req, res, next) {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== PROXY_KEY) return res.status(401).json(ERR[401]);
  next();
}

// ─── ROUTES ────────────────────────────────────────
app.use("/admin", adminRouter);
app.get("/v1/models", (_req, res) => res.json(buildModelsResponse()));
app.get("/v1/models/:id", (_req, res) => res.status(404).json(ERR[404]));
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.all("/v1/*", requireProxyAuth, async (req, res) => {
  const startMs = Date.now();
  const { merged, reverseMap } = buildLiveModelMap();
  let logModel = "unknown", logProvider = "provider_1";
  const userAgent = req.headers["user-agent"] || "";

  try {
    let bodyToSend;
    if (!["GET","HEAD"].includes(req.method)) {
      const body = req.body || {};
      if (body.model !== undefined) {
        const entry = merged[body.model];
        if (!entry) {
          logRequest({ model: body.model||"unknown", provider_id:"unknown", success:false, error_type:"model_not_found", response_ms:Date.now()-startMs, userAgent });
          logErrorRecord("model_not_found", body.model, "unknown", "Model not in mapping");
          return res.status(400).json({ error: { message: "Model '"+body.model+"' not found.", type:"invalid_request_error" }});
        }
        logModel = body.model; logProvider = entry.provider_id;
        bodyToSend = JSON.stringify({ ...body, model: entry.real });
      } else { bodyToSend = JSON.stringify(body); }
    }

    const providerUrl = (logProvider && logProvider !== "unknown") ? (getProviderUrl(logProvider) || process.env.UPSTREAM_BASE || "") : (process.env.UPSTREAM_BASE || "");
    if (!providerUrl || providerUrl.trim() === "") return res.status(503).json(ERR[503]);

    const strippedPath = req.path.replace(/^\/v1/, "");
    const qs = req.url.includes("?") ? "?" + req.url.slice(req.url.indexOf("?")+1) : "";
    const upstreamUrl = `${providerUrl}${strippedPath}${qs}`;

    const upstreamRes = await fetchWithRotation(logProvider, upstreamUrl, { method: req.method, headers: { "content-type":"application/json", "accept":req.headers["accept"]||"application/json" }, body: bodyToSend, duplex: "half" });

    if (upstreamRes.status === 429) {
      logRequest({ model:logModel, provider_id:logProvider, success:false, error_type:"429", response_ms:Date.now()-startMs, userAgent });
      logErrorRecord("429", logModel, logProvider, "All keys rate-limited");
      return res.status(429).json(ERR[429]);
    }

    const safeHeaders = buildSafeHeaders(upstreamRes);
    const contentType = (safeHeaders["content-type"] || "").toLowerCase();
    const isStream = contentType.includes("text/event-stream");

    if (isStream) {
      res.writeHead(upstreamRes.status, { "content-type":"text/event-stream", "cache-control":"no-cache", "connection":"keep-alive", "access-control-allow-origin":"*" });
      if (!upstreamRes.body) { logRequest({ model:logModel, provider_id:logProvider, success:true, response_ms:Date.now()-startMs, userAgent }); res.end(); return; }
      const nodeReadable = Readable.fromWeb(upstreamRes.body);
      const scrubber = makeScrubTransform(reverseMap);
      await pipeline(nodeReadable, scrubber, res);
      const usage = scrubber.getLastUsage();
      if (usage && usage.total_tokens > 0) logTokenUsage(logModel, usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);
      const success = upstreamRes.status < 400;
      logRequest({ model:logModel, provider_id:logProvider, success, error_type:success?null:`http_${upstreamRes.status}`, response_ms:Date.now()-startMs, userAgent });
      if (!success) logErrorRecord(String(upstreamRes.status), logModel, logProvider, "Upstream stream error");
      return;
    }

    // Non-stream
    const rawText = await upstreamRes.text();
    let bodyObj = null;
    try { bodyObj = JSON.parse(rawText); } catch(_) {}
    if (bodyObj && bodyObj.usage && bodyObj.usage.total_tokens) logTokenUsage(logModel, bodyObj.usage.prompt_tokens||0, bodyObj.usage.completion_tokens||0, bodyObj.usage.total_tokens||0);
    if (upstreamRes.status >= 400) {
      const sanitized = sanitizeError(bodyObj);
      const respBody = sanitized ? JSON.stringify(sanitized) : JSON.stringify(ERR[upstreamRes.status]||ERR[500]);
      const outBuffer = Buffer.from(respBody, "utf8");
      res.writeHead(upstreamRes.status, { "content-type":"application/json", "content-length":String(outBuffer.byteLength), "access-control-allow-origin":"*" });
      res.end(outBuffer);
      logRequest({ model:logModel, provider_id:logProvider, success:false, error_type:`http_${upstreamRes.status}`, response_ms:Date.now()-startMs, userAgent });
      logErrorRecord(String(upstreamRes.status), logModel, logProvider, "Upstream HTTP error");
      return;
    }
    const scrubbed = scrubText(rawText, reverseMap);
    const outBuffer = Buffer.from(scrubbed, "utf8");
    res.writeHead(upstreamRes.status, { "content-type":safeHeaders["content-type"]||"application/json", "content-length":String(outBuffer.byteLength), "access-control-allow-origin":"*" });
    res.end(outBuffer);
    logRequest({ model:logModel, provider_id:logProvider, success:true, response_ms:Date.now()-startMs, userAgent });
  } catch (err) {
    console.error("[proxy error]", err.message);
    logRequest({ model:logModel, provider_id:logProvider, success:false, error_type:"proxy_error", response_ms:Date.now()-startMs, userAgent });
    logErrorRecord("proxy_error", logModel, logProvider, err.message);
    if (!res.headersSent) res.status(502).json(ERR[502]);
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/api/info", (_req, res) => res.json({ base_url: (_req.protocol + "://" + _req.get("host") + "/v1"), proxy_key: PROXY_KEY }));

app.use((_req, res) => res.status(404).json(ERR[404]));

app.listen(PORT, () => console.log(`[proxy] listening :${PORT} | /admin | /v1/models | /health`));
