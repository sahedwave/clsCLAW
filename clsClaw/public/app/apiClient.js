(function () {
  async function request(method, path, body, { onUnauthorized = null } = {}) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
    const response = await fetch(path, opts);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && typeof onUnauthorized === 'function') {
      onUnauthorized(data);
    }
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  window.clsClawApiClient = {
    request,
  };
})();
