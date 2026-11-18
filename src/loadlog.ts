// Who made this PC load a chat model: the last few loads, each with the one that asked (a linked PC by name and link, a
// job, or this PC's own owner) and, when the file differs from the one asked for, both. A benchmark on a node read an
// unexplained second load as a spoiled run (10 Nov); this says who caused it. Shown in the hello's runner part.

export interface LoadLine { at: string; line: string; model?: string }

/** Whose work a load is: from the meter's scope (forPc is set for work a linked PC sent), else this PC's owner. */
export function askerWords(sc: { forPc?: string; forLink?: string; forProject?: string } | undefined): string {
  if (!sc?.forPc) return 'its own owner';
  return `linked PC "${sc.forPc}"${sc.forLink ? ` (link ${sc.forLink.slice(0, 8)})` : ''}${sc.forProject ? `, for ${sc.forProject}` : ''}`;
}

export class LoadLog {
  private rows: LoadLine[] = [];
  private readonly max: number;
  constructor(max = 20) {
    this.max = max;
  }
  /** `wanted`: the file the asker named, when what loaded is another one. */
  add(o: { model: string; asker: string; wanted?: string }): void {
    const line = `Loaded ${o.model}${o.wanted && o.wanted !== o.model ? ` (asked for ${o.wanted}, not on this PC)` : ''} for ${o.asker}.`;
    this.rows.push({ at: new Date().toISOString(), line, model: o.model });
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max);
  }
  recent(n = 5): LoadLine[] {
    return this.rows.slice(-n);
  }
}

/** This PC's own log. */
export const loads = new LoadLog();
