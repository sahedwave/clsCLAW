(function () {
  function ghBody(ctx, extra = {}) {
    return { token: document.getElementById('gh-tok').value.trim(), ...extra };
  }

  async function ghConnect(ctx) {
    const result = await ctx.api('POST', '/api/github/user', ghBody(ctx)).catch((err) => {
      ctx.showGhOut('gh-user-out', err.message, true);
      return null;
    });
    if (result) {
      ctx.setGhToken(ghBody(ctx).token);
      ctx.showGhOut('gh-user-out', `✓ Connected as @${result.login} (${result.public_repos} repos)`);
    }
  }

  async function ghClone(ctx) {
    const repoUrl = document.getElementById('gh-clone-url').value.trim();
    const result = await ctx.api('POST', '/api/github/clone', { ...ghBody(ctx), url: repoUrl }).catch((err) => {
      ctx.showGhOut('gh-clone-out', err.message, true);
      return null;
    });
    if (result) {
      ctx.showGhOut('gh-clone-out', result.ok ? '✓ Cloned successfully' : result.error, !result.ok);
      if (result.ok) ctx.loadFiles();
    }
  }

  async function ghStatus(ctx) {
    const result = await ctx.api('POST', '/api/github/status', ghBody(ctx)).catch((err) => {
      ctx.showGhOut('gh-status-out', err.message, true);
      return null;
    });
    if (result) ctx.showGhOut('gh-status-out', result.ok ? `Branch: ${result.branch}\n\n${result.status || '(clean)'}\n\n${result.log}` : result.error, !result.ok);
  }

  async function ghPush(ctx) {
    const message = document.getElementById('gh-commit-msg').value.trim();
    const branch = document.getElementById('gh-push-branch').value.trim();
    if (!message) {
      ctx.toast('Commit message required', 'err');
      return;
    }
    const result = await ctx.api('POST', '/api/github/push', { ...ghBody(ctx), message, branch }).catch((err) => {
      ctx.showGhOut('gh-push-out', err.message, true);
      return null;
    });
    if (result) ctx.showGhOut('gh-push-out', result.ok ? `✓ ${result.commit}\n${result.push}` : result.error, !result.ok);
  }

  async function ghCreatePR(ctx) {
    const owner = document.getElementById('gh-owner').value.trim();
    const repo = document.getElementById('gh-repo').value.trim();
    const title = document.getElementById('gh-pr-title').value.trim();
    const body = document.getElementById('gh-pr-body').value.trim();
    const head = document.getElementById('gh-pr-head').value.trim();
    if (!owner || !repo || !title) {
      ctx.toast('Owner, repo, title required', 'err');
      return;
    }
    const result = await ctx.api('POST', '/api/github/pr/create', { ...ghBody(ctx), owner, repo, title, body, head }).catch((err) => {
      ctx.showGhOut('gh-pr-out', err.message, true);
      return null;
    });
    if (result?.html_url) {
      ctx.showGhOut('gh-pr-out', `✓ PR created: ${result.html_url}`);
      ctx.toast('✓ PR created!', 'ok');
    } else if (result) {
      ctx.showGhOut('gh-pr-out', result.message || JSON.stringify(result), true);
    }
  }

  async function ghListPRs(ctx) {
    const owner = document.getElementById('gh-owner').value.trim();
    const repo = document.getElementById('gh-repo').value.trim();
    if (!owner || !repo) {
      ctx.toast('Owner and repo required', 'err');
      return;
    }
    const prs = await ctx.api('POST', '/api/github/pr/list', { ...ghBody(ctx), owner, repo }).catch((err) => {
      ctx.toast(err.message, 'err');
      return [];
    });
    const el = document.getElementById('gh-prs');
    if (!prs.length) {
      el.innerHTML = '<div style="font-size:11px;font-family:var(--mono);color:var(--muted);padding:8px 0">No open PRs</div>';
      return;
    }
    el.innerHTML = prs.map((p) =>
      `<div class="pr-item" onclick="reviewPR(${p.number},'${ctx.esc(p.title)}','${owner}','${repo}')">
        <div class="pr-title">#${p.number} ${ctx.esc(p.title)}</div>
        <div class="pr-meta">by ${p.user?.login} · ${p.changed_files || '?'} files · click to AI review</div>
        <div class="pr-meta" style="margin-top:4px">
          <button class="gh-btn" onclick="event.stopPropagation(); document.getElementById('gh-pr-number').value='${p.number}'; ghInspectPR();">inspect</button>
        </div>
      </div>`
    ).join('');
  }

  async function loadTunnelStatus(ctx) {
    const host = document.getElementById('gh-tunnel-host');
    if (!host) return;
    const status = await ctx.api('GET', '/api/tunnel/status').catch(() => null);
    if (!status) {
      host.innerHTML = '';
      return;
    }
    const installed = (status.availableProviders || []).map((item) => `${item.id}:${item.installed ? 'yes' : 'no'}`).join(' · ');
    const installedCount = (status.availableProviders || []).filter((item) => item.installed).length;
    const webhookUrl = `${location.origin}/api/github/webhook`;
    const publicWebhookUrl = status.publicUrl ? `${String(status.publicUrl).replace(/\/+$/, '')}/api/github/webhook` : '';
    host.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--bg2)">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <div>
            <div style="font-size:12px;font-weight:700">Inbound tunnel</div>
            <div style="font-size:11px;color:var(--muted)">${ctx.esc(status.status || 'idle')} · provider ${ctx.esc(status.provider || 'cloudflared')} · installed ${ctx.esc(installed || 'none')}</div>
            ${status.publicUrl ? `<div style="font-size:11px;font-family:var(--mono);color:var(--accent2);margin-top:6px">${ctx.esc(status.publicUrl)}</div>` : ''}
            <div style="font-size:10px;color:var(--muted);line-height:1.6;margin-top:6px">Webhook target: ${ctx.esc(webhookUrl)}</div>
            ${publicWebhookUrl ? `<div style="font-size:10px;font-family:var(--mono);color:var(--blue);line-height:1.6;margin-top:6px">Public webhook: ${ctx.esc(publicWebhookUrl)}</div>` : ''}
            ${installedCount === 0 ? `<div style="font-size:10px;color:var(--amber);line-height:1.6;margin-top:6px">Install cloudflared or ngrok to expose this workspace to GitHub or Slack webhooks.</div>` : ''}
            ${installedCount > 0 && !status.publicUrl ? `<div style="font-size:10px;color:var(--muted);line-height:1.6;margin-top:6px">Tunnel provider is available. Start it to get a public URL for inbound webhooks.</div>` : ''}
            ${publicWebhookUrl ? `<div style="font-size:10px;color:var(--muted);line-height:1.6;margin-top:6px">Setup: 1) copy public webhook 2) paste it into GitHub webhook settings 3) use the configured webhook secret from Settings.</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              ${(status.availableProviders || []).map((item) => `<span class="review-anchor ${item.installed ? 'exact' : 'shifted'}">${ctx.esc(item.id)}:${item.installed ? 'installed' : 'missing'}</span>`).join('')}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="copyGitHubWebhookUrl()">copy webhook</button>
            ${publicWebhookUrl ? `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="copyPublicGitHubWebhookUrl()">copy public webhook</button>` : ''}
            <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="configureTunnel()">configure</button>
            <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="startTunnel()">start</button>
            <button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="stopTunnel()">stop</button>
            ${status.publicUrl ? `<button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="copyTunnelPublicUrl()">copy URL</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  async function loadGitHubWebhooks(ctx) {
    await loadTunnelStatus(ctx);
    const events = await ctx.api('GET', '/api/github/webhooks/recent?limit=12').catch((err) => {
      ctx.showGhOut('gh-webhooks-out', err.message, true);
      return null;
    });
    if (!events) return;
    if (!events.length) {
      ctx.showGhOut('gh-webhooks-out', 'No webhook deliveries yet.');
      return;
    }
    const html = events.map((event) => `
      <div style="padding:8px 0;border-bottom:1px dashed var(--border)">
        <div style="font-size:10px;font-family:var(--mono);color:var(--accent2)">${ctx.esc(event.event || 'event')} · ${ctx.esc(event.action || 'received')} · ${ctx.esc(ctx.timeAgo(event.receivedAt))}</div>
        <div style="font-size:11px;color:var(--text);margin-top:4px">${ctx.esc(event.summary || 'GitHub webhook')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          ${event.repository ? `<span class="review-anchor exact">${ctx.esc(event.repository)}</span>` : ''}
          ${event.sender ? `<span class="review-anchor exact">${ctx.esc(event.sender)}</span>` : ''}
        </div>
        ${event.artifactId ? `<div style="margin-top:8px"><button class="gh-btn" style="width:auto;padding:4px 8px;margin:0" onclick="openArtifact('${event.artifactId}')">open artifact</button></div>` : ''}
      </div>
    `).join('');
    ctx.showGhOut('gh-webhooks-out', html, false, true);
  }

  async function copyGitHubWebhookUrl(ctx) {
    const webhookUrl = `${location.origin}/api/github/webhook`;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      ctx.toast('✓ Webhook URL copied', 'ok');
    } catch {
      prompt('Copy GitHub webhook URL', webhookUrl);
    }
  }

  async function copyTunnelPublicUrl(ctx) {
    const status = await ctx.api('GET', '/api/tunnel/status').catch(() => null);
    const publicUrl = String(status?.publicUrl || '').trim();
    if (!publicUrl) {
      ctx.toast('No public tunnel URL available yet', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(publicUrl);
      ctx.toast('✓ Tunnel URL copied', 'ok');
    } catch {
      prompt('Copy tunnel public URL', publicUrl);
    }
  }

  async function copyPublicGitHubWebhookUrl(ctx) {
    const status = await ctx.api('GET', '/api/tunnel/status').catch(() => null);
    const publicUrl = String(status?.publicUrl || '').trim();
    if (!publicUrl) {
      ctx.toast('No public tunnel URL available yet', 'warn');
      return;
    }
    const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/api/github/webhook`;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      ctx.toast('✓ Public webhook URL copied', 'ok');
    } catch {
      prompt('Copy public GitHub webhook URL', webhookUrl);
    }
  }

  async function configureTunnel(ctx) {
    const provider = prompt('Tunnel provider: cloudflared or ngrok', 'cloudflared');
    if (provider === null) return;
    const result = await ctx.api('POST', '/api/tunnel', { action: 'configure', provider, port: 3737 }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result) return;
    ctx.toast('✓ Tunnel settings saved', 'ok');
    loadTunnelStatus(ctx);
  }

  async function startTunnel(ctx) {
    const status = await ctx.api('GET', '/api/tunnel/status').catch(() => ({ provider: 'cloudflared' }));
    const result = await ctx.api('POST', '/api/tunnel', { provider: status.provider || 'cloudflared', port: 3737 }).catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    if (!result) return;
    ctx.toast('✓ Tunnel start requested', 'ok');
    setTimeout(() => loadTunnelStatus(ctx), 600);
  }

  async function stopTunnel(ctx) {
    await ctx.api('DELETE', '/api/tunnel').catch((err) => {
      ctx.toast(err.message, 'err');
      return null;
    });
    ctx.toast('✓ Tunnel stopped', 'ok');
    loadTunnelStatus(ctx);
  }

  window.clsClawGitHubView = {
    ghConnect,
    ghClone,
    ghStatus,
    ghPush,
    ghCreatePR,
    ghListPRs,
    loadGitHubWebhooks,
    loadTunnelStatus,
    copyGitHubWebhookUrl,
    copyTunnelPublicUrl,
    copyPublicGitHubWebhookUrl,
    configureTunnel,
    startTunnel,
    stopTunnel,
  };
})();
