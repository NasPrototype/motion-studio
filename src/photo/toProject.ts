import { PART_TYPES } from '../sim/library';
import { type Connection, type PartInstance, type Project, wireError } from '../sim/project';
import type { TwinDraft } from './types';

export interface DraftResult {
  project: Project;
  notes: string[];
}

/**
 * Turn a reviewed draft into an editable circuit. `answers` maps question id to the chosen value
 * (or undefined to fall back to the first option, recorded as an assumption).
 */
export function draftToProject(draft: TwinDraft, answers: Record<string, number | undefined>, name: string): DraftResult {
  const notes: string[] = [];
  const parts: PartInstance[] = draft.parts.map((p) => ({
    id: p.ref, type: p.type, rot: 0,
    pos: [(p.box.x + p.box.w / 2 - 0.5) * 36, (p.box.y + p.box.h / 2 - 0.5) * 24],
    params: Object.fromEntries(p.params.map((x) => [x.key, x.value])),
  }));

  for (const q of draft.questions) {
    const chosen = answers[q.id];
    const value = chosen ?? q.options[0]?.value;
    if (chosen === undefined) notes.push(`Assumed "${q.options[0]?.label}" for: ${q.text}`);
    if (!q.param) {
      if (value === 0) notes.push(`${q.ref}: ${q.text} Answered "${q.options.find((o) => o.value === 0)?.label ?? 'no'}"; the simulation keeps its usual assumption.`);
      continue;
    }
    const part = parts.find((p) => p.id === q.ref);
    if (part && value !== undefined) part.params[q.param] = value;
  }

  const project: Project = { version: 1, id: `photo-${Date.now().toString(36)}`, name, parts, wires: [] };
  if (!parts.some((p) => p.type === 'ground') && parts.some((p) => p.type === 'battery')) {
    const b = parts.find((p) => p.type === 'battery')!;
    parts.push({ id: 'GND1', type: 'ground', pos: [b.pos[0], b.pos[1] + 5], rot: 0, params: {} });
    draft = { ...draft, connections: [...draft.connections, { a: { ref: b.id, port: 'n' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.5 }] };
    notes.push(`Added GND1 at ${b.id}'s negative terminal so voltages have a reference.`);
  }

  spread(parts);

  let n = 1;
  for (const c of draft.connections) {
    const a = { part: c.a.ref, port: c.a.port }, b = { part: c.b.ref, port: c.b.port };
    const err = wireError(project, a, b);
    if (err) { if (!/already connected/.test(err)) notes.push(`Skipped ${c.a.ref}.${c.a.port} – ${c.b.ref}.${c.b.port}: ${err}`); continue; }
    project.wires.push({ id: `w${n++}`, a, b } satisfies Connection);
  }
  return { project, notes };
}

/** Push overlapping parts apart so every footprint is clear, keeping the photo's layout. */
function spread(parts: PartInstance[]): void {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j];
        const need = (PART_TYPES.get(a.type)?.footprint ?? 2) + (PART_TYPES.get(b.type)?.footprint ?? 2) + 0.6;
        let dx = b.pos[0] - a.pos[0], dz = b.pos[1] - a.pos[1];
        const d = Math.hypot(dx, dz);
        if (d >= need) continue;
        if (d < 1e-6) { dx = 1; dz = 0.3; }
        const k = (need - d) / 2 / Math.max(d, 1e-6);
        a.pos = [a.pos[0] - dx * k, a.pos[1] - dz * k];
        b.pos = [b.pos[0] + dx * k, b.pos[1] + dz * k];
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const p of parts) p.pos = [Math.round(p.pos[0] * 2) / 2, Math.round(p.pos[1] * 2) / 2];
}
