// A value put in a PowerShell script as a single-quoted string. PowerShell ends such a string at a ' and also at the
// curly single quotes (U+2018, U+2019, U+201A, U+201B), so each of them is written twice, as a ' is: a folder named
// "Don’t" (a curly quote, as Word and phones type it) stays one string, and nothing after it is run as a command.
// The same fault was mended in src/notify.ts, whose words now cross as base64. Tested in test/psquote.test.ts.

/** Every character PowerShell reads as a single quote. */
const SINGLE_QUOTES = /['‘’‚‛]/g;

/** `s` as a PowerShell string in single quotes: each quote character written twice, so it stands for itself. */
export const psQuote = (s: string): string => `'${String(s).replace(SINGLE_QUOTES, m => m + m)}'`;
