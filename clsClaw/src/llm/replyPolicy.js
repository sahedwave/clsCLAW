'use strict';

const { normalizeExecutionProfile } = require('../orchestration/executionProfiles');
const { extractWorkflowDirective, stripWorkflowDirective } = require('../orchestration/deliberationPolicy');

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

function normalizeMode(mode) {
  return mode === 'build' ? 'build' : 'ask';
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

function detectIntent({ messages = [], mode = 'ask' } = {}) {
  const normalizedMode = normalizeMode(mode);
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  const rawContent = lastUser
    ? Array.isArray(lastUser.content)
      ? lastUser.content.map((part) => part?.text || '').join('\n')
      : String(lastUser.content || '')
    : '';
  const userText = extractUserIntentText(messages);
  const text = userText.toLowerCase();
  const directive = extractWorkflowDirective(rawContent || userText);

  if (directive === 'review') return 'review';
  if (directive === 'fix' || directive === 'build') return 'build';
  if (directive === 'verify' || directive === 'test') return 'test';
  if (directive === 'debug-ui') return 'build';
  if (directive === 'brief') return 'plan';
  if (directive === 'swarm') return 'plan';

  if (/\b(repository|repo|codebase|github|compare repos|compare repositories|surgical analysis|deep dive)\b/.test(text)) {
    return 'repo_analysis';
  }
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
    case 'repo_analysis':
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

function buildPolicySystem({ projectRoot = '', messages = [], mode = 'ask', profile = 'deliberate', incomingSystem = '' } = {}) {
  const normalizedMode = normalizeMode(mode);
  const executionProfile = normalizeExecutionProfile(profile);
  const intent = detectIntent({ messages, mode: normalizedMode });
  const role = intentToRole(intent);
  const userText = extractUserIntentText(messages);

  const shared = `You are clsClaw, a high-agency software engineering assistant for a local workspace.
Project root: ${projectRoot}

Canonical product facts:
- Product name: ${CANONICAL_FACTS.productName}
- Assistant name: ${CANONICAL_FACTS.assistantName}
- Creator of ${CANONICAL_FACTS.productName}: ${CANONICAL_FACTS.creatorName}

Always understand the user's actual demand before answering.
Prefer direct, calm, high-signal replies.
State assumptions briefly when you make them.
If you are uncertain, say exactly what is uncertain instead of bluffing.
Never claim you read files, repos, pages, or sources unless they were actually provided in context or fetched directly.
If screenshots or images are attached, treat them as first-class evidence and describe only what they visibly support.
Do not add source-code comments unless they are genuinely necessary for non-obvious logic.`;

  const askPolicy = `Mode: Ask
Intent: ${intent}

Reply in plain text by default.
Do not emit SAVE_AS blocks, RUN commands, shell instructions, or file-writing proposals unless the user explicitly asks for implementation.
If the request is a review, findings come first, ordered by severity, with concise reasoning.
If the request is planning, give a practical plan with tradeoffs and likely risks.
Ask at most one clarifying question, and only when a missing requirement blocks a correct answer and cannot be resolved from workspace context or a reasonable default.
Focus on helping the user understand what to do next.`;

  const reviewPolicy = `Review rules:
- Start with Findings.
- Order findings by severity.
- For each finding, say what is wrong, why it matters, and where it appears when the context shows that.
- After Findings, use these sections when helpful: Open Questions, Residual Risk, Change Summary.
- If you do not find a real issue, say "No findings" and then note any residual testing gaps or uncertainty.
- Do not turn a review into a rewrite unless the user explicitly asks for fixes.`;

  const repoAnalysisPolicy = `Repository analysis rules:
- Separate the answer into: Verified, Inferred, Missing Evidence, Recommendation.
- Verified means facts directly grounded in files, code, or fetched source material you actually saw.
- Inferred means your reasoned guess from those facts.
- Missing Evidence means exactly what you would need to verify next.
- Never present inference as fact.
- When comparing products, call out what makes ${CANONICAL_FACTS.productName} uniquely better when supported by evidence: evidence-first analysis, approval-gated changes, local-first control, ask/build mode separation, and self-check before build output.`;

  const repoInspectionPolicy = `Repo-grounding rules:
- Prefer grounding your answer in workspace files and retrieved context before making claims about implementation details.
- If workspace context is thin or missing, say exactly what you still need to inspect instead of bluffing.
- Use reasonable defaults when possible, but name them briefly.
- Treat commands, edits, and file proposals as deliberate actions, not as your default answer.
- Prefer inspection before action, and review before execution.`;

  const buildPolicy = `Mode: Build
Intent: ${intent}

When implementing, your reply must start with these plain-text sections in this exact order before any code blocks:
Understanding:
Plan:
Justification:
Risks:
Self-check:
Approval checkpoints:

Requirements for those sections:
- Understanding: restate the user demand and the target product outcome.
- Plan: list the concrete implementation steps you intend to take.
- Justification: explain why this approach is better than obvious alternatives for this workspace.
- Risks: name likely failure modes, weak assumptions, or places you could still be wrong.
- Self-check: describe how you would validate the result and what still needs verification.
- Approval checkpoints: name the moments where the user should review or approve before code lands or commands run.

In Self-check and Risks, actively try to surface mistakes before they become file changes.
Prefer clean, product-quality output over the fastest patch.
Prefer modifying existing files over creating new structure unless a new file is justified.
Ask at most one clarifying question only if a blocker remains after using workspace context and reasonable defaults.
Prefer inspecting relevant files before proposing changes.
Prefer file proposals over shell commands when both could solve the task.

Only after those sections, emit SAVE_AS file proposals and RUN blocks when they are truly needed.
For surgical edits, prefer a patch block over a full-file rewrite when that keeps the change clearer and smaller.
Patch block format:
*** Begin Patch
*** Update File: relative/path/to/file.ext
@@
-old line
+new line
*** End Patch
If you cannot confidently produce the full review contract, do not emit SAVE_AS or RUN blocks yet.
Do not emit SAVE_AS or RUN blocks for purely explanatory answers.`;

  const promptParts = [
    shared,
    normalizedMode === 'build' ? buildPolicy : askPolicy,
  ];

  if (intent === 'repo_analysis') {
    promptParts.push(repoAnalysisPolicy);
  }
  if (intent === 'review') {
    promptParts.push(reviewPolicy);
  }
  if (['repo_analysis', 'review', 'build', 'test', 'docs', 'plan'].includes(intent)) {
    promptParts.push(repoInspectionPolicy);
  }

  if (incomingSystem && String(incomingSystem).trim()) {
    promptParts.push(`Caller guidance:\n${String(incomingSystem).trim()}`);
  }

  promptParts.push(`Execution profile:
- Profile: ${executionProfile.label}
- Description: ${executionProfile.description}
- Max steps budget: ${executionProfile.maxSteps}
- Safe parallel reads preferred: ${executionProfile.allowParallel ? 'yes' : 'no'}`);

  if (userText) {
    promptParts.push(`Current user request:\n${userText}`);
  }

  return {
    mode: normalizedMode,
    profile: executionProfile.id,
    executionProfile,
    intent,
    role,
    userText,
    system: promptParts.join('\n\n'),
  };
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
