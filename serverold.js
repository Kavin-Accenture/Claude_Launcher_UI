const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 3131;

// ── simple request logger ──────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${msg}`);
}

// ── run claude -p "<prompt>" detached ─────────────────────────────────────
function runClaude(prompt, cwd) {
  const workDir = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME || "/tmp";
  log(`Spawning: claude -p "${prompt.slice(0, 60)}..." in ${workDir}`);

  const child = spawn("claude", ["-p", prompt], {
    cwd: workDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref(); // fire-and-forget — browser doesn't wait
  return child.pid;
}

// ── tiny HTTP router ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS so the HTML file can call this even when opened as file://
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ── serve the UI ──────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  // ── health check ─────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── trigger claude ────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/run") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { prompt, cwd } = JSON.parse(body);
        if (!prompt || !prompt.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "prompt is required" }));
        }
        const pid = runClaude(prompt.trim(), cwd);
        log(`Launched PID ${pid}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude Launcher running → http://localhost:${PORT}\n`);
});
