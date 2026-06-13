# Claude Launcher

A local Node.js web UI for managing and triggering Claude Code agents across multiple projects. No npm dependencies — pure Node.js built-ins only.

## Project summary

Claude Launcher lets you register git projects, assign skills (Claude Code agent prompts) to them, trigger skill runs from a browser UI, and track token usage. It runs as a local HTTP server on port 3131.

## Stack

- Node.js (built-ins only: http, fs, path, child_process, crypto)
- Vanilla HTML/CSS/JS single-page app (no framework)
- Claude Code CLI (`claude -p`) for all agent runs

## Folder structure

```
claude-launcher/
├── server.js          ← HTTP server, all API routes
├── index.html         ← single-page app, all four views
├── CLAUDE.md          ← this file
├── config.json        ← projects, skill assignments, settings, MCP server list
├── commands.json      ← all CLI commands used by the server (edit here, never hardcode)
├── usage.json         ← append-only interaction log (array of run entries)
├── cache/             ← per-project cached data (auto-created)
│   └── <project-name>/
│       ├── claude.json   ← parsed CLAUDE.md: summary, stack, structure, fetchedAt
│       └── github.json   ← branches, currentBranch, prs, issues, githubFetchedAt
└── skills/            ← skill markdown files (one file = one agent)
    └── <skill-name>.md
```

## config.json schema

```json
{
  "settings": {
    "defaultModel": "claude-sonnet-4-6",
    "defaultCloneLocation": "/projects",
    "reparseModel": "claude-haiku-4-5-20251001"
  },
  "mcpServers": [{ "name": "github", "status": "connected" }],
  "commonSkills": ["skill-id-1", "skill-id-2"],
  "projects": [
    {
      "id": "uuid",
      "name": "project-name",
      "path": "/absolute/path/to/project",
      "skills": [
        { "id": "skill-id", "model": null }
      ]
    }
  ]
}
```

- `commonSkills` — skill IDs shown on every project card in the dashboard
- `projects[].skills` — skills assigned to that project; `model: null` means use skill default
- Models are session-only overrides in the UI — `model` in config is always null unless explicitly saved

## usage.json schema

Array of run entries, newest first:

```json
[
  {
    "id": "uuid",
    "timestamp": "2026-06-12T14:32:00.000Z",
    "project": "project-name",
    "projectId": "uuid",
    "skill": "skill-id",
    "model": "claude-sonnet-4-6",
    "inputTokens": 2340,
    "outputTokens": 847,
    "duration": 34
  }
]
```

## Skill file format

Skills live in `skills/<skill-id>.md`. The filename (without `.md`) is the skill ID used everywhere in config and usage.

```markdown
---
model: claude-sonnet-4-6
mcp: github
allowedTools: git,file
---

Your prompt for Claude here. Write clear, specific instructions.
Claude runs this in the project's working directory.
All relative paths resolve to the project root.
```

Frontmatter fields:
- `model` — default model. If absent, falls back to `config.settings.defaultModel`
- `mcp` — MCP server name required. If that server is disconnected, the Run button is disabled in the UI
- `allowedTools` — passed to `claude --allowedTools`. Optional.

## server.js API routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Serves index.html |
| GET | `/ping` | Health check |
| GET | `/config` | Read config.json |
| POST | `/settings` | Update config.settings |
| GET | `/skills` | Scan skills/ folder, return all skill definitions |
| GET | `/mcp` | Run `claude mcp list`, update and return mcpServers |
| GET | `/projects` | All projects with cache summaries |
| POST | `/projects` | Add project by `{ path }` or `{ cloneUrl }` |
| DELETE | `/projects/:id` | Remove project from config |
| GET | `/projects/:id/cache` | Read claude.json and github.json for project |
| GET | `/projects/:id/usage` | Usage entries filtered to this project |
| POST | `/projects/:id/skills` | Assign skill `{ skillId }` to project |
| DELETE | `/projects/:id/skills/:skillId` | Unassign skill from project |
| POST | `/projects/:id/run` | Run skill `{ skillId, model, isFirst }` — spawns claude -p |
| POST | `/projects/:id/reparse` | Parse CLAUDE.md with Haiku, write cache/claude.json |
| POST | `/projects/:id/branch/switch` | git checkout branch, update cache |
| POST | `/projects/:id/branch/refresh` | git branch -a, update cache |
| POST | `/projects/:id/github/refresh` | Fetch PRs and issues via GitHub MCP |
| GET | `/scan?path=` | Find unregistered git projects in a directory |
| GET | `/usage` | All usage with optional filters: project, model, skill, from, to |

