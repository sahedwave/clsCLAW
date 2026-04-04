# clsClaw Features

This file is the practical feature inventory for `clsClaw` as it exists in the current codebase.

It focuses on what a user can actually use inside the app today.

## 1. Core Workspace

- Local-first AI engineering workspace running on your machine
- Browser UI served locally
- Project-root aware file browsing and editing
- Multi-panel operator workspace
- Chat, reviews, approvals, agents, automations, GitHub, apps/connectors, artifacts, and worktrees in one app
- Live mission-control style status surfaces

## 2. Chat and Orchestration

- Normal chat mode
- Build / execute mode
- Phase-aware orchestration
  - inspect
  - act
  - verify
  - ask
  - await approval
  - final
- Inspect-before-act behavior
- Evidence-aware answer composition
- Clarifying-question behavior when intent is materially ambiguous
- Verification-aware completion behavior
- Direct-answer fast path for obvious low-risk requests

## 3. Execution Profiles

- `quick`
- `deliberate`
- `execute`
- `parallel`

These profiles affect:
- inspection depth
- autonomy budget
- approval sensitivity
- verification expectations
- step limits

## 4. Mission Control and Transparency

- Live phase display
- Current profile display
- Evidence status summary
- Approval-required state
- Next-action summary
- Privacy / local-ownership summary
- Workspace Pulse summary
- Closeout summaries for changed / verified / uncertain / next

## 5. Evidence and Grounding

- Unified evidence bundle per turn
- Evidence categories across:
  - workspace
  - docs
  - web
  - image
  - shell
  - GitHub
  - connector
- Citation-labelled evidence tracking
- Evidence deck rendering in chat and review surfaces
- Source summaries in review bundles
- Audit-friendly artifact content rendering

## 6. Review and Approval Workflow

- Pending file change queue
- Approve / reject / edit-and-approve flows
- Exact-line inline review comments
- Review bundles with:
  - summary
  - grouped findings
  - inline comments
  - evidence summary
  - visual debug context
  - approval context
  - GitHub export state
  - verification notes
  - audit trail
- Approval rationale panels
- Conflict detection for multiple pending edits on the same file
- Approval history
- Review acknowledgement flows for automation-generated reviews

## 7. Diff and Patch Support

- Line-level diffs
- Patch proposal materialization
- Surgical update hunk application
- File proposal generation from patch documents
- Side-by-side change review in UI

## 8. File and Workspace Operations

- File tree browsing
- Safe file read
- Safe file write through approval flow
- Safe file delete through permission gate
- Patch-based file proposal creation
- Path safety enforcement against project root

## 9. Sandbox and Command Execution

- Restricted local execution mode
- Docker sandbox mode
- Optional gVisor-style Docker runtime selection when `runsc` is available
- Host escalation path for commands that require:
  - network access
  - desktop / GUI control
  - Docker / GitHub CLI / similar host-native tools
- Command assessment before execution
- Allowlist / blocked-command policy
- Install detection
- Permission queue for shell and install requests
- Timed auto-rejection of stale permission requests

## 10. Agents

- Worker-thread based agent execution
- Up to 7 concurrent agents
- Queueing for overflow agents
- Cancel / retry flows
- Child agent spawning
- Parent / child tracking
- Agent logs
- Agent replies
- Agent token streaming
- Agent provider/model metadata
- Pending input queue for agents

## 11. Swarm / Parallel Coordination

- Swarm preview before launch
- Bounded swarm planning
- Multi-agent launch from one goal
- Swarm session persistence in memory
- Swarm session list
- Task-level swarm status
- Merge summary for swarm sessions
- Swarm session counts:
  - queued
  - running
  - done
  - error
  - cancelled

## 12. Worktrees

- Git worktree creation
- Per-agent isolated worktrees
- Branch isolation for agent work
- Worktree list / refresh
- Merge support
- Remove worktree support

## 13. Planner

- Plan generation for multi-step tasks
- Plan progress metadata
- Plan summary
- Plan risk level
- Success criteria output
- Plan event streaming

## 14. Context and Retrieval

- Offline keyword retrieval
- File indexing
- Chunk selection
- Symbol and token extraction
- Filename / token / symbol / recency relevance scoring
- Semantic retrieval via:
  - OpenAI embeddings
  - Anthropic embeddings
  - local Ollama embeddings
- Context stats and reindexing
- Auto-inspected context prompt injection for relevant coding/review tasks

## 15. Model Provider Support

- Anthropic
- OpenAI
- Ollama

Supports:
- chat/completion style calls
- multimodal image analysis path
- provider routing
- provider health/config masking
- local embedding model configuration

## 16. Multimodal and Visual Debugging

- Image upload and storage
- Screenshot attachment in chat
- Vision analysis for UI/software tasks
- Visual debug workflow with:
  - visible issue summary
  - related files
  - docs/web sources
  - confidence / grounding status
  - debug lane presentation
  - next-step recommendations
- Visual evidence in review bundles

## 17. Web and Docs

- Web search
- Web open
- Docs-focused search
- Readable text extraction from fetched pages
- Official-doc domain inference
- Evidence generation from web/docs results

## 18. GitHub

