/**
 * The sandbox's actual output: which clips survive, and what they become.
 *
 * Auditioning eighty-six clips is only half the job — the other half is
 * remembering the verdict, and turning the survivors into the table the
 * extractor reads. Marks live in localStorage because they are one person's
 * work-in-progress judgements, not repository state; the JSON they export is
 * the part that gets committed.
 *
 * A mark carries two independent things on purpose. `verdict` is triage — is
 * this clip worth anything to us at all. `assign` is the commitment — which
 * motion key it becomes. Keeping a clip without assigning it is a normal
 * intermediate state and the export reports those separately rather than
 * dropping them, because a silent drop is how a decision gets lost.
 */

export type Verdict = 'keep' | 'cut' | 'unsure';

export type Mark = {
  verdict: Verdict;
  /** Motion key this clip should bind to. Only meaningful when kept. */
  assign?: string;
};

export type Marks = Record<string, Mark>;

const STORAGE_KEY = 'mog.sandbox.marks.v1';

export function loadMarks(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Marks) : {};
  } catch {
    return {};
  }
}

export function saveMarks(marks: Marks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // A full or disabled localStorage must not take the sandbox down with it.
  }
}

export type ExportSummary = {
  /** Ready to paste over `content/clipBindings.json`. */
  json: string;
  assigned: number;
  /** Kept but not yet given a motion key — decisions still owed. */
  keptUnassigned: string[];
  cut: number;
  /** Two clips assigned to the same key: the later one would win silently. */
  conflicts: string[];
};

/**
 * Turn marks into the binding table.
 *
 * Only library clips can be exported: procedural motion is generated code, not
 * a clip carved out of a pack, so it has no row here — it is what a key falls
 * back to when this table says nothing.
 */
export function exportBindings(
  marks: Marks,
  entries: readonly { id: string; name: string; library: string | null; origin: string }[],
  libraries: Readonly<Record<string, string>>,
): ExportSummary {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const bindings: Record<string, { library: string; clip: string }> = {};
  const assignedBy = new Map<string, string>();
  const keptUnassigned: string[] = [];
  const conflicts: string[] = [];
  let cut = 0;

  for (const [id, mark] of Object.entries(marks)) {
    if (mark.verdict === 'cut') {
      cut += 1;
      continue;
    }
    if (mark.verdict !== 'keep') continue;

    const entry = byId.get(id);
    if (!entry || entry.origin !== 'library' || !entry.library) continue;

    if (!mark.assign) {
      keptUnassigned.push(id);
      continue;
    }
    const previous = assignedBy.get(mark.assign);
    if (previous) {
      conflicts.push(`${mark.assign}: ${previous} vs ${id}`);
      continue;
    }
    assignedBy.set(mark.assign, id);
    bindings[mark.assign] = { library: entry.library, clip: entry.name };
  }

  const sorted = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));

  return {
    json: `${JSON.stringify(
      {
        note:
          'Which upstream library clip backs each motion key. Decided in the '
          + 'animation sandbox by auditioning clips, not by reading their names — a '
          + 'name is not evidence. Read by tools/animation-extract/extract.mjs to '
          + 'carve dropin GLBs, and by the sandbox to show what is already spoken '
          + 'for. Keys with no entry fall through to procedural motion.',
        libraries,
        bindings: sorted,
      },
      null,
      2,
    )}\n`,
    assigned: Object.keys(sorted).length,
    keptUnassigned: keptUnassigned.sort(),
    cut,
    conflicts,
  };
}
