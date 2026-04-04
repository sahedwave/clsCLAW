(function () {
  function openAgentModal(ctx) {
    document.getElementById('modal-agent').style.display = 'flex';
  }

  async function launchParallelBatch(ctx) {
    const raw = prompt('Enter parallel tasks, one per line. Prefix with "role:name: task" or "role: task".\n\nExample:\nanalyze: repo map\nreview: auth flow risks\ncode: Fix settings modal');
    if (!raw) return;
    const tasks = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line, idx) => {
      const parts = line.split(':');
      if (parts.length >= 3) {
        return {
          role: parts[0].trim() || 'code',
          agentName: parts[1].trim() || `Agent ${idx + 1}`,
          task: parts.slice(2).join(':').trim(),
          contextQuery: parts.slice(2).join(':').trim(),
          useWorktree: true,
        };
      }
      if (parts.length === 2) {
        return {
          role: parts[0].trim() || 'code',
          agentName: `Agent ${idx + 1}`,
          task: parts[1].trim(),
          contextQuery: parts[1].trim(),
          useWorktree: true,
        };
      }
      return {
        role: 'code',
        agentName: `Agent ${idx + 1}`,
        task: line,
        contextQuery: line,
        useWorktree: true,
      };
    }).filter((item) => item.task);
    if (!tasks.length) return;
    const result = await ctx.api('POST', '/api/agents/orchestrate', {
      tasks,
      apiKey: ctx.currentApiKey(),
    }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (result?.agents?.length) {
      ctx.toast(`⇉ Launched ${result.agents.length} agent${result.agents.length === 1 ? '' : 's'} in parallel`, 'ok');
      ctx.setView('agents');
      ctx.loadAgents();
    }
  }

  async function launchSwarmPrompt(ctx) {
    const goal = prompt('Swarm goal:');
    if (!goal || !goal.trim()) return;
    const maxAgentsRaw = prompt('Max agents (2-6):', '4');
    const maxAgents = Math.max(2, Math.min(6, Number(maxAgentsRaw) || 4));
    const result = await ctx.api('POST', '/api/swarm/preview', {
      goal,
      maxAgents,
      apiKey: ctx.currentApiKey(),
    }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (result?.tasks?.length) {
      ctx.setCurrentSwarmPreview(result);
      ctx.renderSwarmPreview();
      ctx.toast(`🕸 Swarm preview ready — ${result.tasks.length} specialist task${result.tasks.length === 1 ? '' : 's'}`, 'ok');
      ctx.setView('agents');
    }
  }

  async function launchSwarmFromPreview(ctx) {
    const preview = ctx.getCurrentSwarmPreview();
    if (!preview?.goal) {
      ctx.toast('No swarm preview ready', 'warn');
      return;
    }
    const result = await ctx.api('POST', '/api/swarm', {
      goal: preview.goal,
      maxAgents: preview.maxAgents || preview.tasks?.length || 4,
      apiKey: ctx.currentApiKey(),
    }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (result?.agents?.length) {
      ctx.toast(`🕸 Swarm launched — ${result.agents.length} specialist agent${result.agents.length === 1 ? '' : 's'}`, 'ok');
      ctx.setCurrentSwarmPreview(null);
      ctx.renderSwarmPreview();
      ctx.setView('agents');
      await loadAgents(ctx);
      await loadSwarmSessions(ctx);
    }
  }

  async function loadSwarmSessions(ctx) {
    const host = document.getElementById('swarm-sessions-host');
    if (!host) return;
    const sessions = await ctx.api('GET', '/api/swarm/sessions?limit=6').catch(() => []);
    host.innerHTML = window.clsClawOpsModules?.renderSwarmSessions
      ? window.clsClawOpsModules.renderSwarmSessions(sessions)
      : '';
  }

  async function loadDelegationTargets(ctx) {
    const host = document.getElementById('delegation-host');
    if (!host) return;
    const targets = await ctx.api('GET', '/api/delegation/targets').catch(() => []);
    const dispatches = await ctx.api('GET', '/api/delegation/dispatches?limit=4').catch(() => []);
    const enabledCount = (targets || []).filter((target) => target.enabled).length;
    host.innerHTML = `
      <div class="discover-panel">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Remote Delegation</div>
            <div class="discover-summary">Delegate a task to another clsClaw instance with signed requests.</div>
          </div>
          <button class="gh-btn" style="width:auto;padding:6px 10px;margin:0" onclick="createDelegationTarget()">add target</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="review-anchor exact">targets:${ctx.esc((targets || []).length)}</span>
          <span class="review-anchor ${enabledCount > 0 ? 'exact' : 'shifted'}">enabled:${ctx.esc(enabledCount)}</span>
          <span class="review-anchor ${(dispatches || []).length ? 'exact' : 'shifted'}">dispatches:${ctx.esc((dispatches || []).length)}</span>
        </div>
        ${(targets || []).length ? targets.map((target) => `
          <div class="discover-card" style="cursor:default;margin-bottom:8px">
            <div class="discover-top">
              <span class="discover-label">${ctx.esc(target.enabled ? 'enabled' : 'disabled')}</span>
              <span class="discover-profile">${ctx.esc(target.name || 'target')}</span>
            </div>
            <div class="discover-detail">${ctx.esc(target.url || '')}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              <span class="review-anchor exact">${ctx.esc(target.keyId || 'key')}</span>
              <span class="review-anchor ${target.sharedSecretConfigured ? 'exact' : 'shifted'}">${target.sharedSecretConfigured ? 'secret ready' : 'missing secret'}</span>
              ${target.healthStatus ? `<span class="review-anchor ${target.healthStatus === 'reachable' ? 'exact' : 'shifted'}">${ctx.esc(target.healthStatus)}</span>` : ''}
            </div>
            ${(target.lastDispatchAt || target.lastPingAt || target.lastDispatchError || target.lastPingError) ? `
              <div style="font-size:10px;color:var(--muted);line-height:1.6;margin-top:8px">
                ${target.lastDispatchAt ? `dispatch ${ctx.esc(target.lastDispatchStatus || 'sent')} · ${ctx.esc(ctx.timeAgo(target.lastDispatchAt))}` : 'no dispatch yet'}
                ${target.lastDispatchError ? ` · ${ctx.esc(target.lastDispatchError)}` : ''}
                ${target.lastPingAt ? `<br>ping ${ctx.esc(target.healthStatus || 'unknown')} · ${ctx.esc(ctx.timeAgo(target.lastPingAt))}${target.lastPingError ? ` · ${ctx.esc(target.lastPingError)}` : ''}` : ''}
              </div>
            ` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="dispatchDelegationTarget('${target.id}')">delegate current task</button>
              <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="pingDelegationTarget('${target.id}')">ping</button>
              <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="editDelegationTarget('${target.id}')">edit</button>
              <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="toggleDelegationTarget('${target.id}', ${target.enabled ? 'false' : 'true'})">${target.enabled ? 'disable' : 'enable'}</button>
              <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="deleteDelegationTarget('${target.id}')">delete</button>
            </div>
          </div>
        `).join('') : `<div style="font-size:11px;color:var(--muted)">No remote delegation targets yet.</div>`}
        ${(dispatches || []).length ? `<div style="margin-top:10px;font-size:10px;color:var(--hint);text-transform:uppercase;letter-spacing:.08em">Recent dispatches</div>${window.clsClawOpsModules?.renderDelegationDispatches ? window.clsClawOpsModules.renderDelegationDispatches(dispatches) : ''}` : ''}
      </div>
    `;
  }

  async function createDelegationTarget(ctx) {
    const name = prompt('Remote clsClaw name');
    if (name === null) return;
    const url = prompt('Remote clsClaw base URL (for example https://remote.example.com)');
    if (url === null) return;
    const sharedSecret = prompt('Shared secret for signed delegation requests');
    if (sharedSecret === null) return;
    const result = await ctx.api('POST', '/api/delegation/targets', { name, url, sharedSecret }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Delegation target saved', 'ok');
    loadDelegationTargets(ctx);
  }

  async function toggleDelegationTarget(ctx, id, enabled) {
    const result = await ctx.api('PATCH', `/api/delegation/targets/${id}`, { enabled }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast(`✓ Target ${enabled ? 'enabled' : 'disabled'}`, 'ok');
    loadDelegationTargets(ctx);
  }

  async function editDelegationTarget(ctx, id) {
    const current = (await ctx.api('GET', '/api/delegation/targets').catch(() => [])).find((item) => item.id === id);
    if (!current) {
      ctx.toast('Target not found', 'err');
      return;
    }
    const name = prompt('Remote clsClaw name', current.name || '');
    if (name === null) return;
    const url = prompt('Remote clsClaw base URL', current.url || '');
    if (url === null) return;
    const result = await ctx.api('PATCH', `/api/delegation/targets/${id}`, { name, url }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Delegation target updated', 'ok');
    loadDelegationTargets(ctx);
  }

  async function deleteDelegationTarget(ctx, id) {
    const result = await ctx.api('DELETE', `/api/delegation/targets/${id}`).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Delegation target removed', 'ok');
    loadDelegationTargets(ctx);
  }

  async function pingDelegationTarget(ctx, id) {
    const result = await ctx.api('POST', `/api/delegation/targets/${id}/ping`, {}).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result) return;
    ctx.toast(result.ok ? '✓ Remote target reachable' : `Target ${result.status || 'unreachable'}`, result.ok ? 'ok' : 'warn');
    loadDelegationTargets(ctx);
  }

  async function dispatchDelegationTarget(ctx, id) {
    const goal = (document.getElementById('prompt')?.value || '').trim() || prompt('What should the remote clsClaw work on?');
    if (!goal) return;
    const result = await ctx.api('POST', '/api/delegation/dispatch', { targetId: id, goal, role: ctx.getChatMode() === 'build' ? 'code' : 'analyze' }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Remote delegation dispatched', 'ok');
    loadDelegationTargets(ctx);
  }

  async function loadAgents(ctx) {
    const agents = await ctx.api('GET', '/api/agents').catch(() => []);
    const running = agents.filter((a) => a.status === 'running').length;
    ctx.updateBadge('rp-agent-badge', running);
    renderAgentList(ctx, agents, 'agents-list', true);
    renderAgentList(ctx, agents.slice(0, 4), 'mini-agents', false);
    await loadSwarmSessions(ctx);
    await loadDelegationTargets(ctx);
  }

  function renderAgentList(ctx, agents, containerId, full) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!agents.length) {
      el.innerHTML = `<div class="empty-state"><span style="font-size:22px">⚡</span><span>No agents</span></div>`;
      return;
    }
    el.innerHTML = [...agents].reverse().map((a) => {
      const proposalCount = a.proposals?.length || 0;
      const cmdCount = a.commands?.length || 0;
      const approvedCmds = (a.commands || []).filter((c) => c.status === 'approved').length;
      return `
        <div class="agent-card ${ctx.esc(a.status || 'queued')}" data-agent-id="${ctx.esc(a.id)}">
          <div class="ag-hdr">
            <div class="ag-dot ${ctx.esc(a.status || 'queued')}"></div>
            <div class="ag-name">${ctx.esc(a.name || 'Agent')}</div>
            ${a.role && a.role !== 'code' ? `<span style="font-size:9px;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:rgba(124,106,247,0.1);color:var(--accent2)">${ctx.esc(a.role)}</span>` : ''}
            <div class="ag-status">${ctx.esc(a.status || 'queued')}${a.endTime ? ' · ' + ctx.esc(ctx.timeDiff(a.startTime, a.endTime)) : a.startTime ? ' · ' + ctx.esc(ctx.timeAgo(a.startTime)) : ''}</div>
          </div>
          <div class="ag-task">${ctx.esc(a.task || '')}</div>
          ${(a.provider || a.model) ? `<div style="font-size:10px;font-family:var(--mono);color:var(--accent2);margin:3px 0">🧠 ${ctx.esc([a.provider, a.model].filter(Boolean).join(' · '))}</div>` : ''}
          ${a.parentAgentId ? `<div style="font-size:10px;font-family:var(--mono);color:var(--muted);margin:2px 0">↳ child of ${ctx.esc(a.parentAgentId.slice(0, 8))}</div>` : ''}
          ${(a.children?.length || 0) > 0 ? `<div style="font-size:10px;font-family:var(--mono);color:var(--muted);margin:2px 0">⇢ ${a.children.length} child agent${a.children.length === 1 ? '' : 's'}</div>` : ''}
          ${a.pendingInputs ? `<div style="font-size:10px;font-family:var(--mono);color:var(--amber);margin:2px 0">⏳ ${a.pendingInputs} queued follow-up${a.pendingInputs === 1 ? '' : 's'}</div>` : ''}
          ${a.logs?.length ? `<div class="ag-log">${a.logs.slice(-3).map((l) => `<div class="${l.level === 'error' ? 'l-err' : ''}">${ctx.esc(l.msg)}</div>`).join('')}</div>` : ''}
          ${proposalCount > 0 ? `
            <div style="font-size:10px;font-family:var(--mono);color:var(--blue);margin:4px 0;cursor:pointer" onclick="setView('changes')">
              📄 ${proposalCount} file proposal${proposalCount !== 1 ? 's' : ''} — click to review
            </div>` : ''}
          ${cmdCount > 0 ? `
            <div style="font-size:10px;font-family:var(--mono);color:var(--muted);margin:2px 0">
              ⚡ ${cmdCount} command${cmdCount !== 1 ? 's' : ''} ${approvedCmds > 0 ? '(' + approvedCmds + ' approved)' : '(pending approval)'}
            </div>` : ''}
          ${a.worktreePath ? `
            <div style="font-size:10px;font-family:var(--mono);color:var(--muted);margin:2px 0">
              🌿 ${ctx.esc(ctx.shortPath(a.worktreePath))}
            </div>` : ''}
          ${a.error ? `<div style="font-size:10px;font-family:var(--mono);color:var(--red);margin:3px 0">${ctx.esc(a.error)}</div>` : ''}
          <div class="ag-acts">
            ${a.status === 'running' ? `<button class="ag-btn cancel" onclick="cancelAgent('${ctx.esc(a.id)}')">cancel</button>` : ''}
            ${a.status === 'error' ? `<button class="ag-btn" onclick="retryAgent('${ctx.esc(a.id)}')">retry</button>` : ''}
            <button class="ag-btn" onclick="spawnChildAgent('${ctx.esc(a.id)}')">spawn child</button>
            <button class="ag-btn" onclick="sendAgentFollowup('${ctx.esc(a.id)}', false)">follow-up</button>
            ${a.status === 'running' ? `<button class="ag-btn" onclick="sendAgentFollowup('${ctx.esc(a.id)}', true)">interrupt</button>` : ''}
            <button class="ag-btn" onclick="waitOnAgent('${ctx.esc(a.id)}')">wait</button>
            ${a.status !== 'running' ? `<button class="ag-btn" onclick="closeAgent('${ctx.esc(a.id)}')">close</button>` : ''}
            ${proposalCount > 0 ? `<button class="ag-btn" onclick="setView('changes')">review changes</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  window.clsClawAgentView = {
    openAgentModal,
    launchParallelBatch,
    launchSwarmPrompt,
    launchSwarmFromPreview,
    loadSwarmSessions,
    loadDelegationTargets,
    createDelegationTarget,
    toggleDelegationTarget,
    editDelegationTarget,
    deleteDelegationTarget,
    pingDelegationTarget,
    dispatchDelegationTarget,
    loadAgents,
    renderAgentList,
  };
})();
