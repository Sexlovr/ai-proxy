"use strict";

const express                                     = require("express");
const cors                                        = require("cors");
const path                                        = require("path");
const { pipeline }                                = require("stream/promises");
const { Transform, Readable }                     = require("stream");
const { MODEL_MAP, MODELS_RESPONSE, REVERSE_MAP } = require("./models");
const {
  logRequest,
  getLiveMappings,
  getProviderUrl,
  getActiveKeys,
  stmts,
}                                                 = require("./db/database");
const adminRouter                                 = require("./admin/routes");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PROXY_KEY = process.env.PROXY_KEY || "want-free-ai?here-you-go-gemini";
const PORT      = process.env.PORT      || 7860;

console.log(`[proxy] starting on port ${PORT}`);

// ─── DYNAMIC MODEL MAP ────────────────────────────────────────────────────────
function buildLiveModelMap() {
  const merged     = {};
  const reverseMap = {};

  const staticProviderUrl = process.env.UPSTREAM_BASE || "";
  
  for (const [clean, real] of Object.entries(MODEL_MAP)) {
    merged[clean]    = { real, provider_id: "provider_1", base_url: staticProviderUrl };
    reverseMap[real] = clean;
  }

  try {
    const dbMappings = getLiveMappings();
    for (const [clean, { real, provider }] of Object.entries(dbMappings)) {
      const url = getProviderUrl(provider) || staticProviderUrl;
      merged[clean]    = { real, provider_id: provider, base_url: url };
      reverseMap[real] = clean;
    }
  } catch (e) {
    console.warn("[model-map] DB overlay failed:", e.message);
  }

  return { merged, reverseMap };
}

// ─── KEY ROTATION ─────────────────────────────────────────────────────────────
const keyIndexMap = {};

function getKeyIndex(provider_id) {
  if (keyIndexMap[provider_id] === undefined) keyIndexMap[provider_id] = 0;
  return keyIndexMap[provider_id];
}

function advanceKeyIndex(provider_id, to) {
  keyIndexMap[provider_id] = to;
}

async function fetchWithRotation(provider_id, url, options) {
  let keys = getActiveKeys(provider_id);

  if (keys.length === 0 && provider_id === "provider_1") {
    keys = (process.env.UPSTREAM_KEYS || "")
      .split(",")
      .map(k => k.trim())
      .filter(Boolean);
  }

  if (keys.length === 0) {
    throw new Error(`No active keys for ${provider_id}`);
  }

  const total    = keys.length;
  let   lastRes  = null;
  let   startIdx = getKeyIndex(provider_id);

  for (let attempt = 0; attempt < total; attempt++) {
    const idx = (startIdx + attempt) % total;
    const key = keys[idx];

    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        authorization: `Bearer ${key}`,
      },
    });

    if (res.status !== 429) {
      advanceKeyIndex(provider_id, (idx + 1) % total);
      try {
        stmts.bumpKeyUsed.run(provider_id, key);
      } catch(_) {}
      return res;
    }

    try {
      stmts.bump429.run(provider_id, key);
    } catch(_) {}
    console.warn(`[keys] provider=${provider_id} key[${idx}] hit 429`);
    lastRes = res;
  }

  console.error(`[keys] all keys rate-limited for provider=${provider_id}`);
  return lastRes;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin:         "*",
  methods:        ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", "Authorization", "x-requested-with",
    "x-stainless-os", "x-stainless-lang", "x-stainless-package-version",
    "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-arch",
  ],
  exposedHeaders: ["Content-Type"],
  credentials:    false,
  maxAge:         86400,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function scrubText(text, reverseMap) {
  let out = text;
  for (const [real, clean] of Object.entries(reverseMap)) {
    out = out.split(real).join(clean);
  }
  return out;
}

