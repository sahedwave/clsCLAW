# clsClaw

A local coding workspace called clsClaw that runs on your Mac.  
**Zero external npm dependencies** — pure Node.js built-ins only.

---

## Requirements

- Node.js 18+ (check: `node -v`)
- Docker (optional — enables full filesystem sandbox)
- Git (optional — enables worktrees and branch isolation)

## Setup

```bash
cd clsClaw
bash start.sh
# Open http://localhost:3737
```

First launch: click the folder path in the topbar and set:
- your project root
- one model provider (Anthropic, OpenAI, or Ollama)
- optional GitHub token

Semantic retrieval can use OpenAI, Anthropic, or a local Ollama embedding model when configured. Chat, agents, and plans can use any configured provider.

## Tests

```bash
node --test
# or: npm test
```

## Product Docs

- [FEATURES.md](FEATURES.md) — complete user-facing feature and capability inventory
- [COMPARE.md](COMPARE.md) — where `clsClaw` is stronger, weaker, and different from other agent products
- [VISION.md](VISION.md) — founder-style product vision and design principles

---

## What is actually implemented

### Sandbox layer (`src/sandbox/sandbox.js`)
- **Docker mode** (if Docker is running): each command runs in `node:20-alpine` with `--network=none --memory=512m --cap-drop=ALL`. Full filesystem isolation.
- **Restricted mode** (no Docker): `child_process` with blocked command list, path whitelist enforcement, sanitized env.
- All file writes are path-checked against project root before touching disk.

### Approval workflow (`src/diff/approvalQueue.js`)
- Every file change proposed by an agent is stored in memory as a **pending change**.
- Nothing writes to disk until you click **Approve** in the Diff panel.
- On approve: file is written, original backed up as `.clsclaw-bak.<timestamp>`, `git add` called if in a repo.
- On reject: no disk change, record kept in history.

### Diff viewer (`src/diff/diff.js` + `src/diff/lineDiff.js`)
- Real line-level diff using Myers algorithm (built-in, no `diff` package).
- Shows added/removed/context lines with line numbers.
- Displayed in the right panel and the main Diff view.

### Agent system (`src/agents/agentManager.js` + `agentWorker.js`)
- Each agent runs in its own **Worker Thread** — isolated module scope, separate memory.
- Up to 7 agents run concurrently; extras queue.
- Agents parse model output for `// SAVE_AS:` and `# RUN:` directives and route them to the approval queue and permission gate respectively. No auto-write.
- Cancel and retry are real (worker `.terminate()` and re-spawn).

### Permission gate (`src/sandbox/permissions.js`)
- Shell commands block on a Promise until you click Allow/Deny in the Permissions panel.
- 5-minute timeout — auto-reject if unanswered.
- Full history of approved/rejected actions.

### Git worktrees (`src/worktrees/worktrees.js`)
- Real `git worktree add -b clsclaw/agent-<name>-<id>` per agent.
- Agents write to their own branch — no conflict with your working tree.
- Merge (normal/squash/rebase), diff, and remove from the Worktrees panel.
- Requires the project to be a git repository.

### Context engine (`src/context/contextEngine.js`)
- Walks project files, extracts symbols (functions, classes), imports, tokens.
- Relevance scoring: token overlap + symbol match + filename match + recency.
- Chunk selection: picks the highest-scoring 100-line chunks within a token budget.
- Keyword retrieval always works offline.
- Optional semantic embeddings use OpenAI, Anthropic, or local Ollama when configured.

### Skills (`src/skills/skills.js`)
- Each skill is a real `execute(projectRoot)` function, not a prompt string.
- **security-audit**: regex scan for hardcoded secrets, eval(), innerHTML, HTTP URLs, possible SQL injection. Runs `npm audit` if package.json found.
- **run-tests**: detects and runs `npm test`, `pytest`, or `make test`.
- **lint**: runs ESLint or pylint if config files exist.
- **dependency-check**: runs `npm outdated` and/or `pip list --outdated`.
- **file-stats**: counts lines/files by extension.
- **git-log**: runs `git log` and `git status`.

### Automations (`src/automations/automations.js`)
- Cron-like scheduler using a built-in minimal implementation (no `node-cron`).
- Jobs persist to `data/jobs/jobs.json` across restarts.
- Can run any skill or command on a schedule.
- Results stored for review.

### GitHub integration (`src/github/github.js`)
- Real GitHub REST API v3 — authenticated with personal access token.
- Clone, status, commit+push (permission-gated), create PR, list PRs, fetch PR diff, submit PR review.
- Inbound webhooks: `POST /api/github/webhook` with signature verification when `githubWebhookSecret` is configured. Still needs a public URL or tunnel for GitHub to reach your local machine.

### Local auth (`src/auth/authStore.js`)
- Local username/password auth with scrypt-hashed passwords and persistent sessions.
- First-run bootstrap creates the local admin account.
- Additional local users can be created, disabled, and managed through the auth API and settings UI.
- Turn reports, approvals, and artifacts now carry local actor attribution for operator activity.

### Slack integration (`src/connectors/connectorManager.js`)
- Built-in Slack connector supports posting to a configured incoming webhook.
- Requires outbound network access and a Slack webhook URL.

### Tunnel + remote delegation (`src/remote/*.js`)
- Built-in tunnel manager can start `cloudflared` or `ngrok` locally when installed, then surface the public URL into the GitHub webhook workflow.
- Built-in remote delegation registry can store signed remote clsClaw targets and dispatch tasks to `/api/delegation/execute`.
- These features work in the app, but still depend on installed tunnel binaries or reachable remote clsClaw instances.

### Live updates (`src/sse.js`)
- Server-Sent Events replace WebSocket — no `ws` package needed.
- All agent events, diff proposals, permission requests stream to the UI in real time.

---

## What requires extra infrastructure or is not fully implemented yet

| Feature | Reason |
|---------|--------|
| True VM sandbox | clsClaw supports restricted, Docker, and optional gVisor-style container isolation; true microVM isolation still requires an external runtime stack |
| Direct internet webhook delivery | clsClaw can manage a local tunnel when `cloudflared` or `ngrok` is installed, but inbound internet delivery still depends on that external tunnel/provider |
| Full multi-user collaboration UX | Local users, attribution, and admin controls exist, but the app is still not a full concurrent shared workspace with presence/conflict UX |
| Cloud task delegation | clsClaw supports signed remote delegation to other reachable clsClaw instances, but actual cloud execution still requires remote infrastructure |

---

## File structure

```
src/
  server.js              Main Express server + SSE
  sse.js                 Server-Sent Events broadcaster
  sandbox/
    sandbox.js           Docker + restricted exec
    permissions.js       Permission gate (blocks until approved)
  diff/
    diff.js              Diff compute + apply
    lineDiff.js          Myers diff algorithm (built-in)
    approvalQueue.js     Pending changes management
  agents/
    agentManager.js      Worker thread pool
    agentWorker.js       Per-agent execution context
  worktrees/
    worktrees.js         Git worktree management
  context/
    contextEngine.js     File indexing + retrieval
  skills/
    skills.js            Executable skill modules
  automations/
    automations.js       Cron scheduler
    cronLite.js          Built-in cron implementation
  github/
    github.js            GitHub REST API client
public/
  index.html             Full UI (single file)
data/
  history/               Approval history (JSON)
  jobs/                  Scheduled jobs (JSON)
```
