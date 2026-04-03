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
  const options = arguments[1] || {};
  if (options.hasImages) {
    switch (role) {
      case 'test':
      case 'docs':
      case 'analyze':
      case 'code':
      case 'review':
      default:
        return ['openai', 'claude'];
    }
  }
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

function normalizeInputMessages({ system = '', prompt, messages = null }) {
  const normalized = [];
  if (system) {
    normalized.push({
      role: 'system',
      content: [{ type: 'text', text: String(system) }],
    });
  }
  const sourceMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: prompt }];
  for (const message of sourceMessages) {
    normalized.push({
      role: message?.role || 'user',
      content: normalizeContentParts(message?.content),
    });
  }
  return normalized;
}

function normalizeContentParts(content) {
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (!part) return [];
      if (part.type === 'text') {
        return [{ type: 'text', text: String(part.text || '') }];
      }
      if (part.type === 'image' && part.dataUrl) {
        return [{
          type: 'image',
          dataUrl: String(part.dataUrl),
          mimeType: String(part.mimeType || mimeTypeFromDataUrl(part.dataUrl)),
          name: String(part.name || ''),
        }];
      }
      return [];
    });
  }
  return [{ type: 'text', text: String(content || '') }];
}

function hasImageInputs(messages = []) {
  return normalizeInputMessages({ messages }).some((message) =>
    message.content.some((part) => part.type === 'image')
  );
}

function toAnthropicMessages(messages = []) {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content.map((part) => {
        if (part.type === 'image') {
          const { mimeType, base64 } = parseDataUrl(part.dataUrl);
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64,
            },
          };
        }
        return { type: 'text', text: String(part.text || '') };
      }),
    }));
}

function toOpenAIMessages(messages = []) {
  return messages.map((message) => {
    const mapped = message.content.map((part) => {
      if (part.type === 'image') {
        return {
          type: 'image_url',
          image_url: {
            url: part.dataUrl,
          },
        };
      }
      return {
        type: 'text',
        text: String(part.text || ''),
      };
    });
    const textOnly = mapped.every((part) => part.type === 'text');
    return {
      role: message.role,
      content: textOnly ? mapped.map((part) => part.text).join('\n') : mapped,
    };
  });
}

function flattenForLocal(messages = []) {
  return messages.map((message) => {
    const parts = message.content.map((part) => {
      if (part.type === 'image') {
        return `[image: ${part.name || 'attachment'}]`;
      }
      return String(part.text || '');
    }).filter(Boolean).join('\n');
    return `${String(message.role || 'user').toUpperCase()}:\n${parts}`;
  }).join('\n\n');
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('Invalid image data URL');
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2].replace(/\s+/g, ''),
  };
}

function mimeTypeFromDataUrl(dataUrl) {
  return parseDataUrl(dataUrl).mimeType;
}

async function callClaude({ system, prompt, messages, stream, onToken, keys, signal }) {
  if (!keys.anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
  const normalized = normalizeInputMessages({ system, prompt, messages });
  const systemText = normalized
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .map((part) => part.text || '')
    .join('\n\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': keys.anthropic,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULTS.claudeModel,
      max_tokens: 8096,
      stream: !!stream,
      system: systemText,
      messages: toAnthropicMessages(normalized),
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

async function callOpenAI({ system, prompt, messages, stream, onToken, keys, signal }) {
  if (!keys.openai) throw new Error('Missing OPENAI_API_KEY');
  const normalized = normalizeInputMessages({ system, prompt, messages });

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.openai}`,
    },
    body: JSON.stringify({
      model: DEFAULTS.openaiModel,
      stream: !!stream,
      messages: toOpenAIMessages(normalized),
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

async function callLocal({ system, prompt, messages, stream, onToken, keys, signal }) {
  if (!keys?.localConfigured || !keys?.localUrl || !keys?.localModel) {
    throw new Error('Missing Ollama configuration');
  }
  const normalized = normalizeInputMessages({ system, prompt, messages });
  if (hasImageInputs(normalized)) {
    throw new Error('Local provider does not support image inputs');
  }
  const localUrl = keys?.localUrl || OLLAMA_URL;
  const localModel = keys?.localModel || DEFAULTS.localModel;

  const res = await fetch(localUrl, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: localModel,
      prompt: flattenForLocal(normalized),
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

async function call({ role = 'code', prompt, messages = null, stream = false, system = '', apiKey = null, onToken = null, signal = null }) {
  const keys = resolveKeys(apiKey);
  const hasImages = hasImageInputs(messages || []);
  const providers = routeProviders(role, { hasImages }).filter((provider) => {
    if (provider === 'claude') return Boolean(keys.anthropic);
    if (provider === 'openai') return Boolean(keys.openai);
    if (provider === 'local') return Boolean(keys.localConfigured);
    return true;
  });
  let lastError = null;
  const errors = [];

  if (providers.length === 0) {
    if (hasImages) {
      throw new Error('Image input requires an OpenAI or Anthropic provider with multimodal support');
    }
    throw new Error('No configured model provider available');
  }

  for (const provider of providers) {
    try {
      if (provider === 'claude') return await callClaude({ system, prompt, messages, stream, onToken, keys, signal });
      if (provider === 'openai') return await callOpenAI({ system, prompt, messages, stream, onToken, keys, signal });
      if (provider === 'local') return await callLocal({ system, prompt, messages, stream, onToken, keys, signal });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw err;
      }
      lastError = err;
      errors.push(`${provider}: ${err.message}`);
    }
  }

  if (errors.length > 1) {
    throw new Error(errors.join(' | '));
  }
  throw lastError || new Error('No available model provider');
}

module.exports = {
  call,
  routeProviders,
  resolveKeys,
  normalizeInputMessages,
  hasImageInputs,
};
