/**
 * agentWorker.js — Runs inside a Worker Thread
 *
 * v5 upgrades:
 *   - Role-typed system prompts: analyze, code, test, review, docs
 *   - Streaming: forwards tokens via parentPort as they arrive
 *   - Memory injection: receives relevant memories in workerData
 */
'use strict';

const { workerData, parentPort } = require('worker_threads');

if (!workerData || !parentPort) { module.exports = {}; return; }

const path = require('path');

const { agentId, agentName, task, projectRoot, apiKey, contextFiles, role, memory, activeAgentContext = [] } = workerData;

function send(type, payload = {}) { parentPort.postMessage({ type, agentId, ...payload }); }
function log(msg, level = 'info') { send('log', { msg, level, time: Date.now() }); }

// ── Role prompts ──────────────────────────────────────────────────────────────
const BASE_RULES = `
RULES:
1. For every file you want to create or modify, output a code block with this EXACT comment on the first line:
   // SAVE_AS: relative/path/to/file.ext
   Content goes through human approval + diff review before writing to disk.
2. For shell commands: use bash blocks with:  # RUN: command
3. Before any code or commands, briefly explain your understanding, approach, justification, and self-check.
4. Be explicit. No placeholders. Produce complete working code.
5. Do not add source-code comments unless they are genuinely necessary for non-obvious logic.`;

const ROLE_PROMPTS = {
  analyze: (n,id,r) => `You are cLoSe Analyzer "${n}" (${id}). Working dir: ${r}
Role: READ and UNDERSTAND existing code. Do NOT write files unless absolutely necessary.
Produce structured analysis: what files do, key functions, relationships, issues, recommendations.${BASE_RULES}`,

  code: (n,id,r) => `You are cLoSe Builder "${n}" (${id}). Working dir: ${r}
Role: WRITE or MODIFY source files. Produce complete, production-ready code.
Follow existing style. Handle edge cases. Prefer clean product behavior over the quickest patch.
Explain why your chosen implementation is safer or cleaner than the obvious alternative.${BASE_RULES}`,

  test: (n,id,r) => `You are cLoSe Tester "${n}" (${id}). Working dir: ${r}
Role: WRITE test files. Detect framework (jest/vitest/mocha/pytest).
Write REAL tests with specific assertions — not stubs. Cover happy path, edge cases, errors.${BASE_RULES}`,

  review: (n,id,r) => `You are cLoSe Reviewer "${n}" (${id}). Working dir: ${r}
Role: REVIEW code and propose improvements via SAVE_AS blocks.
Look for: bugs, security issues, missing error handling, performance problems, style issues.
For each issue: describe problem, propose fix as SAVE_AS block, explain why it's better.${BASE_RULES}`,

  docs: (n,id,r) => `You are cLoSe Docs Writer "${n}" (${id}). Working dir: ${r}
Role: WRITE documentation. Update README.md, improve explanations, and keep docs crisp and practical.${BASE_RULES}`,
};

function buildSystem() {
  const awareness = activeAgentContext.length === 0
    ? '\n\nNo other active agents currently.'
    : `\n\nACTIVE AGENT COORDINATION:\n${activeAgentContext.map(a =>
      `- ${a.name} [${a.status}] role=${a.role}\n  task: ${String(a.task || '').slice(0, 180)}\n  files: ${(a.files || []).join(', ') || '(none yet)'}`
    ).join('\n')}\n\nAvoid duplicate work and reduce file conflicts. Prefer files not already listed above unless the task explicitly requires overlap.`;
  return (ROLE_PROMPTS[role] || ROLE_PROMPTS.code)(agentName, agentId, projectRoot) + awareness;
}

// ── Parser ────────────────────────────────────────────────────────────────────
function parseOutput(text) {
  const proposals = [], commands = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1]||'').toLowerCase(), body = m[2];
    const save = body.match(/^(?:\/\/|#|<!--)\s*SAVE_AS:\s*(.+?)(?:\s*-->)?\s*$/m);
    if (save) {
      const rel = save[1].trim();
      proposals.push({ filePath: rel.startsWith('/') ? rel : path.join(projectRoot, rel), content: body, relativePath: rel, lang });
    }
    if ((lang === 'bash'||lang === 'sh') && body.match(/^#\s*RUN:\s*(.+)/m)) {
      commands.push({ command: body.match(/^#\s*RUN:\s*(.+)/m)[1].trim(), raw: body });
    }
  }
  return { proposals, commands };
}

// ── Memory extraction ─────────────────────────────────────────────────────────
function extractMemory(text, proposals) {
  const decisions = [];
  const re = /(?:chose|decided|using|selected|went with|picked)\s+(.{10,80}?)(?:\.|because|since)/gi;
  let m;
  while ((m = re.exec(text)) !== null) decisions.push(m[0].trim().slice(0, 120));
  return {
    decisions: decisions.slice(0, 3),
    fileSummaries: proposals.map(p => ({
      filePath: p.filePath,
      summary: `${p.lang||'file'} — ${p.relativePath} (${agentName}, role:${role||'code'})`,
    })),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runAgent() {
  log(`"${agentName}" started [role: ${role||'code'}]`);
  send('status', { status: 'running' });

  const ctxSection = contextFiles?.length > 0
    ? `\n\nProject context:\n\n${contextFiles.map(f=>`--- ${f.relativePath} ---\n${(f.content||'').slice(0,3000)}`).join('\n\n')}`
    : '';
  const memSection = memory?.trim()
    ? `\n\nPROJECT MEMORY (previous tasks):\n${memory}`
    : '';
  const userMessage = `${task}${ctxSection}${memSection}`;

  try {
    log('Calling Claude (streaming)...');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:8096, stream:true, system:buildSystem(), messages:[{role:'user',content:userMessage}] }),
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    let replyText = '', buffer = '';
    for await (const chunk of res.body) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            replyText += evt.delta.text;
            send('token', { text: evt.delta.text });   // ← live token to browser
          }
        } catch {}
      }
    }

    if (!replyText) throw new Error('Empty response');
    log(`Done (${replyText.length} chars)`);
    send('reply', { text: replyText });

    const { proposals, commands } = parseOutput(replyText);
    log(`${proposals.length} proposal(s), ${commands.length} command(s)`);

    for (const p of proposals) send('propose_file', { filePath:p.filePath, content:p.content, relativePath:p.relativePath, lang:p.lang });
    for (const c of commands)  send('propose_command', { command:c.command, raw:c.raw });

    const { decisions, fileSummaries } = extractMemory(replyText, proposals);
    send('memory', { decisions, fileSummaries, outcome:{ task, summary:`${role||'code'} agent: ${proposals.length} file(s) proposed`, filesChanged:proposals.map(p=>p.relativePath) } });

    send('status', { status: 'done' });
    log(`"${agentName}" complete`);
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    send('status', { status: 'error', error: err.message });
  }
}

runAgent().catch(err => parentPort.postMessage({ type:'status', agentId, status:'error', error:err.message }));
