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
  };

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
    const items = Object.entries(workflowTemplates).map(([id, item]) => `
      <button class="discover-card" onclick="applyQuickTemplate('${id}')">
        <div class="discover-top">
          <span class="discover-label">${esc(item.label)}</span>
          <span class="discover-profile">${esc(item.profile)}</span>
        </div>
        <div class="discover-title">${esc(item.title)}</div>
        <div class="discover-detail">${esc(item.detail)}</div>
      </button>
    `).join('');
    return `
      <div class="discover-panel">
        <div class="discover-heading">
          <div>
            <div class="discover-kicker">Operator Flows</div>
            <div class="discover-summary">Use a guided workflow when you already know the shape of the task.</div>
          </div>
        </div>
        <div class="discover-grid">${items}</div>
      </div>
    `;
  }

  function formatArtifactValue(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return String(value);
  }

  function renderComposerGuide({ mode = 'ask', profile = 'deliberate' } = {}) {
    const workflowChips = Object.entries(workflowTemplates).map(([id, item]) => {
      const active = item.mode === mode || item.profile === profile;
      return `<button class="composer-chip ${active ? 'active' : ''}" onclick="applyQuickTemplate('${id}')">${esc(item.label)}</button>`;
    }).join('');
    const referenceChips = Object.entries(referenceTemplates).map(([id, item]) => `
      <button class="composer-chip subtle" onclick="insertReferenceTemplate('${id}')">${esc(item.label)}</button>
    `).join('');
    return `
      <div class="composer-guide">
        <div class="composer-row">
          <span class="composer-label">flows</span>
          <div class="composer-chips">${workflowChips}</div>
        </div>
        <div class="composer-row">
          <span class="composer-label">references</span>
          <div class="composer-chips">${referenceChips}</div>
        </div>
        <div class="composer-caption">Current mode: ${esc(mode)} · profile: ${esc(profile)} · click a flow to seed the prompt with inspect-first guidance.</div>
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
    referenceTemplates,
    renderMissionControlChips,
    renderArtifactMetadataRows,
    renderArtifactParsedContent,
    renderWelcomePanel,
    renderComposerGuide,
    renderWorkspacePulse,
  };
})();
