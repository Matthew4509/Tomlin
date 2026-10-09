// The Bridge part on a server of its own, for the tests only (TOMLIN itself runs it in its own process and
// hands it /bridge/ requests). Set BRIDGE_PORT, BRIDGE_DATA and BRIDGE_ROOT; --dry-run opens nothing.
'use strict';
require('../../src/bridge/app').start();
