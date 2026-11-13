import { LIBRARY } from '../sim/library';

/** What Claude returns for a set of photos: a draft the user reviews before it becomes a circuit. */
export interface Box { x: number; y: number; w: number; h: number }

export interface DraftPart {
  ref: string;
  type: string;
  label: string;
  params: { key: string; value: number }[];
  confidence: number;
  photo: number;
  box: Box;
  evidence: string;
}

export interface DraftConnection {
  a: { ref: string; port: string };
  b: { ref: string; port: string };
  confidence: number;
}

export interface DraftQuestion {
  id: string;
  ref: string;
  text: string;
  /** Parameter the answer sets on `ref`; empty when the answer only informs the review. */
  param: string;
  options: { label: string; value: number }[];
}

export interface TwinDraft {
  summary: string;
  parts: DraftPart[];
  connections: DraftConnection[];
  questions: DraftQuestion[];
  unsupported: { label: string; photo: number; box: Box; note: string }[];
  warnings: string[];
}

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const box = { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: { x: num, y: num, w: num, h: num } };
const portRef = { type: 'object', additionalProperties: false, required: ['ref', 'port'], properties: { ref: str, port: str } };

/** JSON schema for structured output. Kept to plain objects, arrays, enums and required fields. */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'parts', 'connections', 'questions', 'unsupported', 'warnings'],
  properties: {
    summary: str,
    parts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['ref', 'type', 'label', 'params', 'confidence', 'photo', 'box', 'evidence'],
        properties: {
          ref: str,
          type: { type: 'string', enum: LIBRARY.map((t) => t.type) },
          label: str,
          params: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: str, value: num } } },
          confidence: num,
          photo: { type: 'integer' },
          box,
          evidence: str,
        },
      },
    },
    connections: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['a', 'b', 'confidence'], properties: { a: portRef, b: portRef, confidence: num } },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'ref', 'text', 'param', 'options'],
        properties: {
          id: str, ref: str, text: str, param: str,
          options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: str, value: num } } },
        },
      },
    },
    unsupported: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label', 'photo', 'box', 'note'], properties: { label: str, photo: { type: 'integer' }, box, note: str } },
    },
    warnings: { type: 'array', items: str },
  },
} as const;

const clamp01 = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));
const asBox = (b: unknown): Box => {
  const o = (b ?? {}) as Record<string, unknown>;
  const x = clamp01(o.x), y = clamp01(o.y);
  return { x, y, w: Math.min(1 - x, clamp01(o.w)), h: Math.min(1 - y, clamp01(o.h)) };
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Defensive normalisation of a draft from the network: unknown types dropped, numbers clamped. */
export function normalizeDraft(raw: unknown): TwinDraft {
  const o = (raw ?? {}) as Record<string, unknown>;
  const types = new Set(LIBRARY.map((t) => t.type));
  const parts: DraftPart[] = arr(o.parts).flatMap((p) => {
    const q = p as Record<string, unknown>;
    if (!types.has(text(q.type)) || !text(q.ref)) return [];
    return [{
      ref: text(q.ref).slice(0, 12), type: text(q.type), label: text(q.label), evidence: text(q.evidence),
      params: arr(q.params).flatMap((x) => {
        const r = x as Record<string, unknown>;
        return text(r.key) && Number.isFinite(Number(r.value)) ? [{ key: text(r.key), value: Number(r.value) }] : [];
      }),
      confidence: clamp01(q.confidence), photo: Math.max(0, Math.floor(Number(q.photo) || 0)), box: asBox(q.box),
    }];
  });
  const refs = new Set(parts.map((p) => p.ref));
  const portOf = (v: unknown) => { const r = (v ?? {}) as Record<string, unknown>; return { ref: text(r.ref), port: text(r.port) }; };
  return {
    summary: text(o.summary),
    parts,
    connections: arr(o.connections).flatMap((c) => {
      const q = c as Record<string, unknown>;
      const a = portOf(q.a), b = portOf(q.b);
      return refs.has(a.ref) && refs.has(b.ref) ? [{ a, b, confidence: clamp01(q.confidence) }] : [];
    }),
    questions: arr(o.questions).flatMap((x, i) => {
      const q = x as Record<string, unknown>;
      const options = arr(q.options).flatMap((y) => {
        const r = y as Record<string, unknown>;
        return text(r.label) && Number.isFinite(Number(r.value)) ? [{ label: text(r.label), value: Number(r.value) }] : [];
      });
      return options.length ? [{ id: text(q.id) || `q${i + 1}`, ref: text(q.ref), text: text(q.text), param: text(q.param), options }] : [];
    }),
    unsupported: arr(o.unsupported).map((x) => {
      const q = x as Record<string, unknown>;
      return { label: text(q.label), photo: Math.max(0, Math.floor(Number(q.photo) || 0)), box: asBox(q.box), note: text(q.note) };
    }),
    warnings: arr(o.warnings).map(text).filter(Boolean),
  };
}
