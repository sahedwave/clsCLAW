(function () {
  const state = {
    currentView: 'chat',
    chatMode: localStorage.getItem('cx4_chat_mode') === 'build' ? 'build' : 'ask',
    executionProfile: ['quick', 'deliberate', 'execute', 'parallel'].includes(localStorage.getItem('cx4_execution_profile'))
      ? localStorage.getItem('cx4_execution_profile')
      : 'deliberate',
  };

  function get(key) {
    return state[key];
  }

  function set(key, value) {
    state[key] = value;
    return value;
  }

  function snapshot() {
    return { ...state };
  }

  window.clsClawStateStore = {
    get,
    set,
    snapshot,
  };
})();
