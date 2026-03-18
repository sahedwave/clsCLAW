# Codex Local v4

A real Codex-like coding agent that runs on your Mac.  
**Zero external npm dependencies** — pure Node.js built-ins only.

---

## Requirements

- Node.js 18+ (check: `node -v`)
- Docker (optional — enables full filesystem sandbox)
- Git (optional — enables worktrees and branch isolation)

## Setup

```bash
cd codex-local-v4
bash start.sh
# Browser opens at http://localhost:3737
```

First launch: click the folder path in the topbar → set your project root and Anthropic API key.

---

## What is actually implemented

### Sandbox layer (`src/sandbox/sandbox.js`)
- **Docker mode** (if Docker is running): each command runs in `node:20-alpine` with `--network=none --memory=512m --cap-drop=ALL`. Full filesystem isolation.
- **Restricted mode** (no Docker): `child_process` with blocked command list, path whitelist enforcement, sanitized env.
- All file writes are path-checked against project root before touching disk.

### Approval workflow (`src/diff/approvalQueue.js`)
- Every file change proposed by an agent is stored in memory as a **pending change**.
- Nothing writes to disk until you click **Approve** in the Diff panel.
- On approve: file is written, original backed up as `.codex-bak.<timestamp>`, `git add` called if in a repo.
- On reject: no disk change, record kept in history.

### Diff viewer (`src/diff/diff.js` + `src/diff/lineDiff.js`)
- Real line-level diff using Myers algorithm (built-in, no `diff` package).
- Shows added/removed/context lines with line numbers.
- Displayed in the right panel and the main Diff view.

### Agent system (`src/agents/agentManager.js` + `agentWorker.js`)
- Each agent runs in its own **Worker Thread** — isolated module scope, separate memory.
- Up to 7 agents run concurrently; extras queue.
- Agents parse Claude's output for `// SAVE_AS:` and `# RUN:` directives and route them to the approval queue and permission gate respectively. No auto-write.
- Cancel and retry are real (worker `.terminate()` and re-spawn).

### Permission gate (`src/sandbox/permissions.js`)
- Shell commands block on a Promise until you click Allow/Deny in the Permissions panel.
- 5-minute timeout — auto-reject if unanswered.
- Full history of approved/rejected actions.

### Git worktrees (`src/worktrees/worktrees.js`)
- Real `git worktree add -b codex/agent-<name>-<id>` per agent.
- Agents write to their own branch — no conflict with your working tree.
- Merge (normal/squash/rebase), diff, and remove from the Worktrees panel.
- Requires the project to be a git repository.

### Context engine (`src/context/contextEngine.js`)
- Walks project files, extracts symbols (functions, classes), imports, tokens.
- Relevance scoring: token overlap + symbol match + filename match + recency.
- Chunk selection: picks the highest-scoring 100-line chunks within a token budget.
- **Not** embedding-based — that requires an external API. Stated limitation.

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
- Webhooks: code exists but requires a public URL to receive events.

### Live updates (`src/sse.js`)
- Server-Sent Events replace WebSocket — no `ws` package needed.
- All agent events, diff proposals, permission requests stream to the UI in real time.

---

## What is NOT possible locally (honest)

| Feature | Reason |
|---------|--------|
| True VM sandbox | Needs Firecracker/gVisor — not local |
| Embedding-based retrieval | Needs embedding API or local model |
| Slack integration | Needs outbound webhooks + Slack app setup |
| GitHub webhook receive | Needs public URL (use ngrok as workaround) |
| Multi-user / auth | Single user only |
| Cloud task delegation | By definition requires cloud |

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
