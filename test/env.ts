// The settings a test gives the copy of TOMLIN it starts: the shell's own TOMLIN_ settings are dropped first, so a
// TOMLIN_DATA (or any other) set in the shell running the tests never points the copy at another folder than its home.
export function testEnv(set: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^TOMLIN_/.test(k)) delete env[k];
  // A test's copy never looks at this PC's screen, keys or graphics card (src/pcbusy.ts): the person at it is not the test's.
  return Object.assign(env, { TOMLIN_NO_PCLOOK: '1' }, set);
}

/** The same for a test that runs TOMLIN in its own process: this process's TOMLIN_ settings are replaced by `set`. */
export function useTestEnv(set: Record<string, string>): void {
  for (const k of Object.keys(process.env)) if (/^TOMLIN_/.test(k)) delete process.env[k];
  Object.assign(process.env, set);
}
