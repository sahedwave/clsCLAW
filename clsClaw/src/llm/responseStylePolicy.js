'use strict';

const {
  isCasualGreeting,
  isIdeaRequest,
  normalizeLooseText,
} = require('./conversationRouter');

function classifyResponseStyle({ lane = '', intent = 'chat', userText = '' } = {}) {
  if (lane === 'plain_chat') {
    return isCasualGreeting(userText) ? 'casual' : 'plain';
  }
  if (lane === 'brainstorm') return 'brainstorm';
  if (lane === 'operation') {
    if (intent === 'review') return 'review';
    if (intent === 'test') return 'verification';
    return 'coding';
  }
  return 'analysis';
}

function shouldUseLightweightConversationLane({ lane = '', style = '', intent = 'chat', hasImages = false } = {}) {
  if (lane) return lane !== 'operation';
  if (hasImages) return false;
  if (style === 'casual' || style === 'brainstorm' || style === 'plain') return true;
  return intent === 'chat' && style !== 'coding' && style !== 'review' && style !== 'verification';
}

module.exports = {
  classifyResponseStyle,
  shouldUseLightweightConversationLane,
  isCasualGreeting,
  isIdeaRequest,
  normalizeLooseText,
};
