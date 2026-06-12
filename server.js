const http = require("http");
const { spawn, execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = 3131;
const BASE = __dirname;
const CONFIG_FILE = path.join(BASE, "config.json");
const USAGE_FILE = path.join(BASE, "usage.json");
const CACHE_DIR = path.join(BASE, "cache");
const SKILLS_DIR = path.join(BASE, "skills");

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ensureCache(projectName) {
  const dir = path.join(CACHE_DIR, projectName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  match[1].split("\n").forEach(line => {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) result[key.trim()] = rest.join(":").trim();
  });
  return result;
}

function readSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const content = fs.readFileSync(path.join(SKILLS_DIR, f), "utf8");
      const fm = parseFrontmatter(content);
      return {
        id: f.replace(".md", ""),
        name: f.replace(".md", "").replace(/-/g, " "),
        file: f,
        model: fm.model || null,
        mcp: fm.mcp || null,
        allowedTools: fm.allowedTools || null,
      };
    });
}

function getMCPStatus() {
  try {
    const out = execSync("claude mcp list 2>/dev/null", { timeout: 5000 }).toString();
    const servers = [];
    out.split("\n").forEach(line => {
      if (line.trim()) {
        const connected = line.toLowerCase().includes("connected") || line.toLowerCase().includes("running");
        const name = line.split(/[\s:]/)[0].trim();
        if (name) servers.push({ name, status: connected ? "connected" : "disconnected" });
      }
    });
    return servers;
  } catch {
    return [];
  }
}

function getProjectByID(id) {
  const config = readJSON(CONFIG_FILE, { projects: [] });
  return config.projects.find(p => p.id === id);
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    exec(`git ${args.join(" ")}`, { cwd }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout.trim());
    });
  });
}

function spawnClaude(args, cwd) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("claude", args, { cwd, env: { ...process.env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("close", code => {
      const duration = Math.round((Date.now() - start) / 1000);
      resolve({ stdout, stderr, code, duration });
    });
    child.on("error", reject);
  });
}

function parseTokens(output) {
  const inputMatch = output.match(/(\d[\d,]*)\s*input token/i);
  const outputMatch = output.match(/(\d[\d,]*)\s*output token/i);
  return {
    inputTokens: inputMatch ? parseInt(inputMatch[1].replace(/,/g, "")) : 0,
    outputTokens: outputMatch ? parseInt(outputMatch[1].replace(/,/g, "")) : 0,
  };
}

function appendUsage(entry) {
  const usage = readJSON(USAGE_FILE, []);
  usage.unshift({ id: randomUUID(), ...entry });
  writeJSON(USAGE_FILE, usage);
}

