import Anthropic from '@anthropic-ai/sdk';
import { LIBRARY } from '../src/sim/library';
import { DRAFT_SCHEMA, normalizeDraft, type TwinDraft } from '../src/photo/types';

export interface PhotoInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string;
}

export class TwinError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MODEL = 'claude-opus-5-5';

function systemPrompt(): string {
  const library = LIBRARY.map((t) =>
    `- ${t.type} (${t.name}): ports ${t.ports.map((p) => `${p.name} [${p.domain}]`).join(', ')}; parameters: ${t.paramHints}`).join('\n');
  return `You turn photos of a physical build into a draft simulation model for Motion Studio, a multi-domain simulator. The photos show one device from one or more angles, sometimes with a printed calibration card for scale.

Identify every part you can see, map each to a part type from the library, read its value from markings where you can (resistor color bands, capacitor print, part numbers, motor labels), and work out how the parts connect. Then say plainly what you could not determine.

Library (type: ports [domain]; parameters, all in SI units):
${library}

How to fill the draft:
- Use only library types. Anything else you can see (a microcontroller board, a sensor, a connector) goes in "unsupported" with a one-line note.
- Name parts with reference designators: B1, R1, C1, L1, D1, U1, M1, G1, F1, and GND1 for the ground.
- params: SI values you can read or reliably infer (ohms, farads, henries, volts). Leave a parameter out when you cannot read it; if it changes how the circuit behaves, ask about it instead.
- connections: one entry per joint between two ports, with port names exactly as listed. A wire or breadboard row that joins several ports becomes a chain of connections. When the circuit has a common return, add a ground part GND1 and connect the battery's n port and every other return to it.
- Rotational connections join shafts that turn together, such as a motor shaft into a gearbox input.
- box: where the part is in the photo where it is clearest, as fractions of image width and height, with x and y the top-left corner. photo is that photo's index, starting at 0.
- confidence: your honest probability, from 0 to 1, that the type, value and connections are right.
- questions: only for uncertainties that would change the simulation. Give 2 to 4 options, each with the SI value that "param" should take on part "ref". Use an empty param when the answer is informational, such as whether a pin is wired.
- Do not invent wires you cannot see. If a pin looks unconnected, ask.`;
}

/** Ask Claude for a twin draft from 1–4 photos. Throws TwinError with an HTTP-style status on failure. */
export async function analyzePhotos(images: PhotoInput[], note: string): Promise<TwinDraft> {
  if (!images.length) throw new TwinError(400, 'Add at least one photo.');
  if (images.length > 4) throw new TwinError(400, 'Use at most four photos.');

  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch {
    throw new TwinError(503, 'No Anthropic credentials on the server. Set ANTHROPIC_API_KEY and restart the dev server.');
  }

  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  });
  content.push({ type: 'text', text: note.trim() ? `Notes from the person who took the photos: ${note.trim()}` : 'Build the draft from these photos.' });

  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: DRAFT_SCHEMA as unknown as Record<string, unknown> } },
      system: systemPrompt(),
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new TwinError(401, 'The Anthropic API rejected the server credentials. Check ANTHROPIC_API_KEY.');
    if (err instanceof Anthropic.RateLimitError) throw new TwinError(429, 'Rate limited by the Anthropic API. Wait a moment and try again.');
    if (err instanceof Anthropic.BadRequestError) throw new TwinError(400, `The request was rejected: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new TwinError(502, 'Could not reach the Anthropic API from the server.');
    if (err instanceof Anthropic.APIError) throw new TwinError(502, `Anthropic API error ${err.status ?? ''}: ${err.message}`);
    if (err instanceof Anthropic.AnthropicError) throw new TwinError(503, `No usable Anthropic credentials on the server: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new TwinError(422, 'Claude declined to analyze these photos. Try photos that show only the hardware.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new TwinError(502, 'The analysis was cut off before it finished. Try fewer photos.');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new TwinError(502, 'Claude returned no draft.');
  let parsed: unknown;
  try { parsed = JSON.parse(textBlock.text); } catch { throw new TwinError(502, 'Claude returned a draft that was not valid JSON.'); }
  return normalizeDraft(parsed);
}

export function credentialsHint(): 'env' | 'unknown' {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'env' : 'unknown';
}
