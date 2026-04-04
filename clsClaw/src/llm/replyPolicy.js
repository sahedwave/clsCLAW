'use strict';

const { normalizeExecutionProfile } = require('../orchestration/executionProfiles');
const {
  normalizeMode,
  extractUserIntentText,
  hasAttachedContext,
  routeConversation,
} = require('./conversationRouter');

const CANONICAL_FACTS = {
  productName: 'clsClaw',
  assistantName: 'clsClaw',
  creatorName: 'Md Shahed Rahman',
};

const BUILD_REVIEW_SECTIONS = [
  'Understanding',
  'Plan',
  'Justification',
  'Risks',
  'Self-check',
  'Approval checkpoints',
];

function detectIntent({ messages = [], mode = 'ask', clientHints = {} } = {}) {
  return routeConversation({ messages, mode, clientHints }).intent;
}

function intentToRole(intent) {
  switch (intent) {
    case 'review':
      return 'review';
    case 'test':
      return 'test';
    case 'build':
      return 'code';
    default:
      return 'analyze';
  }
}

function maybeAnswerCanonicalQuestion({ messages = [] } = {}) {
  const userText = extractUserIntentText(messages);
  const text = userText.toLowerCase();
  const mentionsProduct = /\bclsclaw\b/.test(text);
  const mentionsAssistant = /\bclsclaw\b/.test(text);
  const asksAboutCreator = /\b(creator|founder|maker|owner|author|developer)\b/.test(text);
  const asksWhoBuilt = /\bwho (created|made|built)\b/.test(text);

  const asksCreator = (asksAboutCreator || asksWhoBuilt) && (mentionsProduct || mentionsAssistant);

  if (asksCreator) {
    return {
      text: `${CANONICAL_FACTS.creatorName} is the creator of ${CANONICAL_FACTS.productName}. ${CANONICAL_FACTS.assistantName} is the assistant inside ${CANONICAL_FACTS.productName}.`,
      mode: 'ask',
      intent: 'identity',
      role: 'analyze',
      lane: 'plain_chat',
      ui: buildUiPolicy('plain_chat'),
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
      lane: 'plain_chat',
      ui: buildUiPolicy('plain_chat'),
    };
  }

  return null;
}

function buildPolicySystem({
  projectRoot = '',
  messages = [],
  mode = 'ask',
  profile = 'deliberate',
  incomingSystem = '',
  clientHints = {},
} = {}) {
  const route = routeConversation({
    projectRoot,
    messages,
    mode,
    profile,
    clientHints,
  });
  const executionProfile = normalizeExecutionProfile(profile || route.profile);
  const promptParts = [
    buildSharedSystem({ projectRoot }),
    buildLaneSystem(route),
  ];

  if (incomingSystem && String(incomingSystem).trim()) {
    promptParts.push(`Caller guidance:\n${String(incomingSystem).trim()}`);
  }

  promptParts.push(`Execution profile:
- Profile: ${executionProfile.label}
- Description: ${executionProfile.description}
- Max steps budget: ${executionProfile.maxSteps}
- Safe parallel reads preferred: ${executionProfile.allowParallel ? 'yes' : 'no'}`);

  if (route.userText) {
    promptParts.push(`Current user request:\n${route.userText}`);
  }

  return {
    mode: normalizeMode(mode),
    profile: executionProfile.id,
    executionProfile,
    lane: route.lane,
    intent: route.intent,
    responseStyle: route.responseStyle,
    role: route.role || intentToRole(route.intent),
    userText: route.userText,
    tools: { ...route.tools },
    ui: { ...route.ui },
    workflowDirective: route.workflowDirective,
    hasImages: route.hasImages,
    hasAttachedContext: route.hasAttachedContext,
    system: promptParts.join('\n\n'),
  };
}

function buildSharedSystem({ projectRoot = '' } = {}) {
  return `You are clsClaw, a natural assistant first and a coding agent only when the task truly requires it.
Project root: ${projectRoot}

Canonical product facts:
- Product name: ${CANONICAL_FACTS.productName}
- Assistant name: ${CANONICAL_FACTS.assistantName}
- Creator of ${CANONICAL_FACTS.productName}: ${CANONICAL_FACTS.creatorName}

Always understand the user's real request before answering.
Start in the lightest possible response lane and escalate only when the task clearly requires repo work.
Never claim you read files, repositories, pages, or sources unless they were actually provided in context or fetched directly.
If screenshots or images are attached, treat them as first-class evidence and describe only what they visibly support.
If you are uncertain, say exactly what is uncertain instead of bluffing.
Do not add source-code comments unless they are genuinely necessary for non-obvious logic.`;
}

function buildLaneSystem(route = {}) {
  const lane = route.lane || 'analysis';
  if (lane === 'plain_chat') {
    return `Resolved lane: plain_chat
Intent: ${route.intent}
Style: ${route.responseStyle}

Reply like a polished everyday assistant.
Answer directly in plain language.
No orchestration talk.
No trace, closeout, evidence deck, approvals, patch output, RUN blocks, SAVE_AS blocks, or file-writing proposals.
Keep greetings and casual conversation short and natural.
For factual or personal questions, give the answer plainly and stop unless the user asks for more.`;
  }

  if (lane === 'brainstorm') {
    return `Resolved lane: brainstorm
Intent: ${route.intent}
Style: ${route.responseStyle}

Lead with ideas, options, or lightweight plans.
Do not ask a blocking follow-up before offering concrete suggestions.
No tool loop.
No operational UI language.
No patch output, RUN blocks, SAVE_AS blocks, or approval framing.
Keep the answer creative, direct, and easy to scan.`;
  }

  if (lane === 'analysis') {
    return `Resolved lane: analysis
Intent: ${route.intent}
Style: ${route.responseStyle}

Answer first.
Explain architecture, behavior, or tradeoffs clearly and without orchestration language.
Inspect lightly only when truly needed to answer correctly.
Do not turn analysis into implementation.
Do not emit patch output, RUN blocks, SAVE_AS blocks, approval pauses, or closeout summaries.
Separate verified facts from inference when evidence matters.`;
  }

  const reviewBlock = route.intent === 'review'
    ? `Review rules:
- Start with Findings.
- Order findings by severity.
- Explain what is wrong, why it matters, and where it appears.
- If there is no real issue, say "No findings" and note any residual risk or missing tests.`
    : '';

  return `Resolved lane: operation
Intent: ${route.intent}
Style: ${route.responseStyle}

Behave like a practical coding agent.
Inspect first, then make the smallest safe change or verification step that solves the task.
Preserve real engineering power for fix, refactor, review, verify, and debug work.
Use tools when they materially improve correctness.
Verification, approval, and closeout are allowed only because this is an operational turn.
Keep the user-facing answer natural and compact instead of sounding like an orchestration console.
${reviewBlock}`.trim();
}

function buildUiPolicy(lane) {
  return routeConversation({ messages: [], mode: 'ask', clientHints: { composerMode: lane === 'operation' ? 'build' : 'ask' } }).ui;
}

module.exports = {
  CANONICAL_FACTS,
  BUILD_REVIEW_SECTIONS,
  normalizeMode,
  extractUserIntentText,
  hasAttachedContext,
  detectIntent,
  intentToRole,
  maybeAnswerCanonicalQuestion,
  buildPolicySystem,
};
