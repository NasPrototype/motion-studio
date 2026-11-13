const MINUS = '−';
const PREFIXES: [number, string][] = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];
const NO_PREFIX = new Set(['°C', 'K', '%', 'rpm', 'Hz', 'K/W', 'J/K', '°', 'rad', '×', 'kg/s', 'kg', 'bar', 'O/F']);

function sign(v: number, s: string): string {
  return v < 0 ? MINUS + s : s;
}

/** Format a value with an SI prefix and three significant digits: 0.0124 N·m → "12.4 mN·m". */
export function si(v: number, unit: string, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (NO_PREFIX.has(unit)) return sign(v, fixed(a, digits)) + (unit ? ' ' + unit : '');
  if (a < 1e-15) return '0 ' + unit;
  for (const [p, sym] of PREFIXES) {
    if (a >= p * 0.9995) return sign(v, (a / p).toPrecision(digits)) + ' ' + sym + unit;
  }
  return sign(v, (a / 1e-12).toPrecision(digits)) + ' p' + unit;
}

function fixed(a: number, digits: number): string {
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(a).toString();
  const dec = Math.max(0, digits - 1 - Math.floor(Math.log10(a)));
  return a.toFixed(Math.min(dec, 4));
}

export const toCelsius = (k: number) => k - 273.15;
export const toRpm = (radPerSec: number) => (radPerSec * 60) / (2 * Math.PI);
