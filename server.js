"use strict";
// ai-proxy — OpenAI-compatible reverse proxy.
// 2026 rebuild: JSON persistence under a HuggingFace Storage Bucket at /data,
//   advanced multi-provider round-robin (Model Groups), zero-latency token
//   counting (gpt-tokenizer in the background after the response is flushed),
//   PROXY_KEY-gated web UI, ADMIN_PASSWORD-gated admin, /v1/models public.

const express = require("express");
const cors = require("cors");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Transform, Readable } = require("stream");

const store = require("./store/store");
const rotation = require("./lib/rotation");
const { StreamTap } = require("./lib/tokenCounter");
const adminRouter = require("./admin/routes");

const PROXY_KEY    = process.env.PROXY_KEY    || "want-free-ai?here-you-go-gemini";
const ADMIN_NOTE   = process.env.ADMIN_PASSWORD || "admin123";
const PORT         = parseInt(process.env.PORT, 10) || 7860;

console.log(`[proxy] port ${PORT} | proxy key: ${PROXY_KEY ? "SET" : "DEFAULT"} | admin: ${ADMIN_NOTE ? "SET" : "DEFAULT"}`);

// ── Standard errors ──────────────────────────────────────────────────────────
const ERR = {
  400:{message:"Bad request (400)",type:"invalid_request_error",code:"400"},
  401:{message:"Authentication error (401)",type:"authentication_error",code:"401"},
  403:{message:"Access denied (403)",type:"permission_error",code:"403"},
  404:{message:"Not found (404)",type:"invalid_request_error",code:"404"},
  408:{message:"Request timeout (408)",type:"timeout_error",code:"408"},
  429:{message:"Rate limit exceeded (429)",type:"rate_limit_error",code:"429"},
  500:{message:"Upstream error (500)",type:"api_error",code:"500"},
  502:{message:"Proxy error (502)",type:"api_error",code:"502"},
  503:{message:"Service unavailable (503)",type:"api_error",code:"503"},
  504:{message:"Gateway timeout (504)",type:"timeout_error",code:"504"},
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: "*", methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-requested-with","x-stainless-os","x-stainless-lang","x-stainless-package-version","x-stainless-runtime","x-stainless-runtime-version","x-stainless-arch"],
  exposedHeaders: ["Content-Type"], credentials: false, maxAge: 86400,
};

function buildSafeHeaders(fetchResponse) {
  const allowed = new Set(["content-type","content-length","cache-control","transfer-encoding","x-ratelimit-limit-requests","x-ratelimit-remaining-requests"]);
  const safe = {};
  fetchResponse.headers.forEach((v, k) => { if (allowed.has(k.toLowerCase())) safe[k.toLowerCase()] = v; });
  return safe;
}

function scrubText(text, scrubMap) {
  if (!scrubMap) return text;
  let out = text;
  for (const [real, clean] of Object.entries(scrubMap)) out = out.split(real).join(clean);
  return out;
}

function isPingEvent(block) {
  const t = block.trim();
  if (!t || /^:\s*ping\s*$/i.test(t)) return true;
  const lines = t.split("\n").map(l => l.trimEnd());
  if (lines.some(l => /^event:\s*ping\s*$/i.test(l))) return true;
  const dataLines = lines.filter(l => l.startsWith("data:"));
  const nonData   = lines.filter(l => !l.startsWith("data:") && !l.startsWith(":") && l !== "");
  if (dataLines.length > 0 && nonData.length === 0) {
    for (const dl of dataLines) {
      const raw = dl.slice(5).trim();
      if (raw === "" || raw === "{}") return true;
      try {
        const p = JSON.parse(raw);
        if (p.type === "ping") return true;
        if (Array.isArray(p.choices) && p.choices.length > 0 && p.choices.every(c => c.delta && Object.keys(c.delta).length === 0)) return true;
      } catch (_) {}
    }
  }
  return false;
}

