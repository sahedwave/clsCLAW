(function () {
  async function loadAuthStatus(ctx) {
    const state = await fetch('/api/auth/status')
      .then((response) => response.json())
      .catch(() => ({ configured: false, authenticated: false, bootstrapRequired: true, user: null }));
    ctx.setAuthState({
      configured: !!state.configured,
      authenticated: !!state.authenticated,
      bootstrapRequired: !!state.bootstrapRequired,
      user: state.user || null,
      session: state.session || null,
    });
    updateAuthChrome(ctx);
    return ctx.getAuthState();
  }

  function updateAuthChrome(ctx) {
    const badge = document.getElementById('auth-badge');
    if (!badge) return;
    const authState = ctx.getAuthState();
    if (!authState.configured) {
      badge.textContent = 'auth: bootstrap';
      return;
    }
    if (!authState.authenticated) {
      badge.textContent = 'auth: sign in';
      return;
    }
    const role = authState.user?.role ? ` · ${authState.user.role}` : '';
    badge.textContent = `${authState.user?.username || 'user'}${role}`;
  }

  function openAuthModal(ctx, allowClose = false) {
    const modal = document.getElementById('modal-auth');
    if (!modal) return;
    const authState = ctx.getAuthState();
    const bootstrap = !!authState.bootstrapRequired;
    document.getElementById('auth-title').textContent = bootstrap ? 'Create local admin account' : 'Sign in';
    document.getElementById('auth-copy').textContent = bootstrap
      ? 'Set the first local admin account for this clsClaw workspace.'
      : 'Authenticate to unlock the local clsClaw workspace.';
    document.getElementById('auth-display-label').style.display = bootstrap ? 'block' : 'none';
    document.getElementById('auth-display-name').style.display = bootstrap ? 'block' : 'none';
    document.getElementById('auth-cancel-btn').style.display = allowClose ? 'inline-flex' : 'none';
    modal.style.display = 'flex';
  }

  async function submitAuth(ctx) {
    const authState = ctx.getAuthState();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const displayName = document.getElementById('auth-display-name').value.trim();
    const endpoint = authState.bootstrapRequired ? '/api/auth/bootstrap' : '/api/auth/login';
    const payload = authState.bootstrapRequired ? { username, password, displayName } : { username, password };
    const result = await ctx.api('POST', endpoint, payload).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result) return;
    document.getElementById('auth-username').value = '';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-display-name').value = '';
    ctx.setAuthState({
      configured: true,
      authenticated: true,
      bootstrapRequired: false,
      user: result.user || null,
      session: result.session || null,
    });
    updateAuthChrome(ctx);
    ctx.closeModal('modal-auth');
    await ctx.init(true);
  }

  async function logoutAuth(ctx) {
    await ctx.api('POST', '/api/auth/logout', {}).catch(() => null);
    ctx.setAuthState({
      configured: true,
      authenticated: false,
      bootstrapRequired: false,
      user: null,
      session: null,
    });
    updateAuthChrome(ctx);
    openAuthModal(ctx, false);
  }

  async function loadAuthUsers(ctx) {
    const summary = document.getElementById('auth-settings-summary');
    const list = document.getElementById('auth-users-list');
    const sessionsHost = document.getElementById('auth-sessions-list');
    const activityHost = document.getElementById('auth-activity-list');
    const addUserBtn = document.getElementById('auth-add-user-btn');
    if (!summary || !list) return;
    const authState = ctx.getAuthState();
    const role = authState.user?.role || 'viewer';
    if (!authState.authenticated) {
      summary.textContent = 'You are not signed in.';
      list.innerHTML = '';
      if (sessionsHost) sessionsHost.innerHTML = '';
      if (activityHost) activityHost.innerHTML = '';
      if (addUserBtn) addUserBtn.style.display = 'none';
      return;
    }
    summary.textContent = `Signed in as ${authState.user?.displayName || authState.user?.username || 'user'} (${role}).`;
    if (addUserBtn) addUserBtn.style.display = role === 'admin' ? 'inline-flex' : 'none';
    if (role !== 'admin') {
      list.innerHTML = `<div style="font-size:11px;color:var(--muted)">Only admins can create or list local users.</div>`;
      if (sessionsHost) sessionsHost.innerHTML = '';
      if (activityHost) activityHost.innerHTML = '';
      return;
    }
    const users = await ctx.api('GET', '/api/auth/users').catch(() => []);
    const sessions = await ctx.api('GET', '/api/auth/sessions').catch(() => []);
    const activity = await ctx.api('GET', '/api/collab/activity?limit=6').catch(() => []);
    const usersById = new Map((users || []).map((user) => [user.id, user]));
    list.innerHTML = (users || []).map((user) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--bg2);display:flex;align-items:center;gap:8px">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:700">${ctx.esc(user.displayName || user.username)}</div>
          <div style="font-size:10px;font-family:var(--mono);color:var(--muted)">${ctx.esc(user.username)} · ${ctx.esc(user.role || 'member')}</div>
        </div>
        <span class="review-anchor exact">${ctx.esc(user.disabled ? 'disabled' : 'active')}</span>
        ${authState.user?.id !== user.id ? `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="toggleAuthUser('${user.id}', ${user.disabled ? 'false' : 'true'})">${user.disabled ? 'enable' : 'disable'}</button>` : ''}
      </div>
    `).join('') || `<div style="font-size:11px;color:var(--muted)">No local users yet.</div>`;
    if (sessionsHost) {
      sessionsHost.innerHTML = `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint)">Active sessions</div>${
        (sessions || []).length
          ? sessions.map((session) => `
              <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--bg3);display:flex;flex-direction:column;gap:4px">
                <div style="display:flex;gap:8px;align-items:center">
                  <div style="font-size:11px;color:var(--text);font-weight:700;flex:1">${ctx.esc(session.label || usersById.get(session.userId)?.displayName || usersById.get(session.userId)?.username || session.userId)}</div>
                  <span class="review-anchor ${session.presence === 'active' ? 'exact' : 'shifted'}">${ctx.esc(session.presence || ctx.timeAgo(session.lastSeenAt || session.createdAt))}</span>
                </div>
                <div style="font-size:10px;font-family:var(--mono);color:var(--muted)">${ctx.esc(usersById.get(session.userId)?.displayName || usersById.get(session.userId)?.username || session.userId)} · session ${ctx.esc(String(session.id || '').slice(0, 8))}${session.current ? ' · current' : ''}</div>
                <div style="font-size:10px;color:var(--muted)">${ctx.esc(session.device || 'unknown device')} · last seen ${ctx.esc(ctx.timeAgo(session.lastSeenAt || session.createdAt))} · expires ${ctx.esc(ctx.timeAgo(session.expiresAt || session.lastSeenAt || session.createdAt))}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="renameAuthSession('${session.id}')">rename</button>
                  ${session.current ? '' : `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="revokeAuthSession('${session.id}')">revoke</button>`}
                </div>
              </div>
            `).join('')
          : `<div style="font-size:11px;color:var(--muted)">No active sessions.</div>`
      }`;
    }
    if (activityHost) {
      activityHost.innerHTML = `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint)">Recent collaboration activity</div>${
        (activity || []).length
          ? activity.map((item) => `
              <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--bg3);display:flex;flex-direction:column;gap:4px">
                <div style="display:flex;gap:8px;align-items:center">
                  <div style="font-size:11px;color:var(--text);font-weight:700;flex:1">${ctx.esc(item.title || item.kind || 'activity')}</div>
                  <span class="review-anchor ${item.status === 'error' || item.status === 'rejected' ? 'shifted' : 'exact'}">${ctx.esc(item.status || 'recorded')}</span>
                </div>
                <div style="font-size:10px;font-family:var(--mono);color:var(--muted)">${ctx.esc(item.actor?.username || 'system')} · ${ctx.esc(item.kind || 'event')} · ${ctx.esc(ctx.timeAgo(item.createdAt || item.updatedAt || Date.now()))}</div>
              </div>
            `).join('')
          : `<div style="font-size:11px;color:var(--muted)">No recent activity yet.</div>`
      }`;
    }
  }

  async function toggleAuthUser(ctx, id, disabled) {
    const result = await ctx.api('PATCH', `/api/auth/users/${id}`, { disabled }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast(`✓ User ${disabled ? 'disabled' : 'enabled'}`, 'ok');
    loadAuthUsers(ctx);
  }

  async function createAuthUser(ctx) {
    const authState = ctx.getAuthState();
    if (authState.user?.role !== 'admin') {
      ctx.toast('Admin access required', 'err');
      return;
    }
    const username = prompt('New username');
    if (username === null) return;
    const password = prompt('Temporary password (min 8 characters)');
    if (password === null) return;
    const displayName = prompt('Display name (optional)') ?? '';
    const role = prompt('Role: admin, member, or viewer', 'member');
    const result = await ctx.api('POST', '/api/auth/users', { username, password, displayName, role }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast(`✓ Added user ${result.user.username}`, 'ok');
    loadAuthUsers(ctx);
  }

  async function renameAuthSession(ctx, id) {
    const label = prompt('Session label');
    if (label === null) return;
    const result = await ctx.api('PATCH', `/api/auth/sessions/${id}`, { label }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Session updated', 'ok');
    loadAuthUsers(ctx);
  }

  async function revokeAuthSession(ctx, id) {
    const result = await ctx.api('DELETE', `/api/auth/sessions/${id}`).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result?.ok) return;
    ctx.toast('✓ Session revoked', 'ok');
    loadAuthUsers(ctx);
  }

  async function openSettings(ctx) {
    document.getElementById('cfg-root').value = ctx.getProjectRoot();
    await loadAuthUsers(ctx);
    document.getElementById('modal-settings').style.display = 'flex';
  }

  async function saveSettings(ctx) {
    const root = document.getElementById('cfg-root').value.trim();
    const githubToken = document.getElementById('gh-tok').value.trim();
    const anthropicKey = document.getElementById('cfg-anthropic').value.trim();
    const openaiKey = document.getElementById('cfg-openai').value.trim();
    const ollamaUrl = document.getElementById('cfg-ollama-url').value.trim();
    const ollamaModel = document.getElementById('cfg-ollama-model').value.trim();
    const ollamaEmbeddingModel = document.getElementById('cfg-ollama-embedding-model').value.trim();
    const embeddingProvider = document.getElementById('cfg-embedding-provider').value;
    const slackWebhookUrl = document.getElementById('cfg-slack-webhook').value.trim();
    const githubWebhookSecret = document.getElementById('cfg-github-webhook-secret').value.trim();
    const sandboxProvider = document.getElementById('cfg-sandbox-provider').value;
    const payload = {
      root,
      token: githubToken,
      ollamaUrl,
      ollamaModel,
      ollamaEmbeddingModel,
      embeddingProvider,
      sandboxProvider,
    };
    if (!ctx.isMaskedSecret(anthropicKey)) payload.anthropicKey = anthropicKey;
    if (!ctx.isMaskedSecret(openaiKey)) payload.openaiKey = openaiKey;
    if (!ctx.isMaskedSecret(slackWebhookUrl)) payload.slackWebhookUrl = slackWebhookUrl;
    if (!ctx.isMaskedSecret(githubWebhookSecret)) payload.githubWebhookSecret = githubWebhookSecret;
    const result = await ctx.api('POST', '/api/config', payload).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (result?.ok) {
      ctx.afterSettingsSave({ root, githubToken, providers: result.providers || null });
      await ctx.loadFiles();
    }
    ctx.closeModal('modal-settings');
    ctx.toast('✓ Settings saved', 'ok');
    ctx.updateApiKeyWarning();
    await ctx.refreshHealthPill();
  }

  window.clsClawSettingsView = {
    loadAuthStatus,
    updateAuthChrome,
    openAuthModal,
    submitAuth,
    logoutAuth,
    loadAuthUsers,
    toggleAuthUser,
    createAuthUser,
    renameAuthSession,
    revokeAuthSession,
    openSettings,
    saveSettings,
  };
})();
