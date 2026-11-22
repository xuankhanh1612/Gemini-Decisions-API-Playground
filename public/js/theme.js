// Applies the saved or system theme before first paint, so dark mode
// doesn't flash light. Kept separate because the CSP forbids inline scripts.
'use strict';
(function () {
  let theme = null;
  try {
    theme = JSON.parse(window.localStorage.getItem('dp.theme'));
  } catch (e) {
    // Storage may be blocked; fall back to the system preference.
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
})();
