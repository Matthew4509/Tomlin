// A PDF's text read in a thread of its own (src/docs.ts pdfPages starts it, with a memory limit and a time limit):
// what a PDF can make PDF.js do stays in this thread, which is stopped when it goes over. It sends back the pages, or
// the reason it could not read them, once.
import { parentPort, workerData } from 'node:worker_threads';
import { pdfPagesHere } from './docs.ts';

const asked = workerData as { bytes: Uint8Array; columns: boolean };
pdfPagesHere(asked.bytes, asked.columns === true).then(
  pages => parentPort?.postMessage({ pages }),
  e => parentPort?.postMessage({ error: (e as Error)?.message ?? String(e) }),
);
