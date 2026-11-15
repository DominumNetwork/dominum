require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const { server: wispServer } = require("@mercuryworkshop/wisp-js/server");

const crypto = require("crypto");

const PORT = process.env.PORT || 4180;
const EMIS_BASE_URL = process.env.EMIS_BASE_URL || "https://emis.zxs-is-very.cool/v1";
const EMIS_API_KEY = process.env.EMIS_API_KEY || "";

const app = express();
app.use(express.json());

app.use(
  "/uv2/uv",
  express.static(path.join(__dirname, "uv2/uv"))
);
app.use(
  "/uv2/prxy",
  express.static(path.join(__dirname, "uv2/prxy"))
);

// Cached list of chat models the configured emis backend currently offers,
// so the AI page can show a real dropdown instead of a hardcoded model id.
let _emisModels = [];
let _emisDefault = "gpt-4o-mini";
let _emisModelsAt = 0;
async function refreshEmisModels() {
  if (_emisModels.length && Date.now() - _emisModelsAt < 5 * 60 * 1000) return;
  try {
    const r = await fetch(EMIS_BASE_URL.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${EMIS_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return;
    const data = await r.json();
    const list = Array.isArray(data.data) ? data.data : [];
    if (list.length) {
      _emisModels = list.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        owned_by: m.owned_by || "",
        reasoning: !!m.reasoning,
        tools: !!m.tools,
        vision: !!m.vision,
      }));
      _emisDefault = data.default || _emisModels[0].id;
      _emisModelsAt = Date.now();
    }
  } catch {}
}

app.get("/api/ai/models", async (_req, res) => {
  await refreshEmisModels();
  res.json({ models: _emisModels, default: _emisDefault });
});

// Proxies the site's AI chat panel to emis so the bearer key never reaches the browser.
app.post("/api/ai/chat", async (req, res) => {
  await refreshEmisModels();
  const body = JSON.stringify({
    model: req.body.model || _emisDefault,
    messages: req.body.messages || [],
    stream: false,
  });

  const url = new URL(EMIS_BASE_URL.replace(/\/+$/, "") + "/chat/completions");
  const upstream = https.request(
    {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${EMIS_API_KEY}`,
      },
    },
    (upstreamRes) => {
      let data = "";
      upstreamRes.on("data", (chunk) => (data += chunk));
      upstreamRes.on("end", () => {
        res.status(upstreamRes.statusCode || 500);
        res.set("Content-Type", "application/json");
        res.send(data);
      });
    }
  );

  upstream.on("error", (err) => {
    res.status(502).json({ error: "AI backend unreachable", detail: err.message });
  });

  upstream.write(body);
  upstream.end();
});

// Generic CORS-free fetch relay, used by the extensions engine to pull
// .crx downloads and arbitrary extension-store assets past the browser's CORS wall.
let _proxyConcurrent = 0;
const _PROXY_MAX = 12;
const _proxyQueue = [];
function _proxyAcquire() {
  return new Promise((resolve) => {
    if (_proxyConcurrent < _PROXY_MAX) { _proxyConcurrent++; resolve(); }
    else _proxyQueue.push(resolve);
  });
}
function _proxyRelease() {
  const next = _proxyQueue.shift();
  if (next) next();
  else _proxyConcurrent--;
}

app.get("/api/proxy", async (req, res) => {
  const url = (req.query.url || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).end("invalid url");

  const fetchFollow = async (startUrl, headers, signal, maxRedirects = 6) => {
    let cur = startUrl;
    for (let hops = 0; hops <= maxRedirects; hops++) {
      const r = await fetch(cur, { headers, redirect: "manual", signal });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return r;
        const next = new URL(loc, cur).href;
        if (next === cur) return r;
        cur = next;
      } else {
        return r;
      }
    }
    throw new Error("Too many redirects");
  };

  await _proxyAcquire();
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: req.headers["accept"] || "*/*",
      "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
    };
    const r = await fetchFollow(url, headers, AbortSignal.timeout(12000));
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.setHeader("cache-control", "public, max-age=86400");
    res.setHeader("access-control-allow-origin", "*");
    res.status(r.status);
    const buf = await r.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (e) {
    res.status(502).end(e.message);
  } finally {
    _proxyRelease();
  }
});

// Fetches a Chrome extension's .crx package from Google's update service so
// it can be unpacked and installed into the in-browser extension engine.
app.get("/api/crx", async (req, res) => {
  const id = (req.query.id || "").trim().toLowerCase();
  if (!id || !/^[a-z]{32}$/.test(id)) return res.status(400).end("invalid extension id");

  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0.6478.127&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  try {
    let cur = crxUrl;
    for (let hop = 0; hop < 8; hop++) {
      const r = await fetch(cur, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) break;
        cur = new URL(loc, cur).href;
      } else if (r.ok) {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("cache-control", "public, max-age=3600");
        const buf = await r.arrayBuffer();
        return res.end(Buffer.from(buf));
      } else {
        return res.status(r.status).end(r.status === 404 ? "Extension not found — check the ID" : `HTTP ${r.status}`);
      }
    }
    res.status(502).end("Too many redirects");
  } catch (e) {
    res.status(502).end(e.message);
  }
});

// --- Password-gated download ---
const DOWNLOAD_PASSWORD_HASH = "35eec79afb86c206d969b1a3629c84cfc96e28821268e5f9bbc0c59a8e9de6c4";
const _downloadTokens = new Map();

app.get("/download", (_req, res) => {
  res.sendFile(path.join(__dirname, "download.html"));
});

app.post("/api/download/verify", (req, res) => {
  const pw = (req.body && req.body.password) || "";
  const hash = crypto.createHash("sha256").update(pw).digest("hex");
  if (hash !== DOWNLOAD_PASSWORD_HASH) {
    return res.json({ ok: false, error: "Incorrect key." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  _downloadTokens.set(token, Date.now());
  setTimeout(() => _downloadTokens.delete(token), 5 * 60 * 1000);
  res.json({ ok: true, token });
});

app.get("/api/download/file", (req, res) => {
  const token = (req.query.token || "").trim();
  if (!token || !_downloadTokens.has(token)) {
    return res.status(403).json({ error: "Invalid or expired token." });
  }
  _downloadTokens.delete(token);
  const zipPath = path.join(__dirname, "..", "dominum-main.zip");
  res.download(zipPath, "dominum-main.zip");
});

app.use(express.static(__dirname));

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wispServer.routeRequest(req, socket, head);
  } else {
    socket.end();
  }
});

server.listen(PORT, () => {
  console.log(`Dominum listening on :${PORT}`);
});
