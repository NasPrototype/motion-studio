export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Tiny element builder: props become properties, except aria*, role, for and dataset. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'dataset') Object.assign(el.dataset, v as object);
    else if (k.startsWith('aria') || k === 'role' || k === 'for') el.setAttribute(k === 'for' ? 'for' : k.replace(/^aria([A-Z])/, (_m, c: string) => `aria-${c.toLowerCase()}`), String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  el.append(...children);
  return el;
}

export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let toastTimer = 0;
/** One-line status message at the bottom of the viewport. */
export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
