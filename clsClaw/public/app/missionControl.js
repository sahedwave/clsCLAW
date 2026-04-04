(function () {
  const VIEWS = ['chat', 'changes', 'perms', 'agents', 'worktrees', 'skills', 'apps', 'auto', 'github', 'ctx', 'plan', 'memory', 'identity', 'security'];

  function renderMissionControl(ctx) {
    const host = document.getElementById('mission-control');
    const summaryEl = document.getElementById('mission-summary');
    const subEl = document.getElementById('mission-sub');
    const chipsEl = document.getElementById('mission-chips');
    const detailEl = document.getElementById('mission-detail');
    if (!host || !summaryEl || !subEl || !chipsEl) return;
    const missionState = ctx.getMissionState();
    const showMissionControl = missionState?.lane === 'operation' && missionState?.ui?.showMissionControl !== false;
    host.style.display = showMissionControl ? 'grid' : 'none';
    if (!showMissionControl) return;
    const profile = missionState.profile || ctx.getExecutionProfile() || 'deliberate';
    const phase = missionState.phase || 'idle';
    summaryEl.textContent = missionState.summary || 'Idle. Start a task to see live orchestration state.';
    subEl.textContent = missionState.subtext || `profile=${profile} · phase=${phase}`;
    chipsEl.innerHTML = window.clsClawModules?.renderMissionControlChips
      ? window.clsClawModules.renderMissionControlChips({ missionState, executionProfile: ctx.getExecutionProfile() })
      : '';
    if (detailEl) {
      detailEl.innerHTML = window.clsClawModules?.renderMissionControlPanel
        ? window.clsClawModules.renderMissionControlPanel({ missionState, executionProfile: ctx.getExecutionProfile() })
        : '';
    }
  }

  function updateMissionControl(ctx, patch = {}) {
    const missionState = {
      ...ctx.getMissionState(),
      ...patch,
      updatedAt: Date.now(),
    };
    ctx.setMissionState(missionState);
    renderMissionControl(ctx);
  }

  function hydrateMissionFromTurn(ctx, turn) {
    if (!turn) return;
    const missionState = ctx.getMissionState();
    updateMissionControl(ctx, {
      turnId: turn.id || null,
      lane: turn.meta?.lane || missionState.lane || null,
      summary: turn.meta?.userText || turn.plan?.summary || 'Recent turn',
      subtext: [
        turn.meta?.intent ? `intent=${turn.meta.intent}` : '',
        turn.meta?.role ? `role=${turn.meta.role}` : '',
        turn.final?.provider ? `provider=${turn.final.provider}` : '',
      ].filter(Boolean).join(' · ') || 'Recent turn',
      profile: turn.meta?.profile || turn.plan?.executionProfile || missionState.profile,
      phase: turn.plan?.phase || turn.status || 'idle',
      nextAction: turn.plan?.nextAction || 'wait',
      ui: turn.meta?.ui || missionState.ui || null,
      evidenceStatus: turn.governor?.evidenceStatus || null,
      evidenceSummary: turn.evidenceBundle?.summary || '',
      approvalRequired: Boolean(turn.governor?.shouldPauseForApproval || turn.plan?.approvalRequired),
      privacySummary: missionState.privacySummary || '',
    });
  }

  async function loadMissionControl(ctx) {
    const recent = await ctx.api('GET', '/api/turns/recent?limit=1').catch(() => []);
    if (Array.isArray(recent) && recent.length) {
      hydrateMissionFromTurn(ctx, recent[0]);
      return;
    }
    updateMissionControl(ctx, {
      turnId: null,
      lane: null,
      summary: 'Idle. Start a task to see live orchestration state.',
      subtext: `No active turn · ${ctx.getExecutionProfile()} profile`,
      profile: ctx.getExecutionProfile(),
      phase: 'idle',
      nextAction: 'wait',
      ui: null,
      evidenceStatus: null,
      evidenceSummary: '',
      approvalRequired: false,
      privacySummary: ctx.getMissionState().privacySummary || '',
    });
  }

  async function loadPrivacySummary(ctx) {
    const data = await ctx.api('GET', '/api/privacy').catch(() => null);
    if (!data) return;
    const mode = data.remoteInferencePossible ? 'remote-capable' : data.localOnlyReady ? 'local-ready' : 'provider-pending';
    updateMissionControl(ctx, {
      privacySummary: `privacy=${mode} · storage=local`,
    });
  }

  function setView(ctx, v) {
    ctx.setCurrentView(v);
    window.clsClawStateStore?.set('currentView', v);
    VIEWS.forEach((id) => {
      const el = document.getElementById(`view-${id}`);
      if (el) el.style.display = 'none';
      const nav = document.getElementById(`nav-${id}`);
      if (nav) nav.classList.remove('active');
    });
    const viewEl = document.getElementById(`view-${v}`);
    if (viewEl) viewEl.style.display = 'flex';
    const navEl = document.getElementById(`nav-${v}`);
    if (navEl) navEl.classList.add('active');
    if (v === 'chat' && typeof window.ensureWelcomeSurface === 'function') {
      window.ensureWelcomeSurface();
    }
    if (v === 'worktrees') ctx.loadWorktrees();
    if (v === 'agents') ctx.loadAgents();
    if (v === 'apps') ctx.loadConnectors();
    if (v === 'auto') ctx.loadJobs();
    if (v === 'github') ctx.loadGitHubWebhooks();
    if (v === 'changes') {
      ctx.loadChanges();
      ctx.resetBadge('changes-badge');
    }
    if (v === 'perms') {
      ctx.loadPermissions();
      ctx.resetBadge('perms-badge');
    }
    if (v === 'ctx') ctx.refreshCtxStats();
    if (v === 'plan') ctx.loadPlans();
    if (v === 'memory') ctx.loadMemoryStats();
    if (v === 'identity') ctx.loadIdentityFiles();
    if (v === 'security') ctx.loadSecurityAudit();
  }

  function setRpTab(ctx, tab) {
    ['editor', 'agents', 'history', 'logs'].forEach((id) => {
      const pane = document.getElementById(`rp-${id}`);
      const nav = document.getElementById(`rpt-${id}`);
      if (pane) pane.style.display = 'none';
      if (nav) nav.classList.remove('active');
    });
    const pane = document.getElementById(`rp-${tab}`);
    const nav = document.getElementById(`rpt-${tab}`);
    if (pane) pane.style.display = 'flex';
    if (nav) nav.classList.add('active');
    if (tab === 'history') ctx.loadVersionFiles();
    if (tab === 'agents') ctx.loadAgents();
  }

  async function loadWorkspacePulse(ctx) {
    const host = document.getElementById('workspace-pulse');
    if (!host) return;
    const health = await ctx.api('GET', '/api/health').catch(() => null);
    if (!health || !window.clsClawModules?.renderWorkspacePulse) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = window.clsClawModules.renderWorkspacePulse(health);
  }

  function applyQuickTemplate(ctx, templateId) {
    const template = window.clsClawModules?.resolveTemplate
      ? window.clsClawModules.resolveTemplate(templateId)
      : window.clsClawModules?.workflowTemplates?.[templateId];
    if (!template) return;
    ctx.setView('chat');
    ctx.setChatMode(template.mode || ctx.getChatMode());
    ctx.setExecutionProfile(template.profile || ctx.getExecutionProfile());
    const prompt = document.getElementById('prompt');
    if (!prompt) return;
    prompt.value = template.text || '';
    prompt.focus();
    ctx.autoResize(prompt);
  }

  window.clsClawMissionControl = {
    renderMissionControl,
    updateMissionControl,
    hydrateMissionFromTurn,
    loadMissionControl,
    loadPrivacySummary,
    setView,
    setRpTab,
    loadWorkspacePulse,
    applyQuickTemplate,
  };
})();
