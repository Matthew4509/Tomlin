// The lending PCs whose Max mode stream runs NOT encrypted now (both PCs chose an unencrypted cluster link), by link id.
// Set where the stream opens (src/jobrun/maxhost.ts), read by the PC list (src/jobrun/links.ts): its own module, so the
// two need not import each other.
export const plainNow = new Set<string>();