## index.html structure

Single-page app with four views swapped via `showPage()`:

- **dashboard** (`page-dashboard`) — project cards, branch dropdowns, add project modal
- **detail** (`page-detail`) — project detail with Summary / GitHub / Skills tabs
- **usage** (`page-usage`) — metrics + filterable run log
- **settings** (`page-settings`) — default model, clone location, MCP server list

Key JS state object:
```js
state = {
  projects: [],        // from /projects
  skills: [],          // from /skills
  commonSkills: [],    // from config
  mcpServers: [],      // from /mcp
  config: {},          // from /config
  currentProject: null,
  sessionModels: {},   // { projectId: { skillId: modelString } } — reset on navigation
  sessionFirstRun: {}  // { projectId: bool } — false after first run, controls --continue
}
```

Key functions:
- `loadDashboard()` — fetches /projects, renders project cards
- `openProject(id)` — resets session state, switches to detail view
- `loadProjectDetail(id)` — loads cache, renders all three tabs
- `renderSkillsTab(pid, project)` — renders assigned skills with model selectors and run buttons
- `runSkill(pid, skillId)` — POST /run, logs to usage, updates last-run bar
- `reparse(pid)` — POST /reparse, updates summary tab
- `refreshGithub(pid)` — POST /github/refresh, updates github tab
- `refreshBranches(pid)` — POST /branch/refresh, populates branch dropdown
- `switchBranch(pid, branch)` — POST /branch/switch, triggers reparse automatically
- `loadUsage()` — fetches /usage with current filters, renders metrics and rows
- `appendUsage(entry)` — server-side only, called after every skill run

## Behaviour rules

- **Branch switching** always triggers a CLAUDE.md reparse automatically
- **Session models** are temporary — model selector resets when navigating away from a project
- **Opus model** always requires a confirmation popup before applying (both skill assignment and branch-triggered reparse does not use Opus)
- **Reparse** always uses `claude-haiku-4-5-20251001` regardless of settings
- **--continue** is passed to all runs except the first in a project session (`isFirst: true`)
- **No --dangerously-skip-permissions** — Claude may prompt in terminal; UI shows hint to check terminal if run seems stuck
- **Skill removal** requires confirmation popup — unassigns from project only, never deletes the file
- **GitHub data and branch list** are never fetched automatically — always on explicit refresh
- **Relative timestamps** shown next to refresh buttons: "25 mins ago", "3 hrs ago" etc. Over 7 days shows "not refreshed in a while" in amber
- **Model color coding** in usage: Haiku = green, Sonnet = blue, Opus = red

## Adding a new skill — what to update

1. Create `skills/<skill-name>.md` with frontmatter and prompt
2. The skill appears automatically in the "Add skill" modal for any project
3. To make it a common skill (shown on dashboard cards), add the skill ID to `commonSkills` in config.json
4. No other files need editing — server reads skills/ dynamically on every request

## commands.json — CLI command registry

**All terminal commands used by the server must be defined here. Never hardcode a command string in server.js.**

```json
{
  "claude": "claude",
  "claudeMcpList": "claude mcp list",
  "git": "git",
  "gitClone": "git clone"
}
```

- `claude` — executable used in `spawnClaude()` for all AI runs (`-p`, reparse, github-refresh)
- `claudeMcpList` — full command used in `getMCPStatus()` to list MCP servers
- `git` — executable used in `runGit()` for branch operations (checkout, branch -a, etc.)
- `gitClone` — full command used when cloning a repo via the Add Project modal

`commands.json` is loaded once at server startup into the `COMMANDS` constant. If a command needs to change (e.g. full path to executable, different binary name on a platform), edit only this file — changes take effect on next server restart.

**When adding a new terminal command:** add a key here first, then reference `COMMANDS.<key>` in server.js.

## Adding a new API route — what to update

1. Add handler in `server.js` inside the main try/catch block
2. If it needs a new UI action, add the function in the `<script>` section of `index.html`
3. Update this CLAUDE.md if the route changes the data schema

## Adding a new UI view — what to update

1. Add a `<div id="page-<name>" class="page">` block in index.html
2. Add a nav link calling `showPage('<name>')`
3. Add the case to `showPage()` function
4. Add a load function following the pattern of `loadDashboard()` / `loadUsage()`
