import type { Branch, EntryKind, LabEntry, LabId } from './types';
import { ENTRIES as aerospace } from './data/aerospace-energy';
import { ENTRIES as chemical } from './data/chemical-materials';
import { ENTRIES as civil } from './data/civil-structural';
import { ENTRIES as electrical } from './data/electrical-computing';
import { ENTRIES as manufacturing } from './data/manufacturing-design';
import { ENTRIES as mechanical } from './data/mechanical';

/** Every reference entry, in a stable order: by primary branch, then kind, then title. */
const KIND_ORDER: Record<EntryKind, number> = { blueprint: 0, procedure: 1, experiment: 2 };

export const ENTRIES: LabEntry[] = [...mechanical, ...aerospace, ...civil, ...chemical, ...electrical, ...manufacturing]
  .sort((a, b) => a.branches[0].localeCompare(b.branches[0]) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));

export const ENTRY_BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

export function countBy<K extends string>(key: (e: LabEntry) => K[]): Map<K, Record<EntryKind | 'total', number>> {
  const out = new Map<K, Record<EntryKind | 'total', number>>();
  for (const e of ENTRIES) for (const k of key(e)) {
    const c = out.get(k) ?? { blueprint: 0, procedure: 0, experiment: 0, total: 0 };
    c[e.kind]++; c.total++;
    out.set(k, c);
  }
  return out;
}

export const BRANCH_COUNTS = countBy<Branch>((e) => e.branches);
export const LAB_COUNTS = countBy<LabId>((e) => e.labs ?? []);
