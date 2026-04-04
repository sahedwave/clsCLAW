(function () {
  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;');
  }

  function timeAgo(ts) {
    const delta = Math.max(0, Date.now() - Number(ts || 0));
    const seconds = Math.round(delta / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  function renderMcpRegistry(entries = []) {
    if (!entries.length) {
      return `<div class="empty-state" style="min-height:auto;padding:12px"><span style="font-size:18px">🛰️</span><span>No ecosystem entries yet</span></div>`;
    }
    const total = entries.length;
    const custom = entries.filter((entry) => entry.source === 'custom').length;
    const ready = entries.filter((entry) => ['ready', 'configured', 'installed', 'available'].includes(entry.status) || ['configured', 'installed', 'available'].includes(entry.health?.status)).length;
    const needsAuth = entries.filter((entry) => entry.trust?.requiresAuth).length;
    const categories = [...new Set(entries.map((entry) => entry.metadata?.category || entry.kind || 'general'))].slice(0, 5);
    return `
      <div class="discover-panel" style="margin-bottom:10px">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Ecosystem Manager</div>
            <div class="discover-summary">Browse built-ins, plugins, and custom MCP servers with trust, auth, and readiness context.</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="mission-btn" onclick="createMcpPack('dev')">dev pack</button>
            <button class="mission-btn" onclick="createMcpPack('research')">research pack</button>
            <button class="mission-btn" onclick="exportMcpRegistry()">export</button>
            <button class="mission-btn" onclick="importMcpRegistry()">import</button>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="review-anchor exact">entries:${esc(total)}</span>
          <span class="review-anchor exact">ready:${esc(ready)}</span>
          <span class="review-anchor ${custom ? 'shifted' : 'exact'}">custom:${esc(custom)}</span>
          <span class="review-anchor ${needsAuth ? 'shifted' : 'exact'}">auth:${esc(needsAuth)}</span>
          ${categories.map((category) => `<span class="review-anchor exact">${esc(category)}</span>`).join('')}
        </div>
      </div>
      <div class="discover-grid">
      ${entries.map((entry) => `
        <div class="discover-card" style="cursor:default">
          <div class="discover-top">
            <span class="discover-label">${esc(entry.metadata?.category || entry.kind || 'entry')}</span>
            <span class="discover-profile">${esc(entry.health?.status || entry.status || 'ready')}</span>
          </div>
          <div class="discover-title">${esc(entry.icon || '🛰️')} ${esc(entry.name || 'Registry entry')}</div>
          <div class="discover-detail">${esc(entry.description || 'No description')}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <span class="review-anchor exact">${esc(entry.source || 'builtin')}</span>
            ${entry.trust?.verified ? '<span class="review-anchor exact">verified</span>' : '<span class="review-anchor shifted">custom</span>'}
            ${entry.trust?.requiresNetwork ? '<span class="review-anchor shifted">network</span>' : '<span class="review-anchor exact">offline</span>'}
            ${entry.trust?.requiresAuth ? '<span class="review-anchor shifted">auth</span>' : ''}
            ${entry.enabled === false ? '<span class="review-anchor shifted">disabled</span>' : ''}
          </div>
          ${entry.capabilities?.length ? `<div style="font-size:10px;font-family:var(--mono);color:var(--muted);margin-top:8px">${esc(entry.capabilities.slice(0, 5).join(' · '))}</div>` : ''}
          ${entry.transport ? `<div style="font-size:10px;font-family:var(--mono);color:var(--hint);margin-top:6px">${esc(entry.transport)}${entry.url ? ' · ' + esc(entry.url) : entry.command ? ' · ' + esc(entry.command) : ''}</div>` : ''}
          ${entry.health?.detail ? `<div style="font-size:10px;color:var(--muted);line-height:1.5;margin-top:8px">${esc(entry.health.detail)}</div>` : ''}
          ${entry.source === 'custom' ? `<div style="display:flex;gap:6px;margin-top:10px">
            <button class="gh-btn" style="width:auto;padding:6px 10px;margin:0" onclick="editMcpRegistryEntry('${escAttr(entry.id)}')">edit</button>
            <button class="gh-btn" style="width:auto;padding:6px 10px;margin:0" onclick="toggleMcpRegistryEntry('${escAttr(entry.id)}', ${entry.enabled === false ? 'true' : 'false'})">${entry.enabled === false ? 'enable' : 'disable'}</button>
            <button class="gh-btn" style="width:auto;padding:6px 10px;margin:0" onclick="deleteMcpRegistryEntry('${escAttr(entry.id)}')">delete</button>
          </div>` : ''}
        </div>
      `).join('')}
    </div>`;
  }

  function renderSwarmPreview(preview = null) {
    if (!preview) {
      return `<div class="empty-state" style="min-height:auto;padding:12px"><span style="font-size:18px">🕸️</span><span>No swarm preview yet</span><span>Preview a bounded swarm before launching it.</span></div>`;
    }
    return `
      <div class="discover-panel">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Swarm Preview</div>
            <div class="discover-summary">${esc(preview.summary || 'Bounded swarm plan')}</div>
          </div>
          <button class="mission-btn" onclick="launchSwarmFromPreview()">launch swarm</button>
        </div>
        <div class="review-findings-list">
          ${preview.tasks.map((task, index) => `
            <div class="review-finding-row">
              <span class="review-finding-bullet">${index + 1}</span>
              <span><strong>${esc(task.name)}</strong> · ${esc(task.role)} — ${esc(task.prompt)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderSwarmSessions(sessions = []) {
    if (!sessions.length) {
      return `<div class="empty-state" style="min-height:auto;padding:12px"><span style="font-size:18px">🕸️</span><span>No swarm sessions yet</span></div>`;
    }
    return sessions.map((session) => `
      <div class="discover-card" style="cursor:default;margin-bottom:8px">
        <div class="discover-top">
          <span class="discover-label">${esc(session.status || 'queued')}</span>
          <span class="discover-profile">${esc(timeAgo(session.createdAt))}</span>
        </div>
        <div class="discover-title">${esc(session.goal || 'Swarm session')}</div>
        <div class="discover-detail">${esc(session.mergeSummary || session.summary || 'Bounded swarm session')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <span class="review-anchor exact">done:${esc(session.counts?.done ?? 0)}</span>
          <span class="review-anchor exact">running:${esc(session.counts?.running ?? 0)}</span>
          <span class="review-anchor ${Number(session.counts?.error || 0) > 0 ? 'shifted' : 'exact'}">error:${esc(session.counts?.error ?? 0)}</span>
        </div>
        <div class="debug-lane">
          ${(session.tasks || []).map((task) => `
            <div class="debug-step">
              <div class="debug-step-stage">${esc(task.name)} · ${esc(task.role)}</div>
              <div class="debug-step-detail">${esc(task.status)}${task.reply ? ` — ${task.reply}` : task.error ? ` — ${task.error}` : ''}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  function renderCompanionFeed(feed = null) {
    const items = feed?.items || [];
    if (!items.length) {
      return `<div class="empty-state" style="min-height:auto;padding:12px"><span style="font-size:18px">📡</span><span>No companion activity yet</span></div>`;
    }
    const summary = feed.summary || {};
    return `
      <div class="discover-panel" style="margin-bottom:10px">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Companion Feed</div>
            <div class="discover-summary">Unread ${esc(summary.unreadNotifications ?? 0)} · approvals ${esc(summary.pendingApprovals ?? 0)} · artifacts ${esc(summary.recentArtifacts ?? 0)} · jobs ${esc(summary.scheduledJobs ?? 0)}</div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${items.map((item) => `
          <div class="discover-card" style="cursor:default">
            <div class="discover-top">
              <span class="discover-label">${esc(item.kind || 'feed')}</span>
              <span class="discover-profile">${esc(item.priority || 'normal')}</span>
            </div>
            <div class="discover-title">${esc(item.title || 'Feed item')}</div>
            <div class="discover-detail">${esc(item.summary || '')}</div>
            ${item.actor?.displayName || item.actor?.username ? `<div style="font-size:10px;color:var(--muted);margin-top:6px">by ${esc(item.actor.displayName || item.actor.username)}</div>` : ''}
            ${item.tags?.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${item.tags.map((tag) => `<span class="review-anchor exact">${esc(tag)}</span>`).join('')}</div>` : ''}
            <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
              <div style="font-size:10px;font-family:var(--mono);color:var(--muted);flex:1">${esc(timeAgo(item.createdAt))}</div>
              ${renderCompanionAction(item.action)}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderCompanionAction(action) {
    if (!action?.type || !action.id) return '';
    if (action.type === 'artifact') {
      return `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="openArtifact('${escAttr(action.id)}')">open artifact</button>`;
    }
    if (action.type === 'approval' || action.type === 'review') {
      return `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="setView('changes')">open queue</button>`;
    }
    if (action.type === 'job') {
      return `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="setView('auto')">open jobs</button>`;
    }
    return '';
  }

  function renderDelegationDispatches(dispatches = []) {
    if (!dispatches.length) {
      return `<div style="font-size:11px;color:var(--muted)">No remote dispatches yet.</div>`;
    }
    return `<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      ${dispatches.map((item) => `
        <div class="debug-step">
          <div class="debug-step-stage">${esc(item.targetName || 'target')} · ${esc(item.status || (item.ok ? 'accepted' : 'error'))}${item.role ? ` · ${esc(item.role)}` : ''}</div>
          <div class="debug-step-detail">${esc(item.goal || '')}${item.requestedBy?.username ? ` · by ${esc(item.requestedBy.username)}` : ''}${item.response?.artifactId ? ` · artifact ${esc(String(item.response.artifactId).slice(0, 8))}` : ''}${item.response?.agent?.id ? ` · agent ${esc(String(item.response.agent.id).slice(0, 8))}` : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            ${item.response?.artifactId ? `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="openArtifact('${escAttr(item.response.artifactId)}')">open artifact</button>` : ''}
            ${item.response?.agent?.id ? `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="setView('agents')">open agents</button>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
  }

  window.clsClawOpsModules = {
    renderMcpRegistry,
    renderSwarmPreview,
    renderSwarmSessions,
    renderCompanionFeed,
    renderDelegationDispatches,
  };
})();
