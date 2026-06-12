# Claude Launcher

A minimal web UI to fire `claude -p` commands from the browser — no API key needed, just your Claude subscription.

## Files

```
claude-launcher/
├── server.js   ← Node.js server (connects browser → terminal)
└── index.html  ← Web UI
```

## Setup

**1. Install Claude Code** (if you haven't already)
```bash
npm install -g @anthropic-ai/claude-code
claude   # log in with your Claude account
```

**2. Start the server**
```bash
node server.js
```

**3. Open the UI**

Visit → http://localhost:3131

That's it. Type a prompt, set your project folder, hit Run.

## How it works

```
Browser UI  →  POST /run  →  server.js  →  spawn("claude -p …")
                                            (detached, fire-and-forget)
```

The server runs `claude -p "<your prompt>"` as a detached background process. You won't see output in the browser — Claude just runs in the terminal silently.

## Tips

- Set the **working directory** to your project folder so Claude operates in the right place
- Use the **quick prompt chips** for common tasks
- Press **Ctrl+Enter** to fire without clicking Run
- The green dot confirms the server is running
