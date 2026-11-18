// The JSON a request body is read with. A key named toString, valueOf or toJSON would make String(b.field) throw in any
// route that reads that field (the API fuzzer found it at /api/names), and they mean nothing in what the page sends: dropped.
export function parseBody(text: string): unknown {
  return JSON.parse(text, (k, x: unknown) => (k === 'toString' || k === 'valueOf' || k === 'toJSON' ? undefined : x));
}