function isPingEvent(block) {
  const trimmed = block.trim();
  if (!trimmed) return true;
  if (/^:\s*ping\s*$/i.test(trimmed)) return true;

  const lines = trimmed.split("\n").map(l => l.trimEnd());
  if (lines.some(l => /^event:\s*ping\s*$/i.test(l))) return true;

  const dataLines = lines.filter(l => l.startsWith("data:"));
  const nonData   = lines.filter(
    l => !l.startsWith("data:") && !l.startsWith(":") && l !== ""
  );

  if (dataLines.length > 0 && nonData.length === 0) {
    for (const dl of dataLines) {
      const raw = dl.slice(5).trim();
      if (raw === "" || raw === "{}") return true;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === "ping") return true;
        if (
          Array.isArray(parsed.choices) &&
          parsed.choices.length > 0 &&
          parsed.choices.every(c => c.delta && Object.keys(c.delta).length === 0)
        ) return true;
      } catch {}
    }
  }
  return false;
}

function buildSafeHeaders(fetchResponse) {
  const allowed = new Set([
    "content-type", "content-length", "cache-control",
    "transfer-encoding", "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
  ]);
  const safe = {};
  fetchResponse.headers.forEach((value, key) => {
    if (allowed.has(key.toLowerCase())) safe[key.toLowerCase()] = value;
  });
  return safe;
}

function makeScrubTransform(reverseMap) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let   _carry  = "";

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const text  = decoder.decode(chunk, { stream: true });
        const input = _carry + text;
        const parts = input.split(/\n\n/);
        _carry      = parts.pop();

        const out = parts
          .filter(b => !isPingEvent(b))
          .map(b => scrubText(b, reverseMap) + "\n\n")
          .join("");

        if (out) cb(null, Buffer.from(encoder.encode(out)));
        else     cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (_carry && !isPingEvent(_carry)) {
          cb(null, Buffer.from(new TextEncoder().encode(
            scrubText(_carry, reverseMap) + "\n\n"
          )));
        } else {
          cb();
        }
      } catch (e) { cb(e); }
    },
  });
}

function buildModelsResponse() {
  const { merged } = buildLiveModelMap();
  return {
    object: "list",
    data: Object.keys(merged).map(id => ({
      id,
      object:     "model",
      created:    1700000000,
      owned_by:   "openai",
      permission: [],
      root:       id,
      parent:     null,
    })),
  };
}

// ─── APP ──────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Inline cookie parser
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join("="));
  }
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireProxyAuth(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== PROXY_KEY) {
    return res.status(401).json({
      error: {
        message: "Invalid API key.",
        type:    "invalid_request_error",
        code:    "invalid_api_key",
      },
    });
  }
  next();
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use("/admin", adminRouter);

app.get("/v1/models", (_req, res) => {
  res.json(buildModelsResponse());
});

app.get("/v1/models/:id", (_req, res) => {
  res.status(404).json({
    error: { message: "Not found.", type: "invalid_request_error" },
  });
});

