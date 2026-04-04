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

  function renderVisualDebugLaneMarkup(workflow = {}, options = {}) {
    const compact = Boolean(options.compact);
    const lane = Array.isArray(workflow.debugLane) ? workflow.debugLane : [];
    const coverage = workflow.coverage || {};
    return `
      <div class="${compact ? 'review-section' : 'closeout-panel'}">
        <div class="${compact ? 'review-section-title' : 'closeout-title'}">Visual Debug Workflow</div>
        <div style="font-size:11px;color:var(--muted);line-height:1.6">${esc(workflow.summary || 'Visual issue captured.')}</div>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="review-anchor ${workflow.confidence === 'grounded' ? 'exact' : 'shifted'}">${esc(workflow.statusLabel || workflow.confidence || 'visual clue')}</span>
          <span class="review-anchor exact">visuals:${esc(coverage.visuals ?? 0)}</span>
          <span class="review-anchor exact">files:${esc(coverage.files ?? 0)}</span>
          <span class="review-anchor exact">docs:${esc(coverage.docs ?? 0)}</span>
          ${(workflow.relatedFiles || []).map((file) => `<span class="review-anchor exact">${esc(file.label || file.file || '')}</span>`).join('')}
        </div>
        <div class="debug-lane">
          ${lane.map((step) => `
            <div class="debug-step">
              <div class="debug-step-stage">${esc(step.stage)}</div>
              <div class="debug-step-detail">${esc(step.detail)}</div>
            </div>
          `).join('')}
        </div>
        ${workflow.docSources?.length ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${workflow.docSources.map((source) => `<a class="review-source-pill" href="${escAttr(source.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${esc(source.title)}</a>`).join('')}</div>` : ''}
        ${workflow.nextSteps?.length ? `<div style="margin-top:10px" class="review-findings-list">${workflow.nextSteps.map((step) => `<div class="review-finding-row"><span class="review-finding-bullet">•</span><span>${esc(step)}</span></div>`).join('')}</div>` : ''}
      </div>
    `;
  }

  function renderReviewEvidenceSection(reviewBundle = null, evidenceBundle = null, makeEvidenceDeckMarkup = null) {
    if (!evidenceBundle?.summary) return '';
    return `<div class="review-section">
      <div class="review-section-title">Evidence</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.6">${esc(evidenceBundle.summary)}</div>
      ${reviewBundle?.evidence?.categories ? `<div style="margin-top:8px;font-size:10px;font-family:var(--mono);color:var(--muted)">${esc(Object.entries(reviewBundle.evidence.categories).filter(([,count]) => Number(count) > 0).map(([key,count]) => `${key}:${count}`).join(' · '))}</div>` : ''}
      ${reviewBundle?.evidence?.groundingHighlights?.length ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${reviewBundle.evidence.groundingHighlights.map((item) => `<span class="review-anchor exact">${esc(item)}</span>`).join('')}</div>` : ''}
      ${reviewBundle?.evidence?.topExternalSources?.length ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${reviewBundle.evidence.topExternalSources.map((source) => `<a class="review-source-pill" href="${escAttr(source.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${esc(source.title)}</a>`).join('')}</div>` : ''}
      ${reviewBundle?.evidence?.sourceReferences?.length ? `<div style="margin-top:10px" class="review-findings-list">${reviewBundle.evidence.sourceReferences.map((item) => `<div class="review-finding-row"><span class="review-finding-bullet">•</span><span><strong>${esc(item.label)}</strong> — ${esc(item.detail || item.kind || '')}</span></div>`).join('')}</div>` : ''}
      ${reviewBundle?.evidence?.topVisualEvidence?.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">${reviewBundle.evidence.topVisualEvidence.map((item) => `<div class="visual-card"><div class="visual-card-top"><span class="visual-chip">${esc(item.citationId || 'V')}</span><span>${esc(item.title)}</span></div><div class="visual-snippet">${esc(String(item.snippet || '').slice(0, 220))}</div></div>`).join('')}</div>` : ''}
      ${typeof makeEvidenceDeckMarkup === 'function' ? `<div style="margin-top:12px">${makeEvidenceDeckMarkup(evidenceBundle, { sources: reviewBundle?.evidence?.topExternalSources || [], visualEvidence: reviewBundle?.evidence?.topVisualEvidence || [] })}</div>` : ''}
    </div>`;
  }

  window.clsClawReviewModules = {
    renderVisualDebugLaneMarkup,
    renderReviewEvidenceSection,
  };
})();
