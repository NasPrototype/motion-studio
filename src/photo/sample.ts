import type { TwinDraft } from './types';

/** An illustrated breadboard (900 × 640) used to try the review flow without an API key. */
export const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 640" width="1350" height="960">
<defs><pattern id="holes" width="18" height="18" patternUnits="userSpaceOnUse"><rect x="7" y="7" width="4" height="4" fill="#A7ABA2"/></pattern>
<pattern id="checker" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#1A1A1A"/><rect x="10" y="10" width="10" height="10" fill="#1A1A1A"/></pattern></defs>
<rect width="900" height="640" fill="#2A2724"/>
<rect x="24" y="530" width="132" height="88" rx="3" fill="#EFEFEA"/><rect x="34" y="540" width="80" height="60" fill="url(#checker)"/>
<rect x="742" y="18" width="128" height="62" rx="5" fill="#2E2E2E" stroke="#4A4A4A"/><text x="806" y="56" text-anchor="middle" font-family="Helvetica, Arial" font-size="18" font-weight="600" fill="#D9D9D9">9V</text>
<path d="M760,80 C760,104 700,110 690,134" fill="none" stroke="#C0392B" stroke-width="4"/><path d="M780,80 C784,116 740,120 726,166" fill="none" stroke="#222" stroke-width="4"/>
<rect x="90" y="110" width="720" height="420" rx="10" fill="#E6E8E1" stroke="#C9CCC3"/>
<line x1="110" y1="126" x2="790" y2="126" stroke="#C0392B" stroke-width="2"/><line x1="110" y1="166" x2="790" y2="166" stroke="#2D5BB5" stroke-width="2"/>
<line x1="110" y1="472" x2="790" y2="472" stroke="#C0392B" stroke-width="2"/><line x1="110" y1="512" x2="790" y2="512" stroke="#2D5BB5" stroke-width="2"/>
<rect x="110" y="132" width="680" height="28" fill="url(#holes)"/><rect x="110" y="478" width="680" height="28" fill="url(#holes)"/>
<rect x="110" y="184" width="680" height="124" fill="url(#holes)"/><rect x="110" y="332" width="680" height="124" fill="url(#holes)"/>
<rect x="90" y="312" width="720" height="16" fill="#D2D5CC"/>
<g fill="none" stroke-width="4" stroke-linecap="round"><path d="M398,142 C398,200 398,240 398,272" stroke="#C0392B"/><path d="M398,368 C398,420 396,460 396,496" stroke="#222"/>
<path d="M452,368 C470,420 520,398 520,388" stroke="#2E9E5B"/><path d="M434,368 C430,410 600,430 616,404" stroke="#2E9E5B"/>
<path d="M416,368 C410,430 300,420 238,232" stroke="#E2B32B"/><path d="M452,272 C470,240 480,236 500,233" stroke="#E2B32B"/><path d="M150,252 C150,330 150,420 150,494" stroke="#222"/></g>
<line x1="236" y1="233" x2="336" y2="233" stroke="#9A9A9A" stroke-width="2"/><rect x="260" y="226" width="50" height="14" rx="7" fill="#D8C39A"/>
<rect x="268" y="226" width="4" height="14" fill="#C0392B"/><rect x="276" y="226" width="4" height="14" fill="#C0392B"/><rect x="284" y="226" width="4" height="14" fill="#6B3E1F"/><rect x="298" y="226" width="4" height="14" fill="#C9A227"/>
<circle cx="200" cy="250" r="14" fill="#D8343A"/><circle cx="195" cy="245" r="4" fill="#F7A3A6"/><line x1="186" y1="250" x2="150" y2="252" stroke="#9A9A9A" stroke-width="2"/>
<line x1="500" y1="233" x2="590" y2="233" stroke="#9A9A9A" stroke-width="2"/><rect x="520" y="226" width="50" height="14" rx="7" fill="#D8C39A"/>
<rect x="528" y="226" width="4" height="14" fill="#6B3E1F"/><rect x="536" y="226" width="4" height="14" fill="#111"/><rect x="544" y="226" width="4" height="14" fill="#C0392B"/><rect x="558" y="226" width="4" height="14" fill="#C9A227"/>
<path d="M590,233 C620,233 640,180 640,142" fill="none" stroke="#C0392B" stroke-width="4" stroke-linecap="round"/>
<line x1="500" y1="388" x2="590" y2="388" stroke="#9A9A9A" stroke-width="2"/><rect x="520" y="381" width="50" height="14" rx="7" fill="#D8C39A"/>
<rect x="528" y="381" width="4" height="14" fill="#6B3E1F"/><rect x="536" y="381" width="4" height="14" fill="#111"/><rect x="544" y="381" width="4" height="14" fill="#D97A2B"/><rect x="558" y="381" width="4" height="14" fill="#C9A227"/>
<ellipse cx="547" cy="386" rx="11" ry="6" fill="#FFFFFF" fill-opacity="0.6"/>
<circle cx="640" cy="400" r="24" fill="#1F3A73"/><path d="M640,376 A24,24 0 0 1 664,400 L652,400 A12,12 0 0 0 640,388 Z" fill="#8FA6D6"/><circle cx="640" cy="400" r="9" fill="#2A4A8A"/>
<circle cx="330" cy="400" r="11" fill="#D9A441"/>
<g fill="#BFC3C7"><rect x="392" y="272" width="10" height="8"/><rect x="410" y="272" width="10" height="8"/><rect x="428" y="272" width="10" height="8"/><rect x="446" y="272" width="10" height="8"/>
<rect x="392" y="360" width="10" height="8"/><rect x="410" y="360" width="10" height="8"/><rect x="428" y="360" width="10" height="8"/><rect x="446" y="360" width="10" height="8"/></g>
<rect x="384" y="280" width="80" height="80" rx="3" fill="#1E1E1E"/><path d="M384,312 A8,8 0 0 1 384,328" fill="#3A3A3A"/>
<text x="426" y="324" text-anchor="middle" font-family="Menlo, monospace" font-size="11" fill="#CFCFCF">NE555P</text>
</svg>`;

const box = (x: number, y: number, w: number, h: number) => ({ x: x / 900, y: y / 640, w: w / 900, h: h / 640 });

/** A canned draft for the sample image, in exactly the shape the server returns. */
export const SAMPLE_DRAFT: TwinDraft = {
  summary: 'A 555 astable blinker on a breadboard: a 9 V battery feeds an NE555 that charges C1 through R1 and R2, and its output drives a red LED through R3.',
  parts: [
    { ref: 'B1', type: 'battery', label: '9 V battery', params: [{ key: 'E', value: 9 }, { key: 'R', value: 0.5 }], confidence: 0.97, photo: 0, box: box(742, 18, 128, 62), evidence: 'PP3 case marked 9V, leads to the top rails.' },
    { ref: 'U1', type: 'timer555', label: 'NE555 timer', params: [], confidence: 0.98, photo: 0, box: box(376, 266, 96, 108), evidence: 'DIP-8 marked NE555P straddling the trench.' },
    { ref: 'R1', type: 'resistor', label: '1 kΩ resistor', params: [{ key: 'R', value: 1000 }], confidence: 0.93, photo: 0, box: box(496, 216, 98, 34), evidence: 'Bands brown, black, red, gold.' },
    { ref: 'R2', type: 'resistor', label: 'Resistor, value open', params: [], confidence: 0.61, photo: 0, box: box(494, 370, 102, 36), evidence: 'Third band washed out by glare.' },
    { ref: 'R3', type: 'resistor', label: '220 Ω resistor', params: [{ key: 'R', value: 220 }], confidence: 0.9, photo: 0, box: box(232, 216, 108, 34), evidence: 'Bands red, red, brown, gold.' },
    { ref: 'C1', type: 'capacitor', label: 'Electrolytic, value open', params: [], confidence: 0.55, photo: 0, box: box(608, 368, 64, 64), evidence: 'Blue 6.3 mm can; marking not legible.' },
    { ref: 'C2', type: 'capacitor', label: '10 nF ceramic', params: [{ key: 'C', value: 10e-9 }], confidence: 0.88, photo: 0, box: box(313, 383, 34, 34), evidence: 'Ceramic disc marked 103.' },
    { ref: 'D1', type: 'led', label: 'Red LED, 5 mm', params: [], confidence: 0.96, photo: 0, box: box(180, 230, 40, 40), evidence: 'Red 5 mm dome.' },
    { ref: 'GND1', type: 'ground', label: 'Ground rail', params: [], confidence: 0.9, photo: 0, box: box(110, 478, 160, 28), evidence: 'Blue rail joined to the battery negative lead.' },
  ],
  connections: [
    { a: { ref: 'B1', port: 'p' }, b: { ref: 'U1', port: 'vcc' }, confidence: 0.95 },
    { a: { ref: 'R1', port: 'a' }, b: { ref: 'U1', port: 'vcc' }, confidence: 0.9 },
    { a: { ref: 'R1', port: 'b' }, b: { ref: 'U1', port: 'dis' }, confidence: 0.88 },
    { a: { ref: 'R2', port: 'a' }, b: { ref: 'U1', port: 'dis' }, confidence: 0.85 },
    { a: { ref: 'R2', port: 'b' }, b: { ref: 'U1', port: 'thr' }, confidence: 0.85 },
    { a: { ref: 'U1', port: 'thr' }, b: { ref: 'U1', port: 'trig' }, confidence: 0.9 },
    { a: { ref: 'C1', port: 'a' }, b: { ref: 'U1', port: 'trig' }, confidence: 0.85 },
    { a: { ref: 'C1', port: 'b' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.85 },
    { a: { ref: 'C2', port: 'a' }, b: { ref: 'U1', port: 'ctrl' }, confidence: 0.8 },
    { a: { ref: 'C2', port: 'b' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.8 },
    { a: { ref: 'U1', port: 'out' }, b: { ref: 'R3', port: 'a' }, confidence: 0.9 },
    { a: { ref: 'R3', port: 'b' }, b: { ref: 'D1', port: 'anode' }, confidence: 0.9 },
    { a: { ref: 'D1', port: 'cathode' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.92 },
    { a: { ref: 'U1', port: 'gnd' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.95 },
    { a: { ref: 'B1', port: 'n' }, b: { ref: 'GND1', port: 'g' }, confidence: 0.95 },
  ],
  questions: [
    { id: 'q1', ref: 'R2', text: 'Glare washes out the third color band on R2. Orange makes it 10 kΩ; red makes it 1 kΩ.', param: 'R', options: [{ label: '10 kΩ', value: 10000 }, { label: '1 kΩ', value: 1000 }] },
    { id: 'q2', ref: 'C1', text: 'The marking on C1 is unreadable. A 6.3 mm electrolytic on a 9 V board is usually 10 to 100 µF, and this value sets the blink rate.', param: 'C', options: [{ label: '10 µF', value: 10e-6 }, { label: '47 µF', value: 47e-6 }, { label: '100 µF', value: 100e-6 }] },
    { id: 'q3', ref: 'U1', text: 'Pin 4 (reset) shows no wire. In a blinker it is normally tied to V+, and a jumper may be hidden under the chip.', param: '', options: [{ label: 'Tied to V+', value: 1 }, { label: 'Leave open', value: 0 }] },
  ],
  unsupported: [{ label: 'Calibration card', photo: 0, box: box(24, 530, 132, 88), note: 'ChArUco card used for scale; not part of the circuit.' }],
  warnings: [],
};
