'use strict';

const CANONICAL_FACTS = {
  productName: 'clsClaw',
  assistantName: 'cLoSe',
  creatorName: 'Md Shahed Rahman',
};

function normalizeMode(mode) {
  return mode === 'build' ? 'build' : 'ask';
}

function extractUserIntentText(messages = []) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  if (!lastUser) return '';
  const content = Array.isArray(lastUser.content)
    ? lastUser.content.map((part) => part?.text || '').join('\n')
    : String(lastUser.content || '');
  return content.split('\n\nCONTEXT:\n')[0].trim();
}

function detectIntent({ messages = [], mode = 'ask' } = {}) {
  const normalizedMode = normalizeMode(mode);
  const userText = extractUserIntentText(messages);
  const text = userText.toLowerCase();

  if (/\b(review|audit|critique|inspect this pr|code review|request changes)\b/.test(text)) {
    return 'review';
  }
  if (/\b(plan|roadmap|break this into steps|phases|milestones)\b/.test(text)) {
    return 'plan';
  }
  if (/\b(write tests|add tests|test coverage|unit tests|integration tests|e2e)\b/.test(text)) {
    return 'test';
  }
  if (/\b(readme|documentation|docs|docstrings|jsdoc)\b/.test(text)) {
    return 'docs';
  }
  if (normalizedMode === 'build') {
    return 'build';
  }
  if (/\b(build|fix|refactor|implement|patch|rewrite|scaffold)\b/.test(text)) {
    return 'build';
  }
  return 'chat';
}

function intentToRole(intent) {
  switch (intent) {
    case 'review':
      return 'review';
    case 'test':
      return 'test';
    case 'docs':
      return 'docs';
    case 'build':
      return 'code';
    case 'plan':
    case 'chat':
    default:
      return 'analyze';
  }
}

function maybeAnswerCanonicalQuestion({ messages = [] } = {}) {
  const userText = extractUserIntentText(messages);
  const text = userText.toLowerCase();
  const mentionsProduct = /\bclsclaw\b/.test(text);
  const mentionsAssistant = /\bclose\b/.test(text);
  const asksAboutCreator = /\b(creator|founder|maker|owner|author|developer)\b/.test(text);
  const asksWhoBuilt = /\bwho (created|made|built)\b/.test(text);

  const asksCreator = (asksAboutCreator || asksWhoBuilt) && (mentionsProduct || mentionsAssistant);

  if (asksCreator) {
    return {
      text: `${CANONICAL_FACTS.creatorName} is the creator of ${CANONICAL_FACTS.productName}. ${CANONICAL_FACTS.assistantName} is the assistant inside ${CANONICAL_FACTS.productName}.`,
      mode: 'ask',
      intent: 'identity',
      role: 'analyze',
    };
  }

  const asksIdentity =
    /\b(what is (?:this|the product name|your name)|who are you|what are you|spell|capitalization|proper name)\b/.test(text) &&
    (mentionsProduct || mentionsAssistant);

  if (asksIdentity) {
    return {
      text: `${CANONICAL_FACTS.productName} is the product name, with that exact casing. ${CANONICAL_FACTS.assistantName} is the assistant name, with that exact casing. ${CANONICAL_FACTS.creatorName} is the creator of ${CANONICAL_FACTS.productName}.`,
      mode: 'ask',
      intent: 'identity',
      role: 'analyze',
    };
  }

  return null;
}

function buildPolicySystem({ projectRoot = '', messages = [], mode = 'ask', incomingSystem = '' } = {}) {
  const normalizedMode = normalizeMode(mode);
  const intent = detectIntent({ messages, mode: normalizedMode });
  const role = intentToRole(intent);
  const userText = extractUserIntentText(messages);

  const shared = `You are cLoSe, a high-agency software engineering assistant for a local workspace.
Project root: ${projectRoot}

Canonical product facts:
- Product name: ${CANONICAL_FACTS.productName}
- Assistant name: ${CANONICAL_FACTS.assistantName}
- Creator of ${CANONICAL_FACTS.productName}: ${CANONICAL_FACTS.creatorName}

Always understand the user's actual demand before answering.
Prefer direct, calm, high-signal replies.
State assumptions briefly when you make them.
If you are uncertain, say exactly what is uncertain instead of bluffing.
Do not add source-code comments unless they are genuinely necessary for non-obvious logic.`;

  const askPolicy = `Mode: Ask
Intent: ${intent}

Reply in plain text by default.
Do not emit SAVE_AS blocks, RUN commands, shell instructions, or file-writing proposals unless the user explicitly asks for implementation.
If the request is a review, findings come first, ordered by severity, with concise reasoning.
If the request is planning, give a practical plan with tradeoffs and likely risks.
Focus on helping the user understand what to do next.`;

  const buildPolicy = `Mode: Build
Intent: ${intent}

When implementing, your reply must start with these plain-text sections before any code blocks:
Understanding:
Approach:
Why this approach:
Self-check:

In Self-check, name likely mistakes, risky assumptions, validation gaps, or follow-up checks.
Prefer clean, product-quality output over the fastest patch.
Prefer modifying existing files over creating new structure unless a new file is justified.

Only after those sections, emit SAVE_AS file proposals and RUN blocks when they are truly needed.
Do not emit SAVE_AS or RUN blocks for purely explanatory answers.`;

  const promptParts = [
    shared,
    normalizedMode === 'build' ? buildPolicy : askPolicy,
  ];

  if (incomingSystem && String(incomingSystem).trim()) {
    promptParts.push(`Caller guidance:\n${String(incomingSystem).trim()}`);
  }

  if (userText) {
    promptParts.push(`Current user request:\n${userText}`);
  }

  return {
    mode: normalizedMode,
    intent,
    role,
    userText,
    system: promptParts.join('\n\n'),
  };
}

module.exports = {
  CANONICAL_FACTS,
  normalizeMode,
  extractUserIntentText,
  detectIntent,
  intentToRole,
  maybeAnswerCanonicalQuestion,
  buildPolicySystem,
};
