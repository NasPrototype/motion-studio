import { download, h, storage, toast } from '../ui/dom';
import { SCENES } from '../sim/scenes';
import { BENCHES, BENCH_BY_ID, type Bench, type BenchOutcome, defaults } from './benches';
import { chartCsv, drawChart } from './chart';
import { BRANCHES, FACILITIES } from './facilities';
import { BRANCH_COUNTS, ENTRIES, ENTRY_BY_ID, LAB_COUNTS } from './index';
import type { Branch, EntryKind, LabEntry, LabId } from './types';

type Tab = 'library' | 'benches' | 'branches' | 'facilities' | 'log';

interface LogRow {
  at: string;
  bench: string;
  title: string;
  inputs: Record<string, number>;
  record: Record<string, string>;
  verdict?: string;
  pass?: boolean;
}

interface UiState {
  tab: Tab;
  q: string;
  kind: EntryKind | 'all';
  branch: Branch | 'all';
  lab: LabId | 'all';
  entry: string | null;
  bench: string;
}

const STATE_KEY = 'ms-lab-ui';
const LOG_KEY = 'ms-lab-log';
const MAX_LOG = 500;

const KIND_LABEL: Record<EntryKind, string> = { blueprint: 'Blueprint', procedure: 'Test procedure', experiment: 'Experiment' };
const BRANCH_NAME = new Map(BRANCHES.map((b) => [b.id, b.name]));
const LAB_NAME = new Map(FACILITIES.map((f) => [f.id, f.name]));

/** Benches that teaching labs typically run, for the facility cards. */
const LAB_BENCHES: Partial<Record<LabId, string[]>> = {
  'material-testing': ['bench-tensile', 'bench-charpy', 'bench-fatigue', 'bench-hardness'],
  'applied-mechanics': ['bench-tensile', 'bench-torsion', 'bench-spring', 'bench-hardness'],
  'fluid-mechanics': ['bench-pipe-friction', 'bench-venturi', 'bench-reynolds'],
  'thermo-heat-transfer': ['bench-heat-exchanger', 'bench-bomb-calorimeter'],
  'ic-engine': ['bench-morse', 'bench-bomb-calorimeter'],
  'thermal-power': ['bench-bomb-calorimeter', 'bench-heat-exchanger', 'bench-hotfire'],
  'dynamics-of-machines': ['bench-shake-table', 'bench-fft'],
  metrology: ['bench-fft', 'bench-hardness'],
  'ac-refrigeration': ['bench-heat-exchanger'],
  'adv-manufacturing': ['bench-emc'],
  'design-practice-2': ['bench-fatigue', 'bench-spring'],
};

function isScene(id: string): boolean { return SCENES.some((s) => s.id === id); }

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function entryMarkdown(e: LabEntry): string {
  const lines = [`# ${e.title}`, '', `*${KIND_LABEL[e.kind]} · ${e.branches.map((b) => BRANCH_NAME.get(b) ?? b).join(', ')}*`, '', e.summary, ''];
  if (e.objective) lines.push(`**Objective.** ${e.objective}`, '');
  const list = (title: string, items?: string[], ordered = false) => {
    if (!items?.length) return;
    lines.push(`## ${title}`, '', ...items.map((x, i) => `${ordered ? `${i + 1}.` : '-'} ${x}`), '');
  };
  list('Equipment', e.equipment);
  list(e.kind === 'blueprint' ? 'Design steps' : 'Procedure', e.steps, true);
  list(e.kind === 'blueprint' ? 'Design parameters' : 'Measurements', e.measurements);
  if (e.equations?.length) lines.push('## Equations', '', ...e.equations.map((q) => `- ${q.label}: \`${q.text}\``), '');
  list('Standards', e.standards);
  list('Safety', e.safety);
  list('Deliverables', e.outputs);
  return lines.join('\n');
}

