// The calls the Bridge makes to the operating system, picked once for this computer.
// windows.js is complete; other systems get unsupported.js until their own file is written (same functions).
'use strict';
module.exports = process.platform === 'win32' ? require('./windows') : require('./unsupported');