function body(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", d => b += d);
    req.on("end", () => {
      try { resolve(JSON.parse(b)); } catch { resolve({}); }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = req.url.split("?")[0];
  const query = Object.fromEntries(new URLSearchParams(req.url.split("?")[1] || ""));

  log(`${req.method} ${url}`);

  try {

    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(BASE, "index.html")));
    }

    if (req.method === "GET" && url === "/ping") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/config") {
      return send(res, 200, readJSON(CONFIG_FILE, {}));
    }

    if (req.method === "POST" && url === "/settings") {
      const b = await body(req);
      const config = readJSON(CONFIG_FILE, {});
      config.settings = { ...config.settings, ...b };
      writeJSON(CONFIG_FILE, config);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/skills") {
      return send(res, 200, readSkills());
    }

    if (req.method === "GET" && url === "/mcp") {
      const live = getMCPStatus();
      const config = readJSON(CONFIG_FILE, {});
      config.mcpServers = live;
      writeJSON(CONFIG_FILE, config);
      return send(res, 200, live);
    }

    if (req.method === "GET" && url === "/projects") {
      const config = readJSON(CONFIG_FILE, { projects: [] });
      const projects = config.projects.map(p => {
        const cacheDir = path.join(CACHE_DIR, p.name);
        const claudeCache = readJSON(path.join(cacheDir, "claude.json"), null);
        const githubCache = readJSON(path.join(cacheDir, "github.json"), null);
        return {
          ...p,
          claudeCache,
          currentBranch: githubCache?.currentBranch || null,
          branches: githubCache?.branches || [],
          githubFetchedAt: githubCache?.githubFetchedAt || null,
          claudeFetchedAt: claudeCache?.fetchedAt || null,
        };
      });
      return send(res, 200, { projects, skills: readSkills(), commonSkills: config.commonSkills || [] });
    }

    if (req.method === "POST" && url === "/projects") {
      const b = await body(req);
      const config = readJSON(CONFIG_FILE, { projects: [] });
      if (b.cloneUrl) {
        const cloneDir = config.settings?.defaultCloneLocation || process.env.HOME;
        const name = b.cloneUrl.split("/").pop().replace(".git", "");
        await new Promise((resolve, reject) => {
          exec(`git clone ${b.cloneUrl}`, { cwd: cloneDir }, (err, stdout, stderr) => {
            if (err) reject(stderr); else resolve();
          });
        });
        const projectPath = path.join(cloneDir, name);
        const project = { id: randomUUID(), name, path: projectPath, skills: [] };
        config.projects.push(project);
        writeJSON(CONFIG_FILE, config);
        return send(res, 200, { ok: true, project });
      } else if (b.path) {
        const name = path.basename(b.path);
        if (config.projects.find(p => p.path === b.path))
          return send(res, 400, { ok: false, error: "Project already added" });
        const project = { id: randomUUID(), name, path: b.path, skills: [] };
        config.projects.push(project);
        writeJSON(CONFIG_FILE, config);
        return send(res, 200, { ok: true, project });
      }
      return send(res, 400, { ok: false, error: "path or cloneUrl required" });
    }

    if (req.method === "DELETE" && url.match(/^\/projects\/[^/]+$/)) {
      const id = url.split("/")[2];
      const config = readJSON(CONFIG_FILE, { projects: [] });
      config.projects = config.projects.filter(p => p.id !== id);
      writeJSON(CONFIG_FILE, config);
      return send(res, 200, { ok: true });
    }

    const projectMatch = url.match(/^\/projects\/([^/]+)\/(.+)$/);
    if (projectMatch) {
      const id = projectMatch[1];
      const action = projectMatch[2];
      const project = getProjectByID(id);
      if (!project) return send(res, 404, { ok: false, error: "Project not found" });

      if (req.method === "GET" && action === "cache") {
        const cacheDir = path.join(CACHE_DIR, project.name);
        const claudeCache = readJSON(path.join(cacheDir, "claude.json"), null);
        const githubCache = readJSON(path.join(cacheDir, "github.json"), null);
        return send(res, 200, { claudeCache, githubCache });
      }

      if (req.method === "POST" && action === "skills") {
        const b = await body(req);
        const config = readJSON(CONFIG_FILE, { projects: [] });
        const p = config.projects.find(p => p.id === id);
        if (!p.skills) p.skills = [];
        if (!p.skills.find(s => s.id === b.skillId)) {
          p.skills.push({ id: b.skillId, model: null });
          writeJSON(CONFIG_FILE, config);
        }
        return send(res, 200, { ok: true });
      }

      if (req.method === "DELETE" && action.startsWith("skills/")) {
        const skillId = action.split("/")[1];
        const config = readJSON(CONFIG_FILE, { projects: [] });
        const p = config.projects.find(p => p.id === id);
        p.skills = (p.skills || []).filter(s => s.id !== skillId);
        writeJSON(CONFIG_FILE, config);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && action === "reparse") {
        const claudeMdPath = path.join(project.path, "CLAUDE.md");
        if (!fs.existsSync(claudeMdPath)) {
          log(`Running claude /init in ${project.path}`);
          await spawnClaude(["/init"], project.path);
        }
        if (!fs.existsSync(claudeMdPath))
          return send(res, 400, { ok: false, error: "CLAUDE.md not found even after /init" });
        const claudeMd = fs.readFileSync(claudeMdPath, "utf8");
        const prompt = `Read this CLAUDE.md file and extract structured information. Return ONLY valid JSON with these exact fields: summary (string, 1-2 sentences describing the project), stack (array of technology name strings), structure (string, folder tree as plain text). No markdown formatting, no explanation, just the raw JSON object.\n\nCLAUDE.md:\n${claudeMd}`;
        const config = readJSON(CONFIG_FILE, {});
        const model = config.settings?.reparseModel || "claude-haiku-4-5-20251001";
        const result = await spawnClaude(["-p", prompt, "--model", model], project.path);
        const reparseTokens = parseTokens(result.stdout + result.stderr);
        appendUsage({ timestamp: new Date().toISOString(), project: project.name, projectId: id, skill: "reparse", model, inputTokens: reparseTokens.inputTokens, outputTokens: reparseTokens.outputTokens, duration: reparseTokens.duration });
        try {
          const clean = result.stdout.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          const cacheDir = ensureCache(project.name);
          writeJSON(path.join(cacheDir, "claude.json"), { ...parsed, fetchedAt: new Date().toISOString() });
          return send(res, 200, { ok: true, data: parsed });
        } catch {
          return send(res, 500, { ok: false, error: "Failed to parse response", raw: result.stdout });
        }
      }

      if (req.method === "POST" && action === "run") {
        const b = await body(req);
        const { skillId, model, isFirst } = b;
        const skillFile = path.join(SKILLS_DIR, `${skillId}.md`);
        if (!fs.existsSync(skillFile))
          return send(res, 404, { ok: false, error: "Skill file not found" });
        const skillContent = fs.readFileSync(skillFile, "utf8");
        const fm = parseFrontmatter(skillContent);
        const prompt = skillContent.replace(/^---[\s\S]*?---\n/, "").trim();
        const config = readJSON(CONFIG_FILE, {});
        const effectiveModel = model || fm.model || config.settings?.defaultModel || "claude-sonnet-4-6";
        const args = ["-p", prompt, "--model", effectiveModel];
        if (!isFirst) args.push("--continue");
        if (fm.allowedTools) args.push("--allowedTools", fm.allowedTools);
        log(`Running skill ${skillId} on ${project.name} with model ${effectiveModel}`);
        const result = await spawnClaude(args, project.path);
        const tokens = parseTokens(result.stdout + result.stderr);
        appendUsage({
          timestamp: new Date().toISOString(),
          project: project.name,
          projectId: id,
          skill: skillId,
          model: effectiveModel,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          duration: result.duration,
        });
        return send(res, 200, { ok: true, output: result.stdout, tokens, duration: result.duration });
      }

      if (req.method === "POST" && action === "branch/switch") {
        const b = await body(req);
        await runGit(project.path, ["checkout", b.branch]);
        const cacheDir = ensureCache(project.name);
        const githubCache = readJSON(path.join(cacheDir, "github.json"), {});
        githubCache.currentBranch = b.branch;
        writeJSON(path.join(cacheDir, "github.json"), githubCache);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && action === "branch/refresh") {
        const branches = await runGit(project.path, ["branch", "-a", "--format=%(refname:short)"]);
        const current = await runGit(project.path, ["branch", "--show-current"]);
        const branchList = [...new Set(
          branches.split("\n")
            .map(b => b.trim().replace(/^origin\//, ""))
            .filter(b => b && !b.includes("HEAD"))
        )];
        const cacheDir = ensureCache(project.name);
        const existing = readJSON(path.join(cacheDir, "github.json"), {});
        existing.branches = branchList;
        existing.currentBranch = current;
        writeJSON(path.join(cacheDir, "github.json"), existing);
        return send(res, 200, { ok: true, branches: branchList, currentBranch: current });
      }

      if (req.method === "POST" && action === "github/refresh") {
        const prompt = `Use the GitHub MCP server to fetch data for the repository in the current directory.
Get: 1) All open pull requests with fields: number, title, state, author (login), branch (head ref), isDraft, reviewDecision, createdAt, updatedAt
2) All open issues with fields: number, title, labels (array of name strings), assignees (array of login strings), author (login), createdAt
Return ONLY a raw JSON object with shape: {"prs": [...], "issues": [...]}. No markdown, no explanation.`;
        const config2 = readJSON(CONFIG_FILE, {});
        const githubModel = config2.settings?.reparseModel || "claude-haiku-4-5-20251001";
        const result = await spawnClaude(["-p", prompt, "--model", githubModel], project.path);
        const githubTokens = parseTokens(result.stdout + result.stderr);
        appendUsage({ timestamp: new Date().toISOString(), project: project.name, projectId: id, skill: "github-refresh", model: githubModel, inputTokens: githubTokens.inputTokens, outputTokens: githubTokens.outputTokens, duration: githubTokens.duration });
        try {
          const clean = result.stdout.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          const cacheDir = ensureCache(project.name);
          const existing = readJSON(path.join(cacheDir, "github.json"), {});
          writeJSON(path.join(cacheDir, "github.json"), {
            ...existing, ...parsed, githubFetchedAt: new Date().toISOString()
          });
          return send(res, 200, { ok: true, data: parsed });
        } catch {
          return send(res, 500, { ok: false, error: "Failed to parse GitHub response", raw: result.stdout });
        }
      }

      if (req.method === "GET" && action === "usage") {
        const usage = readJSON(USAGE_FILE, []);
        const projectUsage = usage.filter(u => u.projectId === id || u.project === project.name);
        const totalTokens = projectUsage.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0);
        return send(res, 200, { runs: projectUsage, totalTokens });
      }
    }

    if (req.method === "GET" && url === "/usage") {
      const usage = readJSON(USAGE_FILE, []);
      let filtered = usage;
      if (query.project) filtered = filtered.filter(u => u.project === query.project);
      if (query.model) filtered = filtered.filter(u => u.model === query.model);
      if (query.skill) filtered = filtered.filter(u => u.skill === query.skill);
      if (query.from) filtered = filtered.filter(u => u.timestamp >= query.from);
      if (query.to) filtered = filtered.filter(u => u.timestamp <= query.to + "T23:59:59");
      const totalTokens = filtered.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0);
      const avgDuration = filtered.length ? Math.round(filtered.reduce((s, u) => s + (u.duration || 0), 0) / filtered.length) : 0;
      const skillCounts = {};
      filtered.forEach(u => skillCounts[u.skill] = (skillCounts[u.skill] || 0) + 1);
      const topSkill = Object.entries(skillCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      return send(res, 200, { runs: filtered, totalTokens, avgDuration, topSkill, count: filtered.length });
    }

    if (req.method === "GET" && url === "/scan") {
      const scanPath = query.path;
      if (!scanPath || !fs.existsSync(scanPath))
        return send(res, 400, { ok: false, error: "Invalid path" });
      const config = readJSON(CONFIG_FILE, { projects: [] });
      const existing = new Set(config.projects.map(p => p.path));
      const found = [];
      fs.readdirSync(scanPath).forEach(name => {
        try {
          const full = path.join(scanPath, name);
          if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, ".git")) && !existing.has(full)) {
            found.push({ name, path: full });
          }
        } catch {}
      });
      return send(res, 200, { projects: found });
    }

    send(res, 404, { error: "Not found" });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    send(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude Launcher → http://localhost:${PORT}\n`);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
});
