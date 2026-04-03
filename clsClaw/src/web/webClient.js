'use strict';

const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_PAGE_CHARS = 35000;
const DOC_DOMAIN_REGISTRY = {
  openai: ['platform.openai.com', 'help.openai.com', 'openai.com'],
  anthropic: ['docs.anthropic.com', 'anthropic.com'],
  react: ['react.dev'],
  node: ['nodejs.org'],
  npm: ['docs.npmjs.com', 'www.npmjs.com'],
  github: ['docs.github.com', 'github.com'],
  ollama: ['ollama.com'],
  mdn: ['developer.mozilla.org'],
};

class WebClient {
  constructor({ fetchImpl = fetch, userAgent = 'clsClaw/1.0 (+local-web-client)' } = {}) {
    this._fetch = fetchImpl;
    this._userAgent = userAgent;
  }

  async search(query, { limit = DEFAULT_SEARCH_LIMIT, domains = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is required');
    const filteredDomains = normalizeDomains(domains);
    const searchQuery = filteredDomains.length
      ? `${q} ${filteredDomains.map((domain) => `site:${domain}`).join(' OR ')}`
      : q;
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const html = await this._fetchText(url, timeoutMs);
    const results = parseDuckDuckGoResults(html)
      .filter((result) => filteredDomains.length === 0 || filteredDomains.includes(hostnameForUrl(result.url)))
      .slice(0, clampInt(limit, 1, 10, DEFAULT_SEARCH_LIMIT));
    return {
      ok: true,
      query: q,
      searchUrl: url,
      results,
    };
  }

  async open(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const normalized = normalizeHttpUrl(url);
    const { response, text } = await this._fetchPage(normalized, timeoutMs);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const title = extractTitle(text) || hostnameForUrl(normalized) || normalized;
    const excerpt = contentType.includes('html')
      ? extractReadableText(text, { maxChars: MAX_PAGE_CHARS })
      : text.slice(0, MAX_PAGE_CHARS);

    return {
      ok: true,
      url: normalized,
      finalUrl: response.url || normalized,
      title,
      contentType,
      excerpt,
      fetchedAt: new Date().toISOString(),
    };
  }

  async docs(query, { domains = [], limit = DEFAULT_SEARCH_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const normalizedDomains = normalizeDomains(domains);
    const inferredDomains = normalizedDomains.length ? normalizedDomains : inferOfficialDocDomains(query);
    const effectiveDomains = inferredDomains.length ? inferredDomains : normalizedDomains;
    if (!effectiveDomains.length) throw new Error('domains are required for docs lookup');
    return this.search(query, {
      limit,
      domains: effectiveDomains,
      timeoutMs,
    });
  }

  async _fetchPage(targetUrl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this._fetch(targetUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': this._userAgent,
          'Accept': 'text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8',
        },
      });
      if (!response.ok) {
        throw new Error(`Web fetch ${response.status}: ${await response.text()}`);
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!/text\/html|text\/plain|application\/xhtml\+xml/.test(contentType)) {
        throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
      }
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async _fetchText(url, timeoutMs) {
    const { text } = await this._fetchPage(url, timeoutMs);
    return text;
  }
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(String(html || ''))) !== null) {
    const rawHref = decodeHtmlEntities(match[1]);
    const url = decodeDuckDuckGoRedirect(rawHref);
    const title = cleanInlineText(match[2]);
    if (!url || !title) continue;
    results.push({
      url,
      title,
      domain: hostnameForUrl(url),
    });
  }
  return dedupeByUrl(results);
}

function decodeDuckDuckGoRedirect(rawHref) {
  try {
    const possible = rawHref.startsWith('http')
      ? new URL(rawHref)
      : new URL(rawHref, 'https://duckduckgo.com');
    const uddg = possible.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : possible.href;
  } catch {
    return '';
  }
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanInlineText(match[1]) : '';
}

function extractReadableText(html, { maxChars = MAX_PAGE_CHARS } = {}) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  text = text.replace(/<\/(p|div|section|article|h1|h2|h3|li|tr)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/\r/g, '');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim().slice(0, maxChars);
}

function cleanInlineText(text) {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function hostnameForUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function dedupeByUrl(results) {
  const seen = new Set();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains)) return [];
  return domains
    .map((domain) => String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
    .filter(Boolean);
}

function inferOfficialDocDomains(query) {
  const text = String(query || '').toLowerCase();
  const domains = [];
  for (const [keyword, candidates] of Object.entries(DOC_DOMAIN_REGISTRY)) {
    if (text.includes(keyword)) domains.push(...candidates);
  }
  return Array.from(new Set(domains));
}

function normalizeHttpUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }
  return url.toString();
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

module.exports = {
  WebClient,
  parseDuckDuckGoResults,
  extractReadableText,
  extractTitle,
  hostnameForUrl,
  inferOfficialDocDomains,
};
