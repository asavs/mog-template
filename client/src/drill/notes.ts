/**
 * What we decided about each step, and why.
 *
 * The drill room exists to refine, and refining that leaves no trace is
 * watching. A note is keyed to a step rather than to a clip on purpose: the
 * complaint is almost never "this animation is bad", it is "this animation at
 * this width over this gait does not read" — which is a property of the
 * combination, and a clip-keyed note could not express it.
 *
 * Keyed by label rather than by index so reordering a routine, or inserting a
 * step into the middle of one, does not silently reattach every note to its
 * neighbour. `drills.test.ts` holds labels unique for this reason.
 *
 * Notes live in localStorage because they are one person's working judgement
 * mid-pass. The markdown they export is the part worth keeping.
 */

export type StepVerdict = 'good' | 'needs-work';

export type StepNote = {
  verdict?: StepVerdict;
  text?: string;
};

/** `warrior-sword-shield/combo 1` */
export type NoteKey = string;

export type Notes = Record<NoteKey, StepNote>;

const STORAGE_KEY = 'mog.drill.notes.v1';

export function noteKey(drillId: string, stepLabel: string): NoteKey {
  return `${drillId}/${stepLabel}`;
}

export function loadNotes(): Notes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Notes) : {};
  } catch {
    return {};
  }
}

export function saveNotes(notes: Notes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // A full or disabled localStorage must not take the room down with it.
  }
}

/** Drop a note that has been emptied, rather than storing a blank one. */
export function withNote(notes: Notes, key: NoteKey, note: StepNote): Notes {
  const next = { ...notes };
  if (!note.verdict && !note.text?.trim()) delete next[key];
  else next[key] = note;
  return next;
}

export type DrillStepSummary = {
  label: string;
  /** What the step actually ran, so a report stands on its own. */
  combination: string;
};

/**
 * Notes as markdown, ordered by the routine rather than by the note store.
 *
 * Ordered that way because a report is read against the drill: "step 9" has to
 * mean the ninth thing that happened. Steps with nothing said about them are
 * listed too — a routine where two thirds were never looked at should say so
 * rather than presenting the third that was as the whole picture.
 */
export function exportNotes(
  drillId: string,
  drillLabel: string,
  steps: readonly DrillStepSummary[],
  notes: Notes,
): string {
  const lines = [`# ${drillLabel}`, ''];
  let written = 0;

  steps.forEach((step, index) => {
    const note = notes[noteKey(drillId, step.label)];
    const mark = note?.verdict === 'good' ? 'ok' : note?.verdict === 'needs-work' ? 'FIX' : '—';
    lines.push(`${index + 1}. **${step.label}** [${mark}]`);
    lines.push(`   \`${step.combination}\``);
    if (note?.text?.trim()) lines.push(`   ${note.text.trim()}`);
    if (note) written += 1;
  });

  lines.push('', `${written} of ${steps.length} steps have a verdict.`);
  return `${lines.join('\n')}\n`;
}
