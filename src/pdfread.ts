// A PDF's text read in a thread of its own (src/docs.ts pdfPages starts it, with a memory limit and a time limit):
// what a PDF can make PDF.js do stays in this thread, which is stopped when it goes over. It sends back the pages, or
// the reason it could not read them, once; asked for pictures, it first sends each pictures-only page's picture as it
// is found (its pixels handed over, not copied).
import { parentPort, workerData } from 'node:worker_threads';
import { pdfPagesHere } from './docs.ts';

const asked = workerData as { bytes: Uint8Array; columns: boolean; pictures?: boolean };
pdfPagesHere(asked.bytes, asked.columns === true, asked.pictures === true ? (page, p) => parentPort?.postMessage({ picture: { page, ...p } }, [p.data.buffer as ArrayBuffer]) : undefined).then(
  pages => parentPort?.postMessage({ pages }),
  e => parentPort?.postMessage({ error: (e as Error)?.message ?? String(e) }),
);
