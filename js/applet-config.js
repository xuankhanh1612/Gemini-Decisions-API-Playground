// AI Studio applet build: call the Decisions API from the page.
// Capture the browser's native fetch before _aistudio-iframe.js wraps
// window.fetch and overwrites x-goog-api-key with the sandbox key.
'use strict';
(function () {
  const fn = window.fetch;
  const nativeFetch =
    typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]')
      ? fn.bind(window)
      : null;
  window.DP_CONFIG = {direct: true, modelLabel: 'Gemini Decisions', nativeFetch};
})();
