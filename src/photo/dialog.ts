import { h } from '../ui/dom';
import type { Project } from '../sim/project';
import { PART_TYPES } from '../sim/library';
import { normalizeDraft, type TwinDraft } from './types';
import { draftToProject } from './toProject';
import { SAMPLE_DRAFT, SAMPLE_SVG } from './sample';

interface Photo {
  src: string;
  mediaType: string;
  data: string;
  name: string;
}

const MAX_PHOTOS = 4;
const MAX_EDGE = 1568;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not an image the browser can read.'));
    img.src = src;
  });
}

/** Downscale to at most 1568 px on the long edge and re-encode as JPEG, which keeps requests small. */
async function prepare(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const src = c.toDataURL('image/jpeg', 0.86);
    return { src, mediaType: 'image/jpeg', data: src.split(',')[1], name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function openPhotoDialog(onCreate: (p: Project, notes: string[]) => void): void {
  const dlg = h('dialog', { className: 'dlg dlg-wide', ariaLabel: 'Photo to twin' });
  document.body.append(dlg);
  let photos: Photo[] = [];
  let note = '';
  let draft: TwinDraft | null = null;
  let answers: Record<string, number | undefined> = {};
  let shown = 0;
  let focus: string | null = null;
  let abort: AbortController | null = null;
  let isSample = false;
  let error = '';
  let health = 'checking';

  const close = () => { abort?.abort(); dlg.close(); };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('cancel', () => abort?.abort());

  const header = (step: number) => {
    dlg.classList.toggle('dlg-tall', step === 2);
    const steps = ['Photos', 'Analysis', 'Review', 'Create'];
    return h('header', { className: 'dlg-head' },
      h('h2', { textContent: 'Photo to twin' }),
      h('ol', { className: 'stepper', ariaLabel: 'Progress' }, ...steps.map((s, i) => h('li', { dataset: { state: i < step ? 'done' : i === step ? 'current' : 'todo' }, ...(i === step ? { ariaCurrent: 'step' } : {}) }, s))),
      h('button', { className: 'icon-btn', ariaLabel: 'Close', onclick: close, innerHTML: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>' }),
    );
  };

  // ------------------------------------------------------------------ capture
  const renderCapture = () => {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, className: 'sr-only', id: 'ptt-files' });
    const add = async (files: FileList | File[]) => {
      error = '';
      for (const f of Array.from(files)) {
        if (photos.length >= MAX_PHOTOS) { error = `Use at most ${MAX_PHOTOS} photos.`; break; }
        if (!f.type.startsWith('image/')) { error = `${f.name} is not an image.`; continue; }
        try { photos.push(await prepare(f)); } catch (e) { error = (e as Error).message; }
      }
      renderCapture();
    };
    input.addEventListener('change', () => { if (input.files) void add(input.files); });
    const drop = h('label', { className: 'dropzone', for: 'ptt-files' },
      h('strong', { textContent: 'Drop up to four photos of the build, or choose files' }),
      h('span', { textContent: 'Shoot from above and from an angle, in even light. A printed calibration card in frame helps with scale.' }));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = 'true'; });
    drop.addEventListener('dragleave', () => { drop.dataset.over = 'false'; });
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.dataset.over = 'false'; if (e.dataTransfer?.files) void add(e.dataTransfer.files); });

    const thumbs = h('div', { className: 'thumbs' }, ...photos.map((p, i) => h('figure', { className: 'thumb' },
      h('img', { src: p.src, alt: p.name }),
      h('button', { className: 'thumb-x', ariaLabel: `Remove ${p.name}`, textContent: '×', onclick: () => { photos.splice(i, 1); renderCapture(); } }))));
    const noteBox = h('textarea', { id: 'ptt-note', rows: 2, placeholder: 'Optional: what is it, and anything not visible (e.g. "9 V battery, R2 is under the chip")', value: note });
    noteBox.addEventListener('input', () => { note = noteBox.value; });
    const statusText = health === 'ready' ? 'The server has an Anthropic API key; photos are sent to Claude for analysis.'
      : health === 'unconfigured' ? 'No ANTHROPIC_API_KEY on the server. Analysis will fail until one is set, but the sample works.'
      : health === 'offline' ? 'The Studio server API is not reachable. Run the app with npm run dev or npm run serve.' : 'Checking the server…';

    dlg.replaceChildren(header(0), h('div', { className: 'dlg-body dlg-pad' },
      input, drop, photos.length ? thumbs : '',
      h('label', { for: 'ptt-note', className: 'field-label', textContent: 'Notes for Claude' }), noteBox,
      h('p', { className: 'muted small', textContent: statusText }),
      error ? h('p', { className: 'form-error', role: 'alert', textContent: error }) : '',
    ), h('footer', { className: 'dlg-foot' },
      h('button', { className: 'btn-outline', textContent: 'Use the sample breadboard', onclick: () => { isSample = true; draft = SAMPLE_DRAFT; photos = [{ src: `data:image/svg+xml;utf8,${encodeURIComponent(SAMPLE_SVG)}`, mediaType: 'image/svg+xml', data: '', name: 'Sample breadboard' }]; answers = {}; renderReview(); } }),
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn-primary', textContent: 'Analyze with Claude', disabled: !photos.length, onclick: () => void analyze() }),
    ));
  };

  const analyze = async () => {
    error = '';
    isSample = false;
    abort = new AbortController();
    const started = Date.now();
    const tick = h('span', { className: 'mono' });
    const timer = window.setInterval(() => { tick.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 500);
    dlg.replaceChildren(header(1), h('div', { className: 'dlg-body dlg-pad analyzing', role: 'status' },
      h('div', { className: 'spinner', ariaHidden: 'true' }),
      h('p', {}, `Claude is reading ${photos.length} photo${photos.length > 1 ? 's' : ''}. This usually takes 20 to 90 seconds. `, tick),
    ), h('footer', { className: 'dlg-foot' }, h('span', { className: 'spacer' }), h('button', { className: 'btn-outline', textContent: 'Cancel', onclick: () => abort?.abort() })));
    try {
      const res = await fetch('/api/photo-to-twin', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ images: photos.map((p) => ({ mediaType: p.mediaType, data: p.data })), note }),
      });
      const body = (await res.json().catch(() => ({}))) as { draft?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
      draft = normalizeDraft(body.draft);
      answers = {};
      if (!draft.parts.length) throw new Error('Claude found no parts it could map to the library. Try clearer photos or add a note.');
      renderReview();
    } catch (e) {
      error = (e as Error).name === 'AbortError' ? 'Analysis cancelled.' : (e as Error).message;
      renderCapture();
    } finally {
      window.clearInterval(timer);
      abort = null;
    }
  };

  // ------------------------------------------------------------------ review
  const renderReview = () => {
    if (!draft) return;
    const d = draft;
    const asked = new Set(d.questions.map((q) => q.ref));
    const open = d.questions.filter((q) => answers[q.id] === undefined).length;
    const img = h('img', { src: photos[shown]?.src ?? '', alt: `Photo ${shown + 1}` });
    const overlay = h('div', { className: 'boxes' });
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const items = [
      ...d.parts.map((p) => ({ key: p.ref, label: `${p.ref} · ${p.label} · ${p.confidence.toFixed(2)}`, box: p.box, photo: p.photo, review: asked.has(p.ref) || p.confidence < 0.75 })),
      ...d.unsupported.map((u, i) => ({ key: `u${i}`, label: `${u.label} · not simulated`, box: u.box, photo: u.photo, review: false })),
    ].filter((x) => x.photo === shown || (x.photo >= photos.length && shown === 0));
    for (const it of items) {
      const r = document.createElementNS(svgNs, 'rect');
      r.setAttribute('x', String(it.box.x)); r.setAttribute('y', String(it.box.y));
      r.setAttribute('width', String(it.box.w)); r.setAttribute('height', String(it.box.h));
      r.setAttribute('class', `bx ${it.review ? 'bx-review' : 'bx-ok'}${focus === it.key ? ' bx-focus' : ''}`);
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(r);
      overlay.append(h('span', { className: `bx-tag${it.review ? ' bx-tag-review' : ''}`, style: `left:${pct(it.box.x)};top:${pct(it.box.y)}`, textContent: it.label }));
    }
    const viewer = h('div', { className: 'viewer' }, h('div', { className: 'photo-wrap' }, img, svg, overlay),
      photos.length > 1 ? h('div', { className: 'thumbs thumbs-small' }, ...photos.map((p, i) => h('button', { className: 'thumb', ariaPressed: String(i === shown), ariaLabel: `Show photo ${i + 1}`, onclick: () => { shown = i; renderReview(); } }, h('img', { src: p.src, alt: '' })))) : '',
      isSample ? h('p', { className: 'muted small', textContent: 'Sample result: an illustrated breadboard with a canned draft. No API call was made.' }) : '');

    const questions = d.questions.map((q, i) => h('div', { className: 'q-card' },
      h('div', { className: 'q-head' }, h('span', { className: 'q-num', textContent: String(i + 1) }), h('strong', { textContent: q.ref ? `${q.ref} · ` : '' }), q.param ? `sets ${q.param}` : 'wiring check'),
      h('p', { textContent: q.text }),
      h('div', { className: 'q-opts', role: 'group', ariaLabel: q.text }, ...q.options.map((o) => h('button', {
        className: 'btn-outline btn-small', ariaPressed: String(answers[q.id] === o.value), textContent: o.label,
        onclick: () => { answers[q.id] = o.value; renderReview(); },
      }))),
    ));
    const partsList = h('div', { className: 'conf-list' }, ...[...d.parts].sort((a, b) => b.confidence - a.confidence).map((p) => {
      const review = asked.has(p.ref) || p.confidence < 0.75;
      const row = h('button', { className: `conf-row${review ? ' review' : ''}`, ariaPressed: String(focus === p.ref), onclick: () => { focus = focus === p.ref ? null : p.ref; shown = Math.min(p.photo, photos.length - 1); renderReview(); } },
        h('span', { className: 'mono', textContent: p.ref }),
        h('span', { className: 'conf-label', textContent: `${PART_TYPES.get(p.type)?.name ?? p.type} · ${p.label}` }),
        h('span', { className: 'bar' }, h('span', { style: `width:${Math.round(p.confidence * 100)}%` })),
        h('span', { className: 'mono', textContent: p.confidence.toFixed(2) }));
      row.title = p.evidence;
      return row;
    }));

    const panel = h('div', { className: 'review-panel' },
      h('p', { className: 'review-summary', textContent: d.summary }),
      h('div', { className: 'counts' },
        h('span', {}, h('b', { className: 'mono', textContent: String(d.parts.length) }), ' parts'),
        h('span', {}, h('b', { className: 'mono', textContent: String(d.connections.length) }), ' connections'),
        h('span', { className: open ? 'warn' : '' }, h('b', { className: 'mono', textContent: String(open) }), ' need you')),
      ...(questions.length ? [h('div', { className: 'sec-label', textContent: 'Questions' }), ...questions] : []),
      h('div', { className: 'sec-label', textContent: 'Recognized parts' }), partsList,
      ...(d.unsupported.length ? [h('div', { className: 'sec-label', textContent: 'Seen but not simulated' }), h('ul', { className: 'plain' }, ...d.unsupported.map((u) => h('li', { textContent: `${u.label}: ${u.note}` })))] : []),
      ...(d.warnings.length ? [h('div', { className: 'sec-label', textContent: 'Notes from Claude' }), h('ul', { className: 'plain' }, ...d.warnings.map((w) => h('li', { textContent: w })))] : []),
    );

    const create = (assume: boolean) => {
      if (!assume && open) return;
      const { project, notes } = draftToProject(d, answers, isSample ? 'Breadboard blinker (from photo)' : `Photo twin ${new Date().toLocaleString()}`);
      onCreate(project, notes);
      close();
    };
    dlg.replaceChildren(header(2), h('div', { className: 'dlg-body review' }, viewer, panel), h('footer', { className: 'dlg-foot' },
      h('button', { className: 'btn-outline', textContent: 'Back to photos', onclick: () => { draft = null; renderCapture(); } }),
      h('span', { className: 'spacer' }),
      open ? h('span', { className: 'muted small', textContent: `Answer ${open} question${open > 1 ? 's' : ''} to create the twin without assumptions.` }) : '',
      open ? h('button', { className: 'btn-outline', textContent: `Create with ${open} assumption${open > 1 ? 's' : ''}`, onclick: () => create(true) }) : '',
      h('button', { className: 'btn-primary', textContent: 'Create twin', disabled: open > 0, onclick: () => create(false) }),
    ));
  };

  dlg.showModal();
  renderCapture();
  fetch('/api/health').then((r) => r.json()).then((b: { photoToTwin?: string }) => { health = b.photoToTwin ?? 'unconfigured'; }).catch(() => { health = 'offline'; }).finally(() => { if (!draft && dlg.open && !abort) renderCapture(); });
}