- Token-based GitHub connection
- Load authenticated GitHub user
- Repo list
- Clone repo
- Git status
- Commit and push
- Create pull request
- List PRs
- Compare refs / commits
- Search GitHub issues / repos
- PR review inspector
- PR review bundle generation
- PR thread loading
- Issue comment loading and posting
- Reaction flows
- GitHub webhook receiving
- GitHub webhook verification via shared secret
- GitHub webhook inbox view
- GitHub webhook artifact capture

## 19. Slack

- Built-in Slack connector
- Send message to configured incoming webhook
- Send artifact summaries to Slack
- Send heartbeat notifications to Slack

## 20. Connectors and MCP Registry

- Built-in connector catalog
- Built-in connector trust metadata
- Connector actions
- Connector resources
- Docs connector
- Workspace connector
- Skills connector
- Automations connector
- GitHub connector
- Slack connector
- MCP registry view
- Custom MCP registry entry create/update/delete
- Custom MCP enable / disable
- Registry health and trust metadata
- Plugin/bundled extension visibility in registry

## 21. Skills

Built-in skill execution includes:
- `security-audit`
- `run-tests`
- `lint`
- `dependency-check`
- `file-stats`
- `git-log`

Skill-related features:
- list skills
- run skills
- install local plugins
- extension-backed skill exposure

## 22. Automations

- Built-in scheduler
- Persistent automation jobs
- Enable / disable jobs
- Trigger job now
- Job results
- Notification/inbox generation
- Promote inbox notification to memory
- Ack inbox notification

## 23. Heartbeat / Proactive Jobs

Built-in heartbeat presets:
- workspace briefing
- log watchdog
- scheduled reflection
- weekly coding report
- deadline reminder
- paper tracker
- team status briefing

Heartbeat-related features:
- heartbeat preset listing
- heartbeat quick creation
- heartbeat inbox
- reviewable heartbeat outputs
- artifact creation from heartbeat runs
- source surfacing in heartbeat notifications
- memory recording from heartbeat jobs

## 24. Memory

- Local memory store
- Query memory for agent tasks
- Automation note recording
- Promotion of notifications into memory

## 25. Artifacts

- Persistent artifact store
- Artifact index
- Artifact detail loading
- Artifact metadata rendering
- Parsed turn-report rendering
- Raw JSON fallback view
- Artifact creator attribution
- Turn-report artifact creation for meaningful tool-heavy turns
- Artifact use from companion feed and inbox workflows

## 26. Companion / Always-On Surfaces

- Companion feed
- Companion summary
- Feed merges:
  - notifications
  - artifacts
  - pending approvals
  - recent turns
  - jobs
- Heartbeat Home style surfaces in the automations view

## 27. Auth and Local Collaboration

- First-run admin bootstrap
- Sign in / sign out
- Persistent local sessions
- Admin-only user management
- Create user
- Disable / enable user
- Delete user
- Session listing
- Top-bar auth badge
- Actor attribution on:
  - turns
  - approvals
  - artifacts
- Collaboration activity feed

## 28. Remote Delegation and Tunnel Support

- Tunnel manager for:
  - `cloudflared`
  - `ngrok`
- Tunnel configure / start / stop
- Public URL detection from tunnel process output
- Remote delegation target registry
- Signed outbound delegation requests
- Signed inbound delegation execution endpoint
- Delegation target enable / disable
- Dispatch history
- Agent-view delegation controls

## 29. Privacy and Local Ownership

- Privacy endpoint
- Local ownership summary in UI
- Local storage visibility for:
  - artifacts
  - memory
  - turns
  - approvals
- Provider configuration masking
- Auth state visibility

## 30. Live Updates

- Server-Sent Events
- Real-time updates for:
  - agents
  - plans
  - turns
  - permissions
  - approvals
  - automations
  - notifications

## 31. Security and Workspace Identity

- Workspace audit
- Audit fix helper
- Workspace identity files
- Identity prompt injection
- Red-line command blocking from workspace policy

## 32. Discoverability and UX Helpers

- Guided workflow cards
- Slash-style workflow seeds
  - `/review`
  - `/fix`
  - `/verify`
  - `/debug-ui`
  - `/brief`
- Reference chips
  - `@file`
  - `@review`
  - `@artifact`
- Workspace Pulse home card
- Evidence deck cards
- Review studio style rendering

## 33. Utility / Diagnostics

- Health endpoint and health modal
- Context stats
- Sandbox info endpoint
- Provider config endpoints
- Turn trace inspection
- Recent turn listing
- Recent change listing
- Permission list
- Artifact list

## 34. What still depends on external runtime or infrastructure

These are supported by the app, but still depend on something outside the app itself:

- Docker sandboxing needs Docker installed
- gVisor mode needs Docker plus `runsc`
- Git worktrees need Git and a Git repo
- Slack messaging needs a valid Slack webhook URL and outbound network access
- GitHub integration needs a valid GitHub token for authenticated actions
- GitHub inbound webhook delivery needs a public URL or local tunnel
- Tunnel start requires `cloudflared` or `ngrok` to be installed
- Remote delegation requires another reachable `clsClaw` instance
- Ollama support requires a reachable local Ollama server

## 35. Short summary

`clsClaw` currently combines:
- local coding workspace
- chat + orchestration
- approvals + reviews
- agents + swarm
- multimodal debugging
- retrieval + evidence
- GitHub + Slack
- automations + heartbeat
- artifacts + memory
- auth + attribution
- tunnel + remote delegation

This is the working capability surface available to the user in the current implementation.
