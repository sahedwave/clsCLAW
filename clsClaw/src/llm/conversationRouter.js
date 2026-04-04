'use strict';

const { normalizeExecutionProfile } = require('../orchestration/executionProfiles');

function normalizeMode(mode) {
  return mode === 'build' ? 'build' : 'ask';
}

function extractWorkflowDirective(text = '') {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/([a-z][a-z0-9_-]*)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function stripWorkflowDirective(text = '') {
  return String(text || '').replace(/^\/[a-z][a-z0-9_-]*\b\s*/i, '');
}

function normalizeLooseText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/suggets/g, 'suggest')
    .replace(/somthing/g, 'something')
    .replace(/pls\b/g, 'please')
    .replace(/[^\w\s/?.,:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUserIntentText(messages = []) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  if (!lastUser) return '';
  const content = Array.isArray(lastUser.content)
    ? lastUser.content.map((part) => part?.text || '').join('\n')
    : String(lastUser.content || '');
  return stripWorkflowDirective(content.split('\n\nCONTEXT:\n')[0].trim());
}

function hasAttachedContext(messages = []) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  if (!lastUser) return false;
  const content = Array.isArray(lastUser.content)
    ? lastUser.content.map((part) => part?.text || '').join('\n')
    : String(lastUser.content || '');
  return content.includes('\n\nCONTEXT:\n');
}