// The scrub transform: reassembles SSE blocks, drops ping events, scrubs the
// upstream's actual model name back to the downstream clean name, and feeds
// each block to the StreamTap so the background tokenizer can count tokens
// WITHOUT touching the client's response stream.
function makeScrubTransform(scrubMap, tap) {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let _carry = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const text = decoder.decode(chunk, { stream: true });
        const input = _carry + text;
        const parts = input.split(/\n\n/);
        _carry = parts.pop();
        const outParts = [];
        for (const block of parts) {
          if (isPingEvent(block)) continue;
          if (tap) tap.feedSseBlock(block);     // tap accumulates; no client latency
          const scrubbed = scrubText(block, scrubMap);
          if (scrubbed) outParts.push(scrubbed);
        }
        if (outParts.length) cb(null, Buffer.from(encoder.encode(outParts.join("\n\n") + "\n\n")));
        else cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (_carry && !isPingEvent(_carry)) {
          if (tap) tap.feedSseBlock(_carry);
          const scrubbed = scrubText(_carry, scrubMap);
          if (scrubbed) cb(null, Buffer.from(encoder.encode(scrubbed + "\n\n")));
          else cb();
        } else cb();
      } catch (e) { cb(e); }
    },
  });
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

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Inline cookie parser (no extra dep).
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};
  for (const part of raw.split(";")) { const [k, ...v] = part.trim().split("="); if (k) req.cookies[k.trim()] = decodeURIComponent(v.join("=")); }
  next();
});
app.use(express.json({ limit: "10mb" }));

// ── Gate for the web UI (model page) — uses PROXY_KEY (downstream) ───────────
function gateApproved(req) {
  if (req.cookies?.space_token && req.cookies.space_token === PROXY_KEY) return true;
  if (req.headers["x-proxy-key"] === PROXY_KEY) return true;
  const b = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (b === PROXY_KEY) return true;
  return false;
}

app.get("/gate.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "gate.html")));

app.post("/_unlock", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== PROXY_KEY) return res.status(403).json({ error: "Incorrect password" });
  res.setHeader("Set-Cookie", `space_token=${encodeURIComponent(PROXY_KEY)}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`);
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  if (gateApproved(req)) return res.sendFile(path.join(__dirname, "public", "index.html"));
  res.sendFile(path.join(__dirname, "public", "gate.html"));
});
app.get("/index.html", (_req, res) => res.redirect("/"));

