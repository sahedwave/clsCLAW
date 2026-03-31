'use strict';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';

const DEFAULTS = {
  claudeModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  localModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
};

function resolveLocalConfig(input = {}) {
  const explicitUrl = input.ollamaUrl || input.localUrl || '';
  const explicitModel = input.ollamaModel || input.localModel || '';
  const envUrl = process.env.OLLAMA_URL || '';
  const envModel = process.env.OLLAMA_MODEL || '';

  const localRequested = Boolean(explicitUrl || explicitModel || envUrl || envModel);
  if (!localRequested) {
    return { localUrl: '', localModel: '', localConfigured: false };
  }

  return {
    localUrl: explicitUrl || envUrl || OLLAMA_URL,
    localModel: explicitModel || envModel || DEFAULTS.localModel,
    localConfigured: true,
  };
}

function resolveKeys(apiKey) {
  if (apiKey && typeof apiKey === 'object') {
    const local = resolveLocalConfig(apiKey);
    return {
      anthropic: apiKey.anthropic || apiKey.claude || apiKey.apiKey || process.env.ANTHROPIC_API_KEY || '',
      openai: apiKey.openai || apiKey.openaiApiKey || process.env.OPENAI_API_KEY || '',
      localUrl: local.localUrl,
      localModel: local.localModel,
      localConfigured: local.localConfigured,
    };
  }

  const local = resolveLocalConfig({});
  return {
    anthropic: apiKey || process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    localUrl: local.localUrl,
    localModel: local.localModel,
    localConfigured: local.localConfigured,
  };
}

function routeProviders(role) {
  switch (role) {
    case 'test':
      return ['openai', 'claude'];
    case 'docs':
      return ['local', 'openai', 'claude'];
    case 'analyze':
    case 'code':
    case 'review':
    default:
      return ['claude', 'openai', 'local'];
  }
}

async function readSseStream(stream, onEvent) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try { onEvent(JSON.parse(raw)); } catch {}
    }
  }
}

async function callClaude({ system, prompt, stream, onToken, keys }) {
  if (!keys.anthropic) throw new Error('Missing ANTHROPIC_API_KEY');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': keys.anthropic,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULTS.claudeModel,
      max_tokens: 8096,
      stream: !!stream,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const json = await res.json();
    const text = (json.content || []).map((c) => c?.text || '').join('');
    return { text, provider: 'claude', model: DEFAULTS.claudeModel };
  }

  let text = '';
  await readSseStream(res.body, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      const token = evt.delta.text || '';
      text += token;
      if (token && onToken) onToken(token);
    }
  });

  return { text, provider: 'claude', model: DEFAULTS.claudeModel };
}

async function callOpenAI({ system, prompt, stream, onToken, keys }) {
  if (!keys.openai) throw new Error('Missing OPENAI_API_KEY');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.openai}`,
    },
    body: JSON.stringify({
      model: DEFAULTS.openaiModel,
      stream: !!stream,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    return { text, provider: 'openai', model: DEFAULTS.openaiModel };
  }

  let text = '';
  await readSseStream(res.body, (evt) => {
    const token = evt.choices?.[0]?.delta?.content || '';
    if (token) {
      text += token;
      if (onToken) onToken(token);
    }
  });

  return { text, provider: 'openai', model: DEFAULTS.openaiModel };
}

async function callLocal({ system, prompt, stream, onToken, keys }) {
  if (!keys?.localConfigured || !keys?.localUrl || !keys?.localModel) {
    throw new Error('Missing Ollama configuration');
  }
  const localUrl = keys?.localUrl || OLLAMA_URL;
  const localModel = keys?.localModel || DEFAULTS.localModel;

  const res = await fetch(localUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: localModel,
      prompt: system ? `${system}\n\n${prompt}` : prompt,
      stream: !!stream,
    }),
  });

  if (!res.ok) throw new Error(`Ollama API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const json = await res.json();
    return { text: json.response || '', provider: 'local', model: localModel };
  }

  let text = '';
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        const token = evt.response || '';
        if (token) {
          text += token;
          if (onToken) onToken(token);
        }
      } catch {}
    }
  }

  return { text, provider: 'local', model: localModel };
}

async function call({ role = 'code', prompt, stream = false, system = '', apiKey = null, onToken = null }) {
  const keys = resolveKeys(apiKey);
  const providers = routeProviders(role).filter((provider) => {
    if (provider === 'claude') return Boolean(keys.anthropic);
    if (provider === 'openai') return Boolean(keys.openai);
    if (provider === 'local') return Boolean(keys.localConfigured);
    return true;
  });
  let lastError = null;
  const errors = [];

  if (providers.length === 0) {
    throw new Error('No configured model provider available');
  }

  for (const provider of providers) {
    try {
      if (provider === 'claude') return await callClaude({ system, prompt, stream, onToken, keys });
      if (provider === 'openai') return await callOpenAI({ system, prompt, stream, onToken, keys });
      if (provider === 'local') return await callLocal({ system, prompt, stream, onToken, keys });
    } catch (err) {
      lastError = err;
      errors.push(`${provider}: ${err.message}`);
    }
  }

  if (errors.length > 1) {
    throw new Error(errors.join(' | '));
  }
  throw lastError || new Error('No available model provider');
}

module.exports = { call, routeProviders, resolveKeys };