app.all("/v1/*", requireProxyAuth, async (req, res) => {
  const startMs = Date.now();
  const { merged, reverseMap } = buildLiveModelMap();

  let   logModel    = "unknown";
  let   logProvider = "provider_1";
  const userAgent   = req.headers["user-agent"] || "";

  try {
    let bodyToSend = undefined;

    if (!["GET", "HEAD"].includes(req.method)) {
      const body = req.body || {};

      if (body.model !== undefined) {
        const entry = merged[body.model];

        if (!entry) {
          logRequest({
            model:       body.model || "unknown",
            provider_id: "unknown",
            success:     false,
            error_type:  "model_not_found",
            response_ms: Date.now() - startMs,
            userAgent,
          });
          return res.status(400).json({
            error: {
              message: `Model '${body.model}' not found.`,
              type:    "invalid_request_error",
            },
          });
        }

        logModel    = body.model;
        logProvider = entry.provider_id;
        bodyToSend  = JSON.stringify({ ...body, model: entry.real });
      } else {
        bodyToSend = JSON.stringify(body);
      }
    }

    const providerUrl = (logProvider && logProvider !== "unknown")
      ? (getProviderUrl(logProvider) || process.env.UPSTREAM_BASE || "")
      : (process.env.UPSTREAM_BASE || "");

    // Check if provider URL is configured
    if (!providerUrl || providerUrl.trim() === "") {
      return res.status(503).json({
        error: {
          message: "Proxy not configured. Please visit /admin to set up provider and keys.",
          type: "configuration_error",
        },
      });
    }

    const strippedPath = req.path.replace(/^\/v1/, "");
    const queryString  = req.url.includes("?")
      ? "?" + req.url.slice(req.url.indexOf("?") + 1)
      : "";
    const upstreamUrl  = `${providerUrl}${strippedPath}${queryString}`;

    const upstreamRes = await fetchWithRotation(logProvider, upstreamUrl, {
      method:  req.method,
      headers: {
        "content-type": "application/json",
        "accept":       req.headers["accept"] || "application/json",
      },
      body:   bodyToSend,
      duplex: "half",
    });

    if (upstreamRes.status === 429) {
      logRequest({
        model:       logModel,
        provider_id: logProvider,
        success:     false,
        error_type:  "429",
        response_ms: Date.now() - startMs,
        userAgent,
      });
      return res.status(429).json({
        error: {
          message: "All upstream keys are rate-limited.",
          type:    "rate_limit_error",
        },
      });
    }

    const safeHeaders = buildSafeHeaders(upstreamRes);
    const contentType = (safeHeaders["content-type"] || "").toLowerCase();
    const isStream    = contentType.includes("text/event-stream");

    if (isStream) {
      res.writeHead(upstreamRes.status, {
        "content-type":                "text/event-stream",
        "cache-control":               "no-cache",
        "connection":                  "keep-alive",
        "access-control-allow-origin": "*",
      });

      if (!upstreamRes.body) {
        logRequest({
          model: logModel, provider_id: logProvider,
          success: true, response_ms: Date.now() - startMs, userAgent,
        });
        res.end();
        return;
      }

      const nodeReadable = Readable.fromWeb(upstreamRes.body);
      const scrubber     = makeScrubTransform(reverseMap);
      await pipeline(nodeReadable, scrubber, res);

      logRequest({
        model:       logModel,
        provider_id: logProvider,
        success:     upstreamRes.status < 400,
        error_type:  upstreamRes.status >= 400 ? `http_${upstreamRes.status}` : null,
        response_ms: Date.now() - startMs,
        userAgent,
      });
      return;
    }

    const rawText   = await upstreamRes.text();
    const scrubbed  = scrubText(rawText, reverseMap);
    const outBuffer = Buffer.from(scrubbed, "utf8");

    res.writeHead(upstreamRes.status, {
      "content-type":                safeHeaders["content-type"] || "application/json",
      "content-length":              String(outBuffer.byteLength),
      "access-control-allow-origin": "*",
    });
    res.end(outBuffer);

    logRequest({
      model:       logModel,
      provider_id: logProvider,
      success:     upstreamRes.status < 400,
      error_type:  upstreamRes.status >= 400 ? `http_${upstreamRes.status}` : null,
      response_ms: Date.now() - startMs,
      userAgent,
    });

  } catch (err) {
    console.error("[proxy error]", err.message);

    logRequest({
      model:       logModel,
      provider_id: logProvider,
      success:     false,
      error_type:  "proxy_error",
      response_ms: Date.now() - startMs,
      userAgent,
    });

    if (!res.headersSent) {
      res.status(502).json({
        error: { message: "Proxy error: " + err.message, type: "api_error" },
      });
    }
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((_req, res) => {
  res.status(404).json({
    error: { message: "Not found.", type: "invalid_request_error" },
  });
});

app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
  console.log(`[proxy] admin → /admin`);
  console.log(`[proxy] models → /v1/models (public)`);
});
