// Starts the page once every other file has loaded: view, theme, the 5 s status refresh, and the first list.
'use strict';

setView(view);
setTheme(pref.get('theme', 'orbital'));
// Every 5 s: the bottom bar, and the list again when a live check has finished, or a running copy or a project port
// changed (a copy crashed, another program started on a port), since the last look.
let liveRevSeen = null, rowsRevSeen = null;
setInterval(async () => { try { stats = await api('/api/stats'); renderStatus(); if (loaded && (stats.liveRev !== liveRevSeen || stats.rowsRev !== rowsRevSeen)) load(); } catch {} }, 5000);
show(location.hash.slice(1) || 'projects');
load();
loadPrompts(); // fills the Prompts count in the nav pane
loadGitProgram(); // the Git program's version (asks the internet only if About › Git is ticked)
