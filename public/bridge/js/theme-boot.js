// Puts the remembered theme on before the page draws (loaded in <head>, so there is no flash of the wrong one).
(function () {
  var t = 'orbital';
  try { var s = localStorage.getItem('bridge.theme'); if (s) t = s; } catch (e) {}
  if (t === 'light' || t === 'dark' || t === 'orbital') document.documentElement.setAttribute('data-theme', t);
})();
