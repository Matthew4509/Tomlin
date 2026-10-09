// The app's settings names start TOMLIN_ (TOMLIN_HOME, TOMLIN_PORT, ...). Their earlier names started SHELBY_: one
// still set that way (an older start-up program, a Start with Windows entry, a test copy's settings file) is read as the
// new name, unless the new name is set too. Imported first, before anything reads a setting.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('SHELBY_') && v !== undefined && process.env[`TOMLIN_${k.slice(7)}`] === undefined) process.env[`TOMLIN_${k.slice(7)}`] = v;
}
export {};