export function openLab(opts: { openScene(id: string): void }): void {
  const saved = storage.get<Partial<UiState>>(STATE_KEY, {});
  const st: UiState = { tab: 'library', q: '', kind: 'all', branch: 'all', lab: 'all', entry: null, bench: BENCHES[0].id, ...saved };
  if (!BENCH_BY_ID.has(st.bench)) st.bench = BENCHES[0].id;
  let log = storage.get<LogRow[]>(LOG_KEY, []);
  const benchValues = new Map<string, Record<string, number>>();
  const lastRun = new Map<string, BenchOutcome>();
  let resize: ResizeObserver | null = null;

  const dlg = h('dialog', { className: 'dlg dlg-wide dlg-tall lab', ariaLabel: 'Lab and reference library' });
  document.body.append(dlg);
  const body = h('div', { className: 'dlg-body lab-body' });
  const tabs = h('div', { className: 'tabs', role: 'tablist', ariaLabel: 'Lab sections' });
  const closeBtn = h('button', { className: 'icon-btn', ariaLabel: 'Close lab', innerHTML: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>' });
  dlg.append(h('div', { className: 'dlg-head' }, h('h2', { textContent: 'Lab & Reference' }), tabs, closeBtn), body);

  const save = () => storage.set(STATE_KEY, { ...st });
  const close = () => { resize?.disconnect(); save(); dlg.close(); };
  closeBtn.addEventListener('click', close);
  dlg.addEventListener('close', () => { resize?.disconnect(); dlg.remove(); });

  const TABS: [Tab, string][] = [['library', `Library · ${ENTRIES.length}`], ['benches', `Test benches · ${BENCHES.length}`], ['branches', 'Disciplines · 27'], ['facilities', `Labs · ${FACILITIES.length}`], ['log', 'Test log']];

  function render(): void {
    resize?.disconnect();
    resize = null;
    tabs.replaceChildren(...TABS.map(([id, label]) => {
      const b = h('button', { className: 'tab', role: 'tab', ariaSelected: String(st.tab === id), textContent: id === 'log' ? `${label} · ${log.length}` : label });
      b.addEventListener('click', () => { st.tab = id; save(); render(); });
      return b;
    }));
    if (st.tab === 'library') body.replaceChildren(renderLibrary());
    else if (st.tab === 'benches') body.replaceChildren(renderBenches());
    else if (st.tab === 'branches') body.replaceChildren(renderBranches());
    else if (st.tab === 'facilities') body.replaceChildren(renderFacilities());
    else body.replaceChildren(renderLog());
  }

  // ---------------------------------------------------------------- library

  function filtered(): LabEntry[] {
    const q = st.q.trim().toLowerCase();
    return ENTRIES.filter((e) =>
      (st.kind === 'all' || e.kind === st.kind)
      && (st.branch === 'all' || e.branches.includes(st.branch))
      && (st.lab === 'all' || (e.labs ?? []).includes(st.lab))
      && (!q || [e.title, e.summary, e.objective ?? '', ...(e.tags ?? []), ...e.equipment, ...(e.standards ?? [])].join(' ').toLowerCase().includes(q)));
  }

  function renderLibrary(): HTMLElement {
    const list = h('div', { className: 'lab-list', role: 'list' });
    const detail = h('div', { className: 'lab-detail' });
    const count = h('div', { className: 'muted lab-count' });
    const fillList = () => {
      const items = filtered();
      count.textContent = `${items.length} of ${ENTRIES.length} entries`;
      if (st.entry && !items.some((e) => e.id === st.entry)) st.entry = items[0]?.id ?? null;
      if (!st.entry && items.length) st.entry = items[0].id;
      list.replaceChildren(...items.slice(0, 400).map((e) => {
        const b = h('button', { className: 'lab-item', role: 'listitem', dataset: { kind: e.kind } },
          h('span', { className: 'lab-item-kind', textContent: KIND_LABEL[e.kind] }),
          h('span', { className: 'lab-item-title', textContent: e.title }),
          h('span', { className: 'lab-item-meta', textContent: e.branches.map((x) => BRANCH_NAME.get(x) ?? x).join(' · ') + (e.sim ? ' · ▶ sim' : '') }));
        if (e.id === st.entry) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => { st.entry = e.id; save(); fillList(); fillDetail(); });
        return b;
      }));
      if (!items.length) list.append(h('p', { className: 'muted', style: 'padding: 12px', textContent: 'Nothing matches. Clear a filter or try another word.' }));
    };
    const fillDetail = () => {
      const e = st.entry ? ENTRY_BY_ID.get(st.entry) : undefined;
      detail.replaceChildren(e ? renderEntry(e) : h('p', { className: 'muted', textContent: 'Pick an entry.' }));
      detail.scrollTop = 0;
    };

    const search = h('input', { className: 'text-input', type: 'search', placeholder: 'Search titles, equipment, standards…', value: st.q, ariaLabel: 'Search the library' });
    search.addEventListener('input', () => { st.q = search.value; save(); fillList(); fillDetail(); });
    const kinds = h('div', { className: 'seg-row', role: 'group', ariaLabel: 'Entry kind' }, ...(['all', 'blueprint', 'procedure', 'experiment'] as const).map((k) => {
      const b = h('button', { className: 'seg', ariaPressed: String(st.kind === k), textContent: k === 'all' ? 'All' : k === 'blueprint' ? 'Blueprints' : k === 'procedure' ? 'Tests' : 'Experiments' });
      b.addEventListener('click', () => { st.kind = k; save(); render(); });
      return b;
    }));
    const branchSel = h('select', { className: 'select', ariaLabel: 'Branch' },
      h('option', { value: 'all', textContent: 'All 27 branches' }),
      ...BRANCHES.map((b) => h('option', { value: b.id, textContent: `${b.name} (${BRANCH_COUNTS.get(b.id)?.total ?? 0})` })));
    branchSel.value = st.branch;
    branchSel.addEventListener('change', () => { st.branch = branchSel.value as Branch | 'all'; save(); fillList(); fillDetail(); });
    const labSel = h('select', { className: 'select', ariaLabel: 'Teaching lab' },
      h('option', { value: 'all', textContent: 'All labs and workshops' }),
      ...FACILITIES.map((f) => h('option', { value: f.id, textContent: `${f.name} (${LAB_COUNTS.get(f.id)?.total ?? 0})` })));
    labSel.value = st.lab;
    labSel.addEventListener('change', () => { st.lab = labSel.value as LabId | 'all'; save(); fillList(); fillDetail(); });
    const clear = h('button', { className: 'btn-outline btn-small', textContent: 'Clear filters' });
    clear.addEventListener('click', () => { Object.assign(st, { q: '', kind: 'all', branch: 'all', lab: 'all' }); save(); render(); });

    const filters = h('div', { className: 'lab-filters' },
      search, kinds,
      h('label', { className: 'lab-field' }, h('span', { className: 'sec-label', textContent: 'Branch' }), branchSel),
      h('label', { className: 'lab-field' }, h('span', { className: 'sec-label', textContent: 'Lab or workshop' }), labSel),
      count, clear);
    fillList();
    fillDetail();
    return h('div', { className: 'lab-grid' }, filters, list, detail);
  }

  function renderEntry(e: LabEntry): HTMLElement {
    const sec = (title: string, el: HTMLElement | null) => (el ? h('section', { className: 'lab-sec' }, h('h4', { textContent: title }), el) : null);
    const ul = (items?: string[]) => (items?.length ? h('ul', {}, ...items.map((x) => h('li', { textContent: x }))) : null);
    const ol = (items?: string[]) => (items?.length ? h('ol', {}, ...items.map((x) => h('li', { textContent: x }))) : null);
    const chips = h('div', { className: 'chips' },
      h('span', { className: `chip chip-kind chip-${e.kind}`, textContent: KIND_LABEL[e.kind] }),
      ...e.branches.map((b) => {
        const info = BRANCHES.find((x) => x.id === b);
        return h('a', { className: 'chip', href: info?.url ?? '#', target: '_blank', rel: 'noopener noreferrer', title: 'Open the Wikipedia article', textContent: info?.name ?? b });
      }),
      ...(e.labs ?? []).map((l) => h('span', { className: 'chip chip-lab', textContent: LAB_NAME.get(l) ?? l })));
    const actions = h('div', { className: 'lab-actions' });
    if (e.sim) {
      const scene = isScene(e.sim);
      const bench = BENCH_BY_ID.get(e.sim);
      const go = h('button', { className: 'btn-run lab-go', textContent: scene ? `Open simulation: ${SCENES.find((s) => s.id === e.sim)?.name}` : `Run test bench: ${bench?.title ?? e.sim}` });
      go.addEventListener('click', () => {
        if (scene) { close(); opts.openScene(e.sim!); }
        else { st.bench = e.sim!; st.tab = 'benches'; save(); render(); }
      });
      actions.append(go);
    }
    const md = h('button', { className: 'btn-outline btn-small', textContent: 'Download as Markdown' });
    md.addEventListener('click', () => download(`${e.id}.md`, entryMarkdown(e), 'text/markdown'));
    actions.append(md);
    const eq = e.equations?.length ? h('dl', { className: 'lab-eq' }, ...e.equations.flatMap((q) => [h('dt', { textContent: q.label }), h('dd', { className: 'mono', textContent: q.text })])) : null;
    return h('article', { className: 'lab-entry' },
      h('h3', { textContent: e.title }), chips,
      h('p', { className: 'lab-summary', textContent: e.summary }),
      ...(e.objective ? [h('p', { className: 'lab-objective' }, h('b', { textContent: 'Objective. ' }), e.objective)] : []),
      actions,
      ...[
        sec('Equipment', ul(e.equipment)),
        sec(e.kind === 'blueprint' ? 'Design steps' : 'Procedure', ol(e.steps)),
        sec(e.kind === 'blueprint' ? 'Design parameters' : 'Measurements', ul(e.measurements)),
        sec('Equations', eq),
        sec('Standards', ul(e.standards)),
        sec('Safety', ul(e.safety)),
        sec('Deliverables', ul(e.outputs)),
      ].filter((x): x is HTMLElement => x !== null));
  }

  // ---------------------------------------------------------------- benches

  function renderBenches(): HTMLElement {
    const nav = h('div', { className: 'lab-list lab-bench-list', role: 'list' }, ...BENCHES.map((b) => {
      const btn = h('button', { className: 'lab-item', role: 'listitem' }, h('span', { className: 'lab-item-title', textContent: b.title }), h('span', { className: 'lab-item-meta', textContent: b.instrument }));
      if (b.id === st.bench) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', () => { st.bench = b.id; save(); render(); });
      return btn;
    }));
    const bench = BENCH_BY_ID.get(st.bench)!;
    return h('div', { className: 'lab-grid lab-grid-2' }, nav, renderRunner(bench));
  }

  function renderRunner(b: Bench): HTMLElement {
    const values = benchValues.get(b.id) ?? defaults(b);
    benchValues.set(b.id, values);
    const form = h('form', { className: 'lab-form' });
    for (const inp of b.inputs) {
      let ctl: HTMLInputElement | HTMLSelectElement;
      if (inp.options) {
        ctl = h('select', { className: 'select', name: inp.key }, ...inp.options.map((o) => h('option', { value: String(o.value), textContent: o.label })));
        ctl.value = String(values[inp.key]);
      } else {
        ctl = h('input', { className: 'text-input mono', type: 'number', name: inp.key, value: String(values[inp.key]), min: inp.min !== undefined ? String(inp.min) : undefined, max: inp.max !== undefined ? String(inp.max) : undefined, step: inp.step !== undefined ? String(inp.step) : 'any' });
      }
      ctl.addEventListener('change', () => {
        const x = Number(ctl.value);
        if (Number.isFinite(x)) values[inp.key] = inp.min !== undefined || inp.max !== undefined ? Math.min(inp.max ?? Infinity, Math.max(inp.min ?? -Infinity, x)) : x;
      });
      form.append(h('label', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, inp.label, ...(inp.unit ? [h('span', { className: 'muted', textContent: ` (${inp.unit})` })] : [])), ctl));
    }
    const out = h('div', { className: 'lab-out' });
    const runBtn = h('button', { className: 'btn-run', type: 'submit', textContent: 'Run test' });
    const resetBtn = h('button', { className: 'btn-outline btn-small', type: 'button', textContent: 'Defaults' });
    resetBtn.addEventListener('click', () => { benchValues.delete(b.id); lastRun.delete(b.id); render(); });
    form.append(h('div', { className: 'lab-form-actions' }, runBtn, resetBtn));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      window.setTimeout(() => {
        try {
          const res = b.run({ ...values });
          lastRun.set(b.id, res);
          log = [{ at: new Date().toISOString(), bench: b.id, title: b.title, inputs: { ...values }, record: res.record, verdict: res.verdict?.text, pass: res.verdict?.pass }, ...log].slice(0, MAX_LOG);
          storage.set(LOG_KEY, log);
          showOutcome(out, b, res);
          tabs.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!.textContent = `Test log · ${log.length}`;
        } catch (err) {
          out.replaceChildren(h('p', { className: 'form-error', textContent: `The bench could not run: ${(err as Error).message}` }));
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = 'Run test';
        }
      }, 20);
    });
    const refs = ENTRIES.filter((e) => e.sim === b.id);
    const prev = lastRun.get(b.id);
    if (prev) queueMicrotask(() => showOutcome(out, b, prev));
    else out.append(h('p', { className: 'muted', textContent: 'Set the inputs and press Run test. Each run is saved to the test log.' }));
    return h('div', { className: 'lab-runner' },
      h('div', { className: 'lab-runner-head' },
        h('h3', { textContent: b.title }),
        h('p', { className: 'lab-summary', textContent: b.summary }),
        h('div', { className: 'chips' }, h('span', { className: 'chip', textContent: b.instrument }), ...(b.standards ?? []).map((s) => h('span', { className: 'chip chip-lab', textContent: s }))),
        ...(refs.length ? [h('div', { className: 'lab-refs' }, h('span', { className: 'muted', textContent: 'Reference: ' }), ...refs.map((e) => {
          const a = h('button', { className: 'link-btn', textContent: e.title });
          a.addEventListener('click', () => { Object.assign(st, { tab: 'library', entry: e.id, q: '', kind: 'all', branch: 'all', lab: 'all' }); save(); render(); });
          return a;
        }))] : [])),
      form, out);
  }

  function showOutcome(out: HTMLElement, b: Bench, res: BenchOutcome): void {
    const verdict = res.verdict ? h('div', { className: 'lab-verdict', dataset: { pass: String(res.verdict.pass) } }, h('b', { textContent: res.verdict.pass ? 'Pass' : 'Fail' }), h('span', { textContent: res.verdict.text })) : null;
    const table = h('table', { className: 'lab-results' }, h('tbody', {}, ...res.results.map((r) => h('tr', {}, h('th', { scope: 'row', textContent: r.label }), h('td', { className: 'mono', textContent: r.value })))));
    const canvases = res.charts.map((c) => {
      const cv = h('canvas', { className: 'lab-chart', role: 'img', ariaLabel: `${c.title}: ${c.yLabel} against ${c.xLabel}` });
      return { cv, c };
    });
    const exportBtn = h('button', { className: 'btn-outline btn-small', textContent: 'Download data (CSV)' });
    exportBtn.addEventListener('click', () => download(`${b.id}-data.csv`, res.charts.map((c) => `# ${c.title}\n${chartCsv(c)}`).join('\n\n'), 'text/csv'));
    out.replaceChildren(
      ...(verdict ? [verdict] : []),
      table,
      h('div', { className: 'lab-charts' }, ...canvases.map(({ cv }) => cv)),
      ...(res.notes?.length ? [h('ul', { className: 'lab-notes' }, ...res.notes.map((x) => h('li', { textContent: x })))] : []),
      h('div', { className: 'lab-form-actions' }, exportBtn));
    const draw = () => canvases.forEach(({ cv, c }) => drawChart(cv, c));
    requestAnimationFrame(draw);
    resize?.disconnect();
    resize = new ResizeObserver(() => draw());
    canvases.forEach(({ cv }) => resize!.observe(cv));
  }

  // ---------------------------------------------------------------- disciplines and facilities

  function browse(patch: Partial<UiState>): void {
    Object.assign(st, { tab: 'library', q: '', kind: 'all', branch: 'all', lab: 'all', entry: null }, patch);
    save();
    render();
  }

  function renderBranches(): HTMLElement {
    return h('div', { className: 'lab-cards' }, ...BRANCHES.map((b) => {
      const c = BRANCH_COUNTS.get(b.id) ?? { blueprint: 0, procedure: 0, experiment: 0, total: 0 };
      const go = h('button', { className: 'btn-outline btn-small', textContent: `Browse ${c.total}` });
      go.addEventListener('click', () => browse({ branch: b.id }));
      return h('div', { className: 'lab-card' },
        h('h4', { textContent: `${b.name} engineering` }),
        h('div', { className: 'lab-counts mono' }, `${c.blueprint} blueprints · ${c.procedure} tests · ${c.experiment} experiments`),
        h('div', { className: 'lab-card-actions' }, go, h('a', { className: 'link-btn', href: b.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Wikipedia ↗' })));
    }));
  }

  function renderFacilities(): HTMLElement {
    return h('div', { className: 'lab-cards lab-cards-wide' }, ...FACILITIES.map((f) => {
      const n = LAB_COUNTS.get(f.id)?.total ?? 0;
      const go = h('button', { className: 'btn-outline btn-small', textContent: `Browse ${n} exercises` });
      go.addEventListener('click', () => browse({ lab: f.id }));
      const benches = (LAB_BENCHES[f.id] ?? []).map((id) => {
        const bb = h('button', { className: 'chip chip-bench', textContent: `▶ ${BENCH_BY_ID.get(id)?.title ?? id}` });
        bb.addEventListener('click', () => { st.bench = id; st.tab = 'benches'; save(); render(); });
        return bb;
      });
      return h('div', { className: 'lab-card' },
        h('h4', { textContent: f.name }),
        h('p', { className: 'muted', textContent: f.industry }),
        h('ul', { className: 'lab-equip' }, ...f.equipment.map((x) => h('li', { textContent: x }))),
        ...(benches.length ? [h('div', { className: 'chips' }, ...benches)] : []),
        h('div', { className: 'lab-card-actions' }, go));
    }));
  }

  // ---------------------------------------------------------------- log

  function renderLog(): HTMLElement {
    const exportBtn = h('button', { className: 'btn-outline btn-small', textContent: 'Download log (CSV)', disabled: !log.length });
    exportBtn.addEventListener('click', () => {
      const keys = [...new Set(log.flatMap((r) => Object.keys(r.record)))];
      const rows = [['time', 'bench', ...keys, 'verdict', 'inputs'].map(csvCell).join(',')];
      for (const r of log) rows.push([r.at, r.title, ...keys.map((k) => r.record[k] ?? ''), r.verdict ?? '', Object.entries(r.inputs).map(([k, v]) => `${k}=${v}`).join('; ')].map(csvCell).join(','));
      download('motion-studio-test-log.csv', rows.join('\n'), 'text/csv');
    });
    const clearBtn = h('button', { className: 'btn-outline btn-small', textContent: 'Clear log', disabled: !log.length });
    clearBtn.addEventListener('click', () => {
      if (!window.confirm(`Delete all ${log.length} test records from this browser?`)) return;
      log = [];
      storage.set(LOG_KEY, log);
      toast('Test log cleared.');
      render();
    });
    const head = h('div', { className: 'lab-log-head' }, h('p', { className: 'muted', textContent: log.length ? `${log.length} runs, newest first. Stored in this browser only.` : 'No runs yet. Results from every bench run appear here.' }), exportBtn, clearBtn);
    if (!log.length) return h('div', { className: 'dlg-pad' }, head);
    const table = h('table', { className: 'lab-log' },
      h('thead', {}, h('tr', {}, ...['Time', 'Bench', 'Results', 'Verdict'].map((x) => h('th', { scope: 'col', textContent: x })))),
      h('tbody', {}, ...log.map((r) => h('tr', {},
        h('td', { className: 'mono', textContent: new Date(r.at).toLocaleString() }),
        h('td', { textContent: r.title }),
        h('td', { className: 'mono', textContent: Object.entries(r.record).map(([k, v]) => `${k} ${v}`).join(' · ') }),
        h('td', { dataset: { pass: r.pass === undefined ? '' : String(r.pass) }, textContent: r.pass === undefined ? '—' : r.pass ? 'pass' : 'fail' })))));
    return h('div', { className: 'dlg-pad' }, head, h('div', { className: 'lab-log-wrap' }, table));
  }

  render();
  dlg.showModal();
}
