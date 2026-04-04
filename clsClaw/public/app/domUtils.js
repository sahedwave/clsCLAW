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

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    document.getElementById('toasts')?.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function timeAgo(ts) {
    const seconds = Math.round((Date.now() - Number(ts || 0)) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  function timeDiff(start, end) {
    const seconds = Math.round(((Number(end || Date.now())) - Number(start || 0)) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  }

  window.clsClawDomUtils = {
    esc,
    shortPath,
    openModal,
    closeModal,
    toast,
    timeAgo,
    timeDiff,
  };
})();