// /api/info reveals the downstream PROXY_KEY + base URL — only after gate cookie.
app.get("/api/info", (req, res) => {
  if (!gateApproved(req)) return res.status(403).json(ERR[403]);
  res.json({
    base_url: (req.protocol + "://" + req.get("host") + "/v1"),
    proxy_key: PROXY_KEY,
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── Admin router (ADMIN_PASSWORD session inside) ─────────────────────────────
app.use("/admin", adminRouter);

// ── Proxy auth (downstream PROXY_KEY Bearer) ─────────────────────────────────
function requireProxyAuth(req, res, next) {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== PROXY_KEY) return res.status(401).json(ERR[401]);
  next();
}

// ── /v1/models  — PUBLIC OpenAI JSON ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => res.json(store.getPublicModelList()));
app.get("/v1/models/:id", (_req, res) => res.status(404).json(ERR[404]));

// ── /v1/* — the proxy itself ─────────────────────────────────────────────────
app.all("/v1/*", requireProxyAuth, async (req, res) => {
  const startMs = Date.now();
  const ua = req.headers["user-agent"] || "";
  let logModel = "unknown", logProvider = "provider_1";

  try {
    // 1) Build slots based on the requested model.
    let slots = null, cursorName = "s:provider_1", scrubMap = null;
    let bodyToSend = null, originalModel = null;

    if (!["GET","HEAD","OPTIONS"].includes(req.method)) {
      const body = req.body || {};
      if (body.model !== undefined) {
        originalModel = String(body.model);
        const decision = store.resolveModel(originalModel);
        if (decision.kind === "none") {
          store.logRequest({ model: originalModel, provider_id: "unknown", success: false, error_type: "model_not_found", response_ms: Date.now() - startMs, userAgent: ua });
          store.logErrorRecord("model_not_found", originalModel, "unknown", "Model not mapped");
          return res.status(400).json({ error: { message: "Model '" + originalModel + "' not found.", type: "invalid_request_error" } });
        }
        if (decision.kind === "group") {
          slots = rotation.buildGroupSlots(originalModel);
          cursorName = "g:" + originalModel;
          scrubMap = {}; for (const r of decision.rows) scrubMap[r.upstream_model_id] = originalModel;
          logModel = originalModel;
        } else { // single
          slots = rotation.buildSimpleSlots(decision.provider_id, decision.real_name);
          cursorName = "s:" + decision.provider_id;
          scrubMap = { [decision.real_name]: originalModel };
          logModel = originalModel;
          bodyToSend = JSON.stringify({ ...body, model: decision.real_name });
        }
      } else {
        // No model field — fall back to first active provider's slots, body unchanged.
        const firstProvider = store.getActiveProviders()[0];
        if (!firstProvider) return res.status(503).json(ERR[503]);
        slots = rotation.buildSimpleSlots(firstProvider.provider_id, null);
        cursorName = "s:" + firstProvider.provider_id;
        logModel = "passthrough";
        bodyToSend = JSON.stringify(body);
      }
    } else {
      // GET/HEAD — pick first active provider, no body.
      const firstProvider = store.getActiveProviders()[0];
      if (!firstProvider) return res.status(503).json(ERR[503]);
      slots = rotation.buildSimpleSlots(firstProvider.provider_id, null);
      cursorName = "s:" + firstProvider.provider_id;
      logModel = "passthrough";
    }

    if (!slots || slots.length === 0) {
      store.logRequest({ model: originalModel || logModel, provider_id: "unknown", success: false, error_type: "no_keys", response_ms: Date.now() - startMs, userAgent: ua });
      store.logErrorRecord("no_keys", originalModel || logModel, "unknown", "No active providers/keys");
      return res.status(503).json(ERR[503]);
    }

    // 2) Compose request URL/path pieces.
    const strippedPath = req.path.replace(/^\/v1/, "");
    const qs = req.url.includes("?") ? "?" + req.url.slice(req.url.indexOf("?") + 1) : "";

    // 3) Cursor-based round-robin retry loop with raw pass-through fetch per slot.
    let cursor = store.getCursor(cursorName);
    let upstreamRes = null, lastWas429 = false;
    for (let i = 0; i < slots.length; i++) {
      const idx = (cursor + i) % slots.length;
      const slot = slots[idx];
      const thisBody = (slot.upstream_model_id && originalModel && typeof req.body === "object" && req.body && req.body.model !== undefined)
        ? JSON.stringify({ ...req.body, model: slot.upstream_model_id })
        : bodyToSend;
      const upstreamUrl = slot.url + strippedPath + qs;
      const headers = {
        "content-type": "application/json",
        "accept":       req.headers["accept"] || "application/json",
        "authorization": `Bearer ${slot.key}`,
      };
      let r;
      try {
        r = await fetch(upstreamUrl, { method: req.method, headers, body: ["GET","HEAD"].includes(req.method) ? undefined : thisBody, duplex: "half" });
      } catch (e) {
        // network/upstream unreachable — try next slot, but record the error
        store.logErrorRecord("fetch_error", originalModel || logModel, slot.provider_id, e.message);
        continue;
      }
      if (r.status === 429) {
        store.bumpKey429(slot.provider_id, slot.key);
        upstreamRes = r; lastWas429 = true;
        continue;
      }
      upstreamRes = r; lastWas429 = false;
      logProvider = slot.provider_id; logSlotKeyIdx = slot.keyIdx;
      store.setCursor(cursorName, (idx + 1) % slots.length);
      store.bumpKeyUsed(slot.provider_id, slot.key);
      break;
    }

    if (lastWas429 || !upstreamRes) {
      store.setCursor(cursorName, cursor); // wrap safe; all keys 429: re-wrap cursor to start.
      store.logRequest({ model: logModel, provider_id: logProvider, success: false, error_type: "429", response_ms: Date.now() - startMs, userAgent: ua });
      store.logErrorRecord("429", logModel, logProvider, "All keys rate-limited");
      return res.status(429).json(ERR[429]);
    }

    // 4) Forward the response — stream or non-stream.
    const safeHeaders = buildSafeHeaders(upstreamRes);
    const contentType = (safeHeaders["content-type"] || "").toLowerCase();
    const isStream = contentType.includes("text/event-stream");

    // StreamTap accumulates content for background token counting. The prompt
    // tokens compute in process.nextTick (started in the StreamTap ctor),
    // i.e. in parallel with the upstream request — never blocking the client.
    const tap = new StreamTap(req.body);

    if (isStream) {
      res.writeHead(upstreamRes.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      });
      if (!upstreamRes.body) {
        store.logRequest({ model: logModel, provider_id: logProvider, success: true, response_ms: Date.now() - startMs, userAgent: ua });
        res.end();
        return;
      }
      const nodeReadable = Readable.fromWeb(upstreamRes.body);
      const scrubber = makeScrubTransform(scrubMap, tap);
      try {
        await pipeline(nodeReadable, scrubber, res);
      } catch (e) {
        // client disconnected or upstream broke — log and stop.
        store.logErrorRecord("pipe_error", logModel, logProvider, e.message);
      }
      const success = upstreamRes.status < 400;
      store.logRequest({ model: logModel, provider_id: logProvider, success, error_type: success ? null : `http_${upstreamRes.status}`, response_ms: Date.now() - startMs, userAgent: ua });
      if (!success) store.logErrorRecord(String(upstreamRes.status), logModel, logProvider, "Upstream stream error");
      // Background token counting — added ZERO latency: client has already
      // received every byte; encoding happens in the next event-loop tick.
      setImmediate(() => {
        try { const t = tap.finalize(); if (t.totalTokens > 0) store.logTokenUsage(logModel, t.promptTokens, t.completionTokens, t.totalTokens); } catch (_) {}
      });
      return;
    }

    // Non-stream path
    const rawText = await upstreamRes.text();
    tap.feedJson(rawText);
    const success = upstreamRes.status < 400;
    if (upstreamRes.status >= 400) {
      let bodyObj = null; try { bodyObj = JSON.parse(rawText); } catch (_) {}
      const sanitized = sanitizeError(bodyObj);
      const respBody = sanitized ? JSON.stringify(sanitized) : JSON.stringify(ERR[upstreamRes.status] || ERR[500]);
      const outBuf = Buffer.from(respBody, "utf8");
      res.writeHead(upstreamRes.status, { "content-type": "application/json", "content-length": String(outBuf.byteLength), "access-control-allow-origin": "*" });
      res.end(outBuf);
      store.logRequest({ model: logModel, provider_id: logProvider, success: false, error_type: `http_${upstreamRes.status}`, response_ms: Date.now() - startMs, userAgent: ua });
      store.logErrorRecord(String(upstreamRes.status), logModel, logProvider, "Upstream HTTP error");
      // Still count tokens even on error (some upstreams return usage on 4xx).
      setImmediate(() => { try { const t = tap.finalize(); if (t.totalTokens > 0) store.logTokenUsage(logModel, t.promptTokens, t.completionTokens, t.totalTokens); } catch (_) {} });
      return;
    }

    // Success non-stream
    const scrubbed = scrubText(rawText, scrubMap);
    const outBuf = Buffer.from(scrubbed, "utf8");
    res.writeHead(upstreamRes.status, {
      "content-type": safeHeaders["content-type"] || "application/json",
      "content-length": String(outBuf.byteLength),
      "access-control-allow-origin": "*",
    });
    res.end(outBuf);
    store.logRequest({ model: logModel, provider_id: logProvider, success: true, response_ms: Date.now() - startMs, userAgent: ua });
    setImmediate(() => { try { const t = tap.finalize(); if (t.totalTokens > 0) store.logTokenUsage(logModel, t.promptTokens, t.completionTokens, t.totalTokens); } catch (_) {} });
  } catch (err) {
    console.error("[proxy error]", err.message);
    store.logRequest({ model: logModel, provider_id: logProvider, success: false, error_type: "proxy_error", response_ms: Date.now() - startMs, userAgent: ua });
    store.logErrorRecord("proxy_error", logModel, logProvider, err.message);
    if (!res.headersSent) res.status(502).json(ERR[502]);
  }
});

app.use((_req, res) => res.status(404).json(ERR[404]));

app.listen(PORT, "0.0.0.0", () => console.log(`[proxy] listening on :${PORT} | /admin | /v1/models (public) | /v1/* (PROXY_KEY) | / (PROXY_KEY gate)`));