function isCasualGreeting(text = '') {
  return /\b(hi|hello|hey|yo|how are you|what's up|whats up|good morning|good evening|thanks|thank you)\b/.test(String(text || '').toLowerCase());
}

function isIdeaRequest(text = '') {
  const normalized = normalizeLooseText(text);
  if (/\bwhat can we build\b/.test(normalized)) return true;
  if (/\bproject ideas?\b/.test(normalized)) return true;
  if (/\bwhat should i ask\b/.test(normalized)) return true;
  if (/\bbrainstorm\b/.test(normalized)) return true;
  if (/\bsuggest\b/.test(normalized) && /\b(build|project|idea|something)\b/.test(normalized)) return true;
  return /\b(build|project|idea)\b/.test(normalized) && /\b(what|which|some|something|ideas?)\b/.test(normalized);
}

function isQuestionLike(text = '') {
  const source = String(text || '').trim().toLowerCase();
  return /\?$/.test(source)
    || /^(what|why|how|who|when|where|which|can|could|would|do|does|did|is|are|am|if)\b/.test(source);
}

function containsImages(messages = []) {
  return Array.isArray(messages) && messages.some((msg) =>
    Array.isArray(msg?.content) && msg.content.some((part) => part?.type === 'image')
  );
}

function routeConversation({
  projectRoot = '',
  messages = [],
  mode = 'ask',
  profile = 'deliberate',
  clientHints = {},
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const executionProfile = normalizeExecutionProfile(profile);
  const userText = extractUserIntentText(messages);
  const rawText = String(userText || '');
  const text = normalizeLooseText(userText);
  const workflowDirective = extractWorkflowDirective(rawText);
  const hasImages = containsImages(messages);
  const attachedContext = hasAttachedContext(messages);
  const composerModeHint = normalizeMode(clientHints?.composerMode || normalizedMode);
  const route = decideRoute({
    rawText,
    text,
    workflowDirective,
    normalizedMode,
    composerModeHint,
    hasImages,
    attachedContext,
  });

  return {
    projectRoot,
    mode: normalizedMode,
    profile: executionProfile.id,
    executionProfile,
    userText,
    workflowDirective,
    hasImages,
    hasAttachedContext: attachedContext,
    ...route,
  };
}

function decideRoute({
  rawText = '',
  text = '',
  workflowDirective = null,
  normalizedMode = 'ask',
  composerModeHint = 'ask',
  hasImages = false,
  attachedContext = false,
} = {}) {
  if (workflowDirective) {
    return routeFromDirective(workflowDirective, { rawText, text, normalizedMode, composerModeHint, hasImages, attachedContext });
  }

  if (isCasualGreeting(text)) {
    return buildLane('plain_chat', 'chat', 'casual', 'analyze', { hasImages, attachedContext });
  }

  if (isIdeaRequest(text)) {
    return buildLane('brainstorm', 'plan', 'brainstorm', 'analyze', { hasImages, attachedContext });
  }

  if (isOperationalRequest({ rawText, text, hasImages, composerModeHint })) {
    return routeOperationalIntent({ text, hasImages, attachedContext });
  }

  if (isAnalysisRequest({ rawText, text, hasImages, attachedContext })) {
    return routeAnalysisIntent({ text, hasImages, attachedContext });
  }

  if (isPlainConversationRequest({ text, hasImages })) {
    return buildLane('plain_chat', 'chat', isQuestionLike(text) ? 'plain' : 'casual', 'analyze', { hasImages, attachedContext });
  }

  if (composerModeHint === 'build' && hasTechnicalTarget(text)) {
    return routeOperationalIntent({ text, hasImages, attachedContext });
  }

  if (hasImages || attachedContext || hasTechnicalTarget(text)) {
    return routeAnalysisIntent({ text, hasImages, attachedContext });
  }

  return buildLane('plain_chat', 'chat', 'plain', 'analyze', { hasImages, attachedContext });
}

function routeFromDirective(directive, context = {}) {
  switch (directive) {
    case 'review':
      return buildLane('operation', 'review', 'review', 'review', context);
    case 'fix':
    case 'build':
    case 'debug-ui':
      return buildLane('operation', 'build', 'coding', 'code', context);
    case 'verify':
    case 'test':
      return buildLane('operation', 'test', 'verification', 'test', context);
    case 'brief':
      return buildLane('analysis', 'analysis', 'analysis', 'analyze', context);
    case 'swarm':
      return buildLane('operation', 'build', 'coding', 'code', context);
    default:
      return buildLane('analysis', 'analysis', 'analysis', 'analyze', context);
  }
}

function routeOperationalIntent({ text = '', hasImages = false, attachedContext = false } = {}) {
  if (/\b(review|audit|request changes|regression)\b/.test(text)) {
    return buildLane('operation', 'review', 'review', 'review', { hasImages, attachedContext });
  }
  if (/\b(verify|verification|test|tests|recheck|check these changes)\b/.test(text)) {
    return buildLane('operation', 'test', 'verification', 'test', { hasImages, attachedContext });
  }
  return buildLane('operation', 'build', 'coding', 'code', { hasImages, attachedContext });
}

function routeAnalysisIntent({ text = '', hasImages = false, attachedContext = false } = {}) {
  const intent = /\b(repo|repository|codebase|architecture|module|file|files|flow|walk me through|explain)\b/.test(text)
    ? 'analysis'
    : 'chat';
  return buildLane('analysis', intent, 'analysis', 'analyze', { hasImages, attachedContext });
}

function buildLane(lane, intent, responseStyle, role, { hasImages = false, attachedContext = false } = {}) {
  const allowLightInspection = lane === 'analysis' && (hasImages || attachedContext || intent === 'analysis');
  return {
    lane,
    intent,
    responseStyle,
    role,
    tools: {
      allowTools: lane === 'operation' || allowLightInspection,
      allowToolLoop: lane === 'operation',
      allowLightInspection,
      allowApprovals: lane === 'operation',
      allowVerification: lane === 'operation',
    },
    ui: {
      showMissionControl: lane === 'operation',
      showTrace: lane === 'operation',
      showTransparency: lane === 'operation',
      showCloseout: lane === 'operation',
      showSuggestedActions: lane === 'operation',
      showEvidenceDeck: lane === 'operation',
      showSources: lane === 'operation',
      showVisualEvidence: lane === 'operation',
      messageOnly: lane === 'plain_chat' || lane === 'brainstorm',
    },
  };
}

function isPlainConversationRequest({ text = '', hasImages = false } = {}) {
  if (hasImages) return false;
  if (!text) return true;
  if (hasTechnicalTarget(text)) return false;
  if (/\bclsclaw\b/.test(text) && /\b(creator|founder|owner|name|who are you|what are you)\b/.test(text)) return true;
  if (/\b(do u know|do you know|can you speak|can u speak|who owns|what is|who is|where is|when is)\b/.test(text)) return true;
  return isQuestionLike(text);
}

function isAnalysisRequest({ rawText = '', text = '', hasImages = false, attachedContext = false } = {}) {
  if (!rawText && !hasImages) return false;
  if (isIdeaRequest(text)) return false;
  if (/\b(fix|implement|refactor|rewrite|patch|modify|update|edit|run|execute|review|verify|test|debug)\b/.test(text)) {
    return false;
  }
  if (hasImages) return true;
  if (attachedContext) return true;
  if (/\b(explain|analy[sz]e|understand|walk me through|summari[sz]e|compare|inspect|read|open|what does|how does|architecture|flow)\b/.test(text)) {
    return true;
  }
  return hasTechnicalTarget(text) && isQuestionLike(text);
}

function isOperationalRequest({ rawText = '', text = '', hasImages = false, composerModeHint = 'ask' } = {}) {
  if (!rawText) return false;
  if (isIdeaRequest(text)) return false;
  if (/\b(analy[sz]e|inspect|explain)\b/.test(text) && !/\b(fix|implement|refactor|rewrite|patch|modify|update|edit|review|verify|test|debug)\b/.test(text)) {
    return false;
  }
  if (/^\s*(?:\/\/|#)\s*save_as:/im.test(rawText) || /^\s*#\s*run:/im.test(rawText)) {
    return true;
  }
  if (/\b(review|audit|request changes)\b/.test(text) && hasTechnicalTarget(text)) {
    return true;
  }
  if (/\b(verify|test|recheck)\b/.test(text) && hasTechnicalTarget(text)) {
    return true;
  }
  if (/\b(debug)\b/.test(text) && (hasTechnicalTarget(text) || hasImages)) {
    return true;
  }
  if (/\b(fix|implement|refactor|rewrite|patch|modify|update|edit|run|execute|scaffold)\b/.test(text)) {
    return hasTechnicalTarget(text) || hasImages || composerModeHint === 'build';
  }
  if (/\bbuild\b/.test(text)) {
    if (isQuestionLike(text)) return false;
    return /\b(app|tool|feature|component|endpoint|api|page|screen|script|project|website|dashboard|bot|assistant|agent)\b/.test(text);
  }
  return false;
}

function hasTechnicalTarget(text = '') {
  return /\b(file|files|repo|repository|codebase|workspace|project|directory|folder|module|script|source|function|class|component|hook|endpoint|api|screen|page|test|tests|bug|bugs|regression|screenshot|diff|patch|changes|code|branch|pr)\b/.test(text)
    || /\b(src\/|app\/|test\/|public\/|package\.json|readme|tsconfig|vite\.config|webpack|eslint|jest|playwright|dockerfile)\b/.test(text)
    || /\b[a-z0-9_./-]+\.(?:js|jsx|ts|tsx|py|java|go|rb|php|rs|c|cpp|m|sh|md|json|yaml|yml|css|html)\b/.test(text);
}

module.exports = {
  normalizeMode,
  extractWorkflowDirective,
  stripWorkflowDirective,
  normalizeLooseText,
  extractUserIntentText,
  hasAttachedContext,
  isCasualGreeting,
  isIdeaRequest,
  isQuestionLike,
  routeConversation,
};
