'use strict';

const { isCasualGreeting, isIdeaRequest } = require('./conversationRouter');

function composeFinalAnswer({ text = '', policy = {}, usedTools = false } = {}) {
  const raw = String(text || '').trim();
  const userText = String(policy?.userText || '').trim();
  const lane = String(policy?.lane || inferLane(policy, userText)).trim() || 'analysis';
  const cleaned = sanitizeAnswer(stripBuildArtifactsForLane(raw, lane));

  if (lane === 'plain_chat') {
    return composePlainChatReply({ raw: cleaned, userText });
  }
  if (lane === 'brainstorm') {
    return composeBrainstormReply({ raw: cleaned, userText, usedTools });
  }
  if (lane === 'analysis') {
    return cleaned;
  }
  return sanitizeAnswer(raw);
}

function composePlainChatReply({ raw, userText }) {
  const text = userText.toLowerCase();
  if (!isBareGreeting(text)) {
    return raw;
  }
  if (/\bhow are you\b/.test(text)) {
    return "I'm good and ready to help.";
  }
  if (isCasualGreeting(text)) {
    return "Hey. I'm here and ready to help.";
  }
  return raw;
}

function composeBrainstormReply({ raw, userText, usedTools }) {
  const cleaned = stripTrailingQuestions(raw);
  if (looksLikeUsefulBrainstorm(cleaned) && !looksOverlyMeta(cleaned)) {
    return cleaned;
  }
  const ideas = buildIdeaSuggestions(userText);
  return [
    'We could build one of these next:',
    ...ideas.map((idea, index) => `${index + 1}. ${idea}`),
    usedTools ? '' : 'Pick one and I can turn it into a plan or start building it.',
  ].filter(Boolean).join('\n');
}

function sanitizeAnswer(text = '') {
  return String(text || '')
    .replace(/\b(Response Notes|Turn Trace|Closeout|Grounding|Verified|Uncertain \/ Next)\b[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripBuildArtifactsForLane(text = '', lane = 'analysis') {
  if (lane === 'operation') return String(text || '').trim();
  return stripBuildArtifacts(text);
}

function stripBuildArtifacts(text = '') {
  return String(text || '')
    .replace(/```(?:patch|bash|sh)?[\s\S]*?```/gi, '')
    .replace(/^\s*\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch\s*$/gim, '')
    .replace(/^\s*#\s*RUN:.*$/gim, '')
    .replace(/^\s*(?:\/\/|#)\s*SAVE_AS:.*$/gim, '')
    .trim();
}

function stripTrailingQuestions(text = '') {
  return String(text || '')
    .replace(/\s+(What(?: would| should| do).*)$/i, '')
    .replace(/\s+(How can I help.*)$/i, '')
    .replace(/\s+(Would you like me to.*)$/i, '')
    .trim();
}

function looksLikeUsefulBrainstorm(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (normalized.length < 24) return false;
  if (/\?$/.test(normalized)) return false;
  if (/\n\d+\./.test(normalized) || /\n- /.test(normalized)) return true;
  return /we could|you could|build|project|idea/i.test(normalized);
}

function looksOverlyMeta(text = '') {
  return /\b(approval|planner|evidence|verification|trace|policy|grounding)\b/i.test(String(text || ''));
}

function buildIdeaSuggestions(userText = '') {
  const text = String(userText || '').toLowerCase();
  if (/\b(matlab|simulation|engineering|motion|signal|control|circuit|physics)\b/.test(text)) {
    return [
      'a MATLAB simulation debugger that checks formulas, plots, and unit mistakes',
      'a lab-report helper that turns code, graphs, and observations into a structured summary',
      'a numerical methods visualizer for root finding, interpolation, and differential equations',
      'a cross-language converter that explains MATLAB logic and ports it to Python step by step',
    ];
  }
  return [
    'a bug-finding and auto-fix assistant for coursework code and lab projects',
    'a MATLAB and Python visual debugger for plots, equations, and simulation outputs',
    'a project review tool that explains code quality issues in beginner-friendly language',
    'a report and presentation helper that turns technical work into polished summaries',
  ];
}

function inferLane(policy = {}, userText = '') {
  if (policy?.lane) return policy.lane;
  const text = String(userText || '').toLowerCase();
  if (isCasualGreeting(text)) return 'plain_chat';
  if (isIdeaRequest(text)) return 'brainstorm';
  if (String(policy?.intent || '') === 'build') return 'operation';
  return 'analysis';
}

function isBareGreeting(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  return /^(hi|hello|hey|yo|how are you|what's up|whats up|good morning|good evening|thanks|thank you)[!.? ]*$/.test(normalized);
}

module.exports = {
  composeFinalAnswer,
  sanitizeAnswer,
  stripTrailingQuestions,
  stripBuildArtifacts,
};
