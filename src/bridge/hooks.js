// What TOMLIN lends the Bridge part once it is running inside it (src/server/bridge.ts sets these). Each is
// null in the tests' stand-alone copy, and the page then leaves out what needs it.
//   nodeBackup: the projects copied to linked PCs (TOMLIN's node backups, src/jobrun/copies.ts)
//     .rows()            -> { [folder lower case]: summary } at once, from the last reading (null before the first)
//     .view()            -> Promise of everything: linked PCs, each ticked project's files and copies
//     .set(dir, on)      -> Promise: "Copy to my nodes" ticked or not
//     .now(pcIds?)       -> Promise: a backup to every linked PC that keeps them (or only those), with transfer ids
//     .progress(ids)     -> [{ id, pc, pcName, state, done, bytes, said }]: how those copies are going
//     .back(dir, pcId)   -> Promise: that project brought back from a PC into "restored projects"
//   pc: () -> { cpuPct, gpu: { pct, engine, adapters, error } }: TOMLIN's own readings of this PC (its top bar),
//     so the This PC panel does not start a second reader of its own
'use strict';
module.exports = { nodeBackup: null, pc: null };
