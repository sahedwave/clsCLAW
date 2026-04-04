(function () {
  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function shortPath(value) {
    if (!value) return '';
    const parts = String(value).split('/');
    return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : String(value);
  }

  const workflowTemplates = {
    review: {
      label: '/review',
      title: 'Findings-first review',
      detail: 'Summarize risk, anchor exact files, and call out what still needs proof.',
      mode: 'ask',
      profile: 'deliberate',
      text: '/review Review my current workspace changes with findings first, anchor the riskiest files, and tell me what still needs verification.',
    },
    fix: {
      label: '/fix',
      title: 'Inspect then fix',
      detail: 'Read the relevant files, explain the bug, patch it, and verify the result.',
      mode: 'build',
      profile: 'execute',
      text: '/fix Inspect the relevant files, explain the root cause, apply the smallest safe fix, and verify the result.',
    },
    verify: {
      label: '/verify',
      title: 'Evidence-backed verification',
      detail: 'Check changes, tests, and uncertainty before calling work done.',
      mode: 'ask',
      profile: 'deliberate',
      text: '/verify Verify the latest changes, summarize what is confirmed, what failed, and what remains uncertain.',
    },
    debugUi: {
      label: '/debug-ui',
      title: 'Visual debug flow',
      detail: 'Use screenshots, files, and docs together to reason about UI issues.',
      mode: 'build',
      profile: 'parallel',
      text: '/debug-ui Use the attached screenshot plus relevant files and docs to diagnose the UI issue, propose the fix, and verify it.',
    },
    brief: {
      label: '/brief',
      title: 'Project briefing',
      detail: 'Get a concise state-of-project briefing with next actions and risk hotspots.',
      mode: 'ask',
      profile: 'quick',
      text: '/brief Give me a concise project briefing with current risk hotspots, recent progress, and the highest-value next action.',
    },
    swarm: {
      label: '/swarm',
      title: 'Parallel specialist plan',
      detail: 'Break a larger task into bounded specialists and merge their outputs safely.',
      mode: 'build',
      profile: 'parallel',
      text: '/swarm Break this task into a bounded swarm plan, explain the specialist roles, then execute only if the plan looks safe and coherent.',
    },
  };

  const engineeringTemplates = {
    matlabReview: {
      label: 'MATLAB review',
      title: 'Inspect a MATLAB solver',
      detail: 'Map the script flow, numerical assumptions, and the most likely instability or unit mistakes.',
      mode: 'ask',
      profile: 'deliberate',
      text: 'Inspect this MATLAB project like an engineering reviewer. Explain the solver flow, key inputs/outputs, numerical assumptions, likely instability or unit risks, and the highest-value next fix.',
    },
    simVerify: {
      label: 'Simulation verify',
      title: 'Verify simulation outputs',
      detail: 'Check logs, data files, and code paths before trusting a plot, table, or result.',
      mode: 'ask',
      profile: 'parallel',
      text: 'Verify this engineering simulation result. Inspect the relevant code, logs, and output files, summarize what is confirmed, what is suspicious, and what should be checked next before trusting the result.',
    },
    translateModel: {
      label: 'MATLAB -> Python',
      title: 'Translate technical code',
      detail: 'Convert MATLAB to Python or another stack without losing formulas, units, or vectorization intent.',
      mode: 'build',
      profile: 'execute',
      text: 'Translate the relevant MATLAB function or script into clean Python/NumPy, preserve the numerical logic, call out any unit or indexing differences, and propose a verification strategy against the original output.',
    },
    labDebug: {
      label: 'Debug plot or UI',
      title: 'Use screenshots and code together',
      detail: 'Great for broken plots, dashboards, GUIs, and engineering front ends with visual symptoms.',
      mode: 'build',
      profile: 'parallel',
      text: '/debug-ui Use the attached screenshot plus the relevant engineering code and outputs to diagnose the visible issue, explain the root cause, propose the smallest safe fix, and verify it.',
    },
    reportBrief: {
      label: 'Research brief',
      title: 'Summarize project state',
      detail: 'Turn code, outputs, and notes into a compact briefing for teammates, lab reports, or supervisors.',
      mode: 'ask',
      profile: 'quick',
      text: 'Give me a concise engineering project briefing: what this codebase does, the current state of the work, the biggest risk to result quality, and the next best action for a student engineering team.',
    },
  };

  const referenceTemplates = {
    file: {
      label: '@file',
      detail: 'Reference a file or folder directly in your prompt.',
      text: '@file /absolute/path/to/file.js ',
    },
    review: {
      label: '@review',
      detail: 'Point at a pending review or approval artifact.',
      text: '@review review-id ',
    },
    artifact: {
      label: '@artifact',
      detail: 'Pull a saved report, briefing, or turn artifact into the task.',
      text: '@artifact artifact-id ',
    },
    turn: {
      label: '@turn',
      detail: 'Point at a recent turn, trace, or closeout for follow-up work.',
      text: '@turn turn-id ',
    },
  };

  function renderOnboardingPanel({
    projectRoot = '',
    authState = {},
    providerStatus = {},
    dismissed = false,
  } = {}) {
    if (dismissed) return '';
    const steps = [
      {
        label: 'Authenticate',
        done: !!authState.authenticated,
        detail: authState.authenticated
          ? `Signed in as ${authState.user?.displayName || authState.user?.username || 'user'}.`
          : 'Create the first local admin account or sign in to unlock the workspace.',
        action: authState.authenticated ? '' : 'openAuthModal(true)',
        cta: authState.authenticated ? '' : 'sign in',
      },
      {
        label: 'Pick workspace',
        done: !!projectRoot,
        detail: projectRoot ? `Current root: ${shortPath(projectRoot)}` : 'Choose the project folder this workspace should operate on.',
        action: projectRoot ? '' : 'openSettings()',
        cta: projectRoot ? '' : 'set root',
      },
      {
        label: 'Configure provider',
        done: !!providerStatus.llmConfigured,
        detail: providerStatus.llmConfigured
          ? 'A model provider is ready for chat, planning, and agents.'
          : 'Add Anthropic, OpenAI, or Ollama so clsClaw can reason and execute.',
        action: providerStatus.llmConfigured ? '' : 'openSettings()',
        cta: providerStatus.llmConfigured ? '' : 'add provider',
      },
      {
        label: 'Try a workflow',
        done: false,
        detail: 'Start with /review, /fix, /verify, or /debug-ui to learn the app through real work.',
        action: "applyQuickTemplate('review')",
        cta: 'start',
      },
    ];
    const completed = steps.filter((step) => step.done).length;
    return `
      <div class="discover-panel" style="max-width:920px">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">First Run</div>
            <div class="discover-summary">Set up the essentials once, then let the workspace carry the rest.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="discover-label">${completed}/${steps.length} ready</span>
            <button class="mission-btn" onclick="dismissOnboarding()">dismiss</button>
          </div>
        </div>
        <div class="hero-stats-grid">
          ${steps.map((step) => `
            <div class="hero-stat-card" style="border-color:${step.done ? 'rgba(52,211,153,0.22)' : 'var(--border)'}">
              <div class="hero-stat-label">${esc(step.label)}</div>
              <div class="hero-stat-value" style="display:flex;align-items:center;gap:8px">
                <span>${step.done ? 'done' : 'next'}</span>
              </div>
              <div class="hero-stat-detail">${esc(step.detail)}</div>
              ${step.action ? `<div style="margin-top:6px"><button class="hero-action" onclick="${step.action}">${esc(step.cta)}</button></div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderHomeShell({
    missionState = {},
    executionProfile = 'deliberate',
    chatMode = 'ask',
    projectRoot = '',
    authState = {},
    providerStatus = {},
    workspaceSignals = {},
  } = {}) {
    const stats = [
      {
        label: 'Mode hint',
        value: chatMode,
        detail: chatMode === 'build' ? 'A build-leaning composer hint. The backend still decides the real lane per turn.' : 'An ask-leaning composer hint. The backend still decides the real lane per turn.',
      },
      {
        label: 'Profile',
        value: executionProfile,
        detail: 'Execution pacing and autonomy budget for this workspace.',
      },
      {
        label: 'Providers',
        value: providerStatus.llmConfigured ? 'ready' : 'setup needed',
        detail: providerStatus.llmConfigured ? 'At least one model provider is configured.' : 'Connect a model provider to unlock chat and agents.',
      },
      {
        label: 'Workspace',
        value: projectRoot ? shortPath(projectRoot) : 'not set',
        detail: authState.authenticated ? `Signed in as ${authState.user?.displayName || authState.user?.username || 'user'}.` : 'Authenticate to unlock the local workspace.',
      },
    ];
    const ecosystem = workspaceSignals.ecosystem || {};
    const collaboration = workspaceSignals.collaboration || {};
    const remote = workspaceSignals.remote || {};
    if (ecosystem.total !== undefined) {
      stats.push({
        label: 'Ecosystem',
        value: `${ecosystem.ready ?? 0}/${ecosystem.total} ready`,
        detail: `${ecosystem.custom ?? 0} custom · ${ecosystem.categories ?? 0} categories · ${ecosystem.needsAuth ?? 0} auth-gated`,
      });
    }
    if (collaboration.recentCount !== undefined) {
      stats.push({
        label: 'Collaboration',
        value: `${collaboration.activeActors ?? 0} active`,
        detail: `${collaboration.recentCount ?? 0} recent events · ${collaboration.latestKind || 'no recent activity'}`,
      });
    }
    if (remote.targets !== undefined) {
      stats.push({
        label: 'Remote',
        value: remote.publicUrl ? 'reachable' : (remote.tunnelStatus || 'idle'),
        detail: `${remote.enabledTargets ?? 0}/${remote.targets ?? 0} delegation targets enabled · ${remote.publicUrl ? 'public URL ready' : 'local-only right now'}`,
      });
    }
    const heroActions = [
      { label: 'Review workspace', template: 'review' },
      { label: 'Inspect MATLAB solver', template: 'matlabReview' },
      { label: 'Verify simulation', template: 'simVerify' },
      { label: 'Translate technical code', template: 'translateModel' },
    ];
    return `
      <div class="hero-shell">
        <div class="hero-banner">
          <div class="hero-copy">
            <div class="hero-kicker">Local-first engineering cockpit</div>
            <div class="hero-title">Inspect, simulate, review, and verify from one workspace.</div>
            <div class="hero-text">${esc(missionState.summary || 'Built for engineering codebases where MATLAB, Python, simulation outputs, plots, and technical reasoning all have to line up before you trust the result.')}</div>
            <div class="hero-actions">
              ${heroActions.map((item) => `<button class="hero-action" onclick="applyQuickTemplate('${item.template}')">${esc(item.label)}</button>`).join('')}
            </div>
          </div>
          <div class="hero-focus-card">
            <div class="hero-focus-label">Current focus</div>
            <div class="hero-focus-value">${esc(missionState.phase || 'idle')}</div>
            <div class="hero-focus-detail">${esc(missionState.nextAction || 'wait')} · ${esc(missionState.evidenceStatus || 'pending evidence')}</div>
          </div>
        </div>
        <div class="hero-stats-grid">
          ${stats.map((item) => `
            <div class="hero-stat-card">
              <div class="hero-stat-label">${esc(item.label)}</div>
              <div class="hero-stat-value">${esc(item.value)}</div>
              <div class="hero-stat-detail">${esc(item.detail)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderMissionControlChips({ missionState = {}, executionProfile = 'deliberate' } = {}) {
    const profile = missionState.profile || executionProfile || 'deliberate';
    const phase = missionState.phase || 'idle';
    const chips = [];
    chips.push(`<span class="mission-chip profile">profile: ${esc(profile)}</span>`);
    chips.push(`<span class="mission-chip phase">phase: ${esc(phase)}</span>`);
    if (missionState.evidenceStatus) {
      const isGood = missionState.evidenceStatus === 'strong' || missionState.evidenceStatus === 'grounded';
      chips.push(`<span class="mission-chip ${isGood ? 'good' : ''}">evidence: ${esc(missionState.evidenceStatus)}</span>`);
    }
    if (missionState.approvalRequired) {
      chips.push('<span class="mission-chip approval">approval required</span>');
    }
    if (missionState.nextAction && missionState.nextAction !== 'wait') {
      chips.push(`<span class="mission-chip">next: ${esc(String(missionState.nextAction).slice(0, 48))}</span>`);
    }
    if (missionState.evidenceSummary) {
      chips.push(`<span class="mission-chip">${esc(String(missionState.evidenceSummary).slice(0, 72))}</span>`);
    }
    if (missionState.privacySummary) {
      chips.push(`<span class="mission-chip">${esc(String(missionState.privacySummary).slice(0, 68))}</span>`);
    }
    return chips.join('');
  }

  function renderMissionControlPanel({ missionState = {}, executionProfile = 'deliberate' } = {}) {
    const profile = missionState.profile || executionProfile || 'deliberate';
    const phase = missionState.phase || 'idle';
    const cards = [
      {
        label: 'Execution',
        value: `${profile} · ${phase}`,
        detail: missionState.subtext || 'No active turn',
      },
      {
        label: 'Evidence',
        value: missionState.evidenceStatus || 'pending',
        detail: missionState.evidenceSummary || 'Evidence will appear here after inspection and tool use.',
      },
      {
        label: 'Next',
        value: missionState.nextAction || 'wait',
        detail: missionState.approvalRequired ? 'Approval is blocking the next write step.' : 'No approval gate is blocking the current turn.',
      },
      {
        label: 'Privacy',
        value: missionState.privacySummary ? missionState.privacySummary.replace(/^privacy=/, '') : 'storage=local',
        detail: missionState.turnId ? `tracking turn ${String(missionState.turnId).slice(0, 8)}` : 'No active turn yet.',
      },
    ];
    const compactCards = cards.filter((card) => {
      if (phase === 'idle' && !missionState.turnId) {
        return card.label === 'Execution' || card.label === 'Evidence' || card.label === 'Privacy';
      }
      return true;
    });
    return `
      <div class="mission-mini-grid">
        ${compactCards.map((card) => `
          <div class="mission-mini-card">
            <div class="mission-mini-label">${esc(card.label)}</div>
            <div class="mission-mini-value">${esc(card.value)}</div>
            <div class="mission-mini-detail">${esc(card.detail).slice(0, 120)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderArtifactMetadataRows(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return '';
    const rows = [];
    const pushRow = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      rows.push(`
        <div style="display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:4px 0">
          <span style="color:var(--muted)">${esc(label)}</span>
          <span style="font-family:var(--mono);font-size:10px;text-align:right">${esc(formatArtifactValue(value))}</span>
        </div>
      `);
    };
    pushRow('Intent', metadata.intent);
    pushRow('Mode', metadata.mode);
    pushRow('Profile', metadata.profile);
    pushRow('Verification', metadata.verificationStatus);
    pushRow('Evidence', metadata.evidenceStatus);
    pushRow('Approval required', metadata.approvalRequired ? 'yes' : '');
    pushRow('Created by', metadata.createdBy);
    pushRow('Updated by', metadata.updatedBy);
    pushRow('Project root', metadata.projectRoot ? shortPath(metadata.projectRoot) : '');
    return rows.length ? `
      <div style="margin-top:10px">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint);margin-bottom:4px">Metadata</div>
        ${rows.join('')}
      </div>
    ` : '';
  }

  function renderArtifactParsedContent(artifact = {}) {
    const raw = String(artifact.content || '');
    if (!raw.trim()) {
      return `<div style="font-size:11px;color:var(--muted)">No artifact content saved.</div>`;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
      const detailRows = [];
      const pushDetail = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        detailRows.push(`
          <div style="display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:4px 0">
            <span style="color:var(--muted)">${esc(label)}</span>
            <span style="text-align:right">${esc(formatArtifactValue(value))}</span>
          </div>
        `);
      };
      pushDetail('User request', String(parsed.userText || '').slice(0, 180));
      pushDetail('Verification', parsed.verification?.status || '');
      pushDetail('Evidence items', Array.isArray(parsed.evidence) ? parsed.evidence.length : 0);
      pushDetail('Tool steps', Array.isArray(parsed.steps) ? parsed.steps.length : 0);
      pushDetail('Phase', parsed.plan?.phase || '');
      pushDetail('Next action', parsed.plan?.nextAction || '');
      return `
        ${detailRows.length ? `
          <div style="margin-top:10px">
            <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint);margin-bottom:4px">Parsed summary</div>
            ${detailRows.join('')}
          </div>
        ` : ''}
        ${parsed.finalAnswer ? `
          <div style="margin-top:10px">
            <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint);margin-bottom:4px">Final answer</div>
            <div style="font-size:11px;line-height:1.6;white-space:pre-wrap">${esc(String(parsed.finalAnswer))}</div>
          </div>
        ` : ''}
        <details style="margin-top:10px">
          <summary style="cursor:pointer;color:var(--muted)">Raw artifact JSON</summary>
          <pre style="margin-top:8px;white-space:pre-wrap;font-family:var(--mono);font-size:11px;color:var(--text)">${esc(JSON.stringify(parsed, null, 2))}</pre>
        </details>
      `;
    } catch {
      return `<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11px;color:var(--text)">${esc(raw)}</pre>`;
    }
  }

  function renderWelcomePanel() {
    return '';
  }

  function renderEngineeringShowcase({ presenterMode = false } = {}) {
    return '';
  }

  function resolveTemplate(templateId) {
    return workflowTemplates[templateId] || engineeringTemplates[templateId] || null;
  }

  function formatArtifactValue(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return String(value);
  }

  function renderComposerGuide({ mode = 'ask', profile = 'deliberate' } = {}) {
    const visibleWorkflowIds = ['review', 'fix', 'verify', 'brief'];
    const workflowChips = visibleWorkflowIds.map((id) => {
      const item = workflowTemplates[id];
      if (!item) return '';
      const active = item.mode === mode || item.profile === profile;
      return `<button class="composer-chip ${active ? 'active' : ''}" onclick="applyQuickTemplate('${id}')">${esc(item.label)}</button>`;
    }).join('');
    const referenceChips = Object.entries(referenceTemplates).map(([id, item]) => `
      <button class="composer-chip subtle" onclick="insertReferenceTemplate('${id}')">${esc(item.label)}</button>
    `).join('');
    return `
      <div class="composer-guide">
        <div class="composer-row">
          <span class="composer-label">quick actions</span>
          <div class="composer-chips">${workflowChips}</div>
        </div>
        <div class="composer-row">
          <span class="composer-label">insert refs</span>
          <div class="composer-chips">${referenceChips}</div>
        </div>
        <div class="composer-caption">Usually you can just type the request. Open this drawer only when you want to force a workflow or insert a reference token.</div>
      </div>
    `;
  }

  function renderWorkspacePulse(health = {}) {
    const items = [
      {
        label: 'pending changes',
        value: health.approvalQueue?.pending ?? 0,
        tone: (health.approvalQueue?.pending ?? 0) > 0 ? 'var(--amber)' : 'var(--green)',
        action: "setView('changes')",
      },
      {
        label: 'pending reviews',
        value: health.approvalQueue?.reviews ?? 0,
        tone: (health.approvalQueue?.reviews ?? 0) > 0 ? 'var(--blue)' : 'var(--muted)',
        action: "setView('changes')",
      },
      {
        label: 'running agents',
        value: health.agentsRunning ?? health.agents?.running ?? 0,
        tone: (health.agentsRunning ?? health.agents?.running ?? 0) > 0 ? 'var(--accent2)' : 'var(--muted)',
        action: "setView('agents')",
      },
      {
        label: 'heartbeat jobs',
        value: health.automations?.jobs ?? 0,
        tone: (health.automations?.jobs ?? 0) > 0 ? 'var(--green)' : 'var(--muted)',
        action: "setView('auto')",
      },
    ];
    return `
      <div class="discover-panel">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Workspace Pulse</div>
            <div class="discover-summary">A fast read of what needs attention before you dive into the next task.</div>
          </div>
          <button class="mission-btn" onclick="loadWorkspacePulse()">refresh</button>
        </div>
        <div class="discover-grid">
          ${items.map((item) => `
            <button class="discover-card" onclick="${item.action}">
              <div class="discover-top">
                <span class="discover-label">${esc(item.label)}</span>
              </div>
              <div class="discover-title" style="color:${item.tone}">${esc(item.value)}</div>
              <div class="discover-detail">Open ${esc(item.label)} and inspect the live queue.</div>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  window.clsClawModules = {
    workflowTemplates,
    engineeringTemplates,
    resolveTemplate,
    referenceTemplates,
    renderHomeShell,
    renderOnboardingPanel,
    renderMissionControlChips,
    renderMissionControlPanel,
    renderArtifactMetadataRows,
    renderArtifactParsedContent,
    renderWelcomePanel,
    renderEngineeringShowcase,
    renderComposerGuide,
    renderWorkspacePulse,
  };
})();
