"use strict";
// lib/tokenCounter.js — zero-latency token counting.
//
// Strategy:
//   * The proxy pipes the upstream response straight through to the client with no
//     buffering/holding (raw pass-through). Zero added latency.
//   * While streaming, a StreamTap attached to the scrub transform reads each SSE
//     block as it passes through and keeps a best-effort string accumulator of the
//     generated content (and records any usage object the upstream chose to send).
//   * Prompt tokens: computed from the original request body in a background
//     tick (process.nextTick) so it overlaps the upstream network round-trip.
//   * After the response stream closes (or after the non-stream res.end), the
//     proxy calls tap.finalize() inside setImmediate. gpt-tokenizer encodes the
//     accumulated text using cl100k_base — entirely in the background, AFTER the
//     client has already received every byte.
//
// gpt-tokenizer is pure-JavaScript (no native build) which fits HuggingFace Spaces.
// It uses the cl100k_base BPE vocab (GPT-4/3.5). Different upstreams use different
// tokenizers, so when the upstream returns `usage` we trust it; otherwise we mark
// the count as an approximation. See README/tag in dashboard.

let _initialized = false;
let _encodeFn = null;

function ensureInit() {
  if (_initialized) return;
  try {
    const t = require("gpt-tokenizer");
    // The package exposes `encode` lazily; first call triggers BPE-rank load.
    if (typeof t.encode === "function") {
      _encodeFn = (...args) => t.encode(...args);
      _encodeFn("init"); // warm-up (background; fine for first request only)
      _initialized = true;
      console.log("[tokenizer] gpt-tokenizer ready (cl100k_base)");
    }
  } catch (e) {
    console.warn("[tokenizer] gpt-tokenizer not available:", e.message);
  }
}
// kick init lazily on first require — keep it async-ish to avoid blocking startup
setImmediate(ensureInit);

function countTokens(str) {
  if (!str) return 0;
  if (typeof str !== "string") str = String(str);
  if (!str.trim()) return 0;
  if (!_initialized) return 0;       // not ready yet — skip rather than block main request
  try { return _encodeFn(str).length; } catch (_) { return 0; }
}

// Best-effort extraction of the prompt text from an OpenAI-style request body.
// Concatenates system + messages + tools + prompt. Non-text content (images,
// audio) is skipped; we still capture `text` parts of multimodal content arrays.
function promptTextOf(body) {
  if (!body || typeof body !== "object") return "";
  let t = "";
  try {
    if (typeof body.system === "string") t += body.system + "\n";
    if (typeof body.instructions === "string") t += body.instructions + "\n";
    if (Array.isArray(body.messages)) for (const m of body.messages) {
      if (!m) continue;
      if (typeof m.content === "string") t += m.content + "\n";
      else if (Array.isArray(m.content)) for (const p of m.content) if (p && typeof p.text === "string") t += p.text + "\n";
      if (typeof m.name === "string") t += " " + m.name;
    }
    if (Array.isArray(body.tools)) for (const tool of body.tools) t += JSON.stringify(tool) + "\n";
    if (Array.isArray(body.functions)) for (const fn of body.functions) t += JSON.stringify(fn) + "\n";
    if (typeof body.prompt === "string") t += body.prompt + "\n";
    if (Array.isArray(body.input)) t += body.input.join(" ") + "\n";
    if (typeof body.suffix === "string") t += body.suffix + "\n";
  } catch (_) {}
  return t;
}

// StreamTap — instantiated per request (stream or non-stream). The scrub
// transform calls feedSseBlock for each block; for non-stream we call feedJson
// with the captured body. finalize() returns counts once we no longer touch the
// client connection.
class StreamTap {
  constructor(body) {
    this.usage = null;
    this.content = "";
    this._promptText = "";
    this._promptTokens = null;
    this.body = body;
    if (body) {
      this._promptText = promptTextOf(body);
      // Kick off prompt tokenization in the next microtask — overlaps network.
      const txt = this._promptText;
      process.nextTick(() => {
        try { this._promptTokens = countTokens(txt); } catch (_) {}
      });
    }
  }

  // block = raw SSE block text (may span multiple lines incl. "data:" lines)
  feedSseBlock(block) {
    if (!block) return;
    const lines = String(block).split("\n");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let d;
      try { d = JSON.parse(raw); } catch (_) { continue; }
      this._ingestJson(d);
    }
  }

  // For non-stream responses: pass the full response body JSON or text.
  feedJson(text) {
    if (!text) return;
    let d;
    try { d = JSON.parse(text); } catch (_) {
      // Not JSON — treat as raw text completion.
      this.content += text;
      return;
    }
    this._ingestJson(d);
  }

  // Ingest any shape we recognize: OpenAI chat, OpenAI text completions,
  // Anthropic-style "content.parts", Gemini-style "candidates.content.parts".
  _ingestJson(d) {
    if (!d || typeof d !== "object") return;
    if (d.usage && typeof d.usage.total_tokens === "number") this.usage = d.usage;
    if (Array.isArray(d.choices)) for (const ch of d.choices) {
      if (!ch) continue;
      const delta = ch.delta, msg = ch.message;
      if (delta) {
        if (typeof delta.content === "string") this.content += delta.content;
        else if (Array.isArray(delta.content)) for (const p of delta.content) if (p && typeof p.text === "string") this.content += p.text;
        if (typeof delta.reasoning_content === "string") this.content += delta.reasoning_content;
        if (typeof delta.reasoning === "string") this.content += delta.reasoning;
        if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) if (tc && tc.function) {
          if (typeof tc.function.name === "string") this.content += " " + tc.function.name;
          if (typeof tc.function.arguments === "string") this.content += tc.function.arguments;
        }
      }
      if (msg) {
        if (typeof msg.content === "string") this.content += msg.content;
        else if (Array.isArray(msg.content)) for (const p of msg.content) if (p && typeof p.text === "string") this.content += p.text;
        if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) if (tc && tc.function) {
          if (typeof tc.function.name === "string") this.content += " " + tc.function.name;
          if (typeof tc.function.arguments === "string") this.content += tc.function.arguments;
        }
      }
      if (typeof ch.text === "string") this.content += ch.text;
    }
    if (Array.isArray(d.content)) for (const p of d.content) if (p && typeof p.text === "string") this.content += p.text;
    if (typeof d.text === "string") this.content += d.text;
    if (Array.isArray(d.candidates)) for (const cn of d.candidates) if (cn && cn.content && Array.isArray(cn.content.parts)) for (const p of cn.content.parts) if (typeof p?.text === "string") this.content += p.text;
    if (d.response && typeof d.response.text === "string") this.content += d.response.text;
  }

  // After the rest of the request is done, call finalize. Optionally return
  // { promptTokens, completionTokens, totalTokens, source }.
  finalize() {
    if (this.usage) {
      return {
        promptTokens:     this.usage.prompt_tokens || 0,
        completionTokens: this.usage.completion_tokens || 0,
        totalTokens:      this.usage.total_tokens || 0,
        source: "upstream",
      };
    }
    if (this._promptTokens == null) this._promptTokens = countTokens(this._promptText);
    const ct = countTokens(this.content);
    const pt = this._promptTokens;
    return { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct, source: "approx" };
  }
}

module.exports = { ensureInit, countTokens, promptTextOf, StreamTap };
