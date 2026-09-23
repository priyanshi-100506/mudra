/**
 * Canary tokens.
 *
 * MUDRA's central claim is that no PII value reaches the network. Every other
 * check in this codebase tests that claim against values we chose in a test
 * file. Canaries test it against the running system: three fake identifiers,
 * valid by construction, planted where real PII lives, carried through
 * exactly the code paths a real value takes, and looked for in the bytes that
 * actually go on the wire.
 *
 * Two design rules, and the whole exercise is worthless without either.
 *
 * First, a canary must enter through the same door as real PII — the DOM, and
 * the OCR text stream. A canary injected after the redaction stage travels a
 * path no real value takes, so it proves nothing at all about the path real
 * values take.
 *
 * Second, the scan runs on the *serialised* request body, not the object
 * graph. The bug this exists to catch is precisely a value riding out inside
 * some nested field that nobody thought to inspect, and `JSON.stringify` is
 * the only thing that sees all of them.
 *
 * Because they are structurally valid, canaries are indistinguishable from
 * real PII to the redactor — which is the point. They are distinguishable to
 * *us* only because this module remembers the exact strings it generated.
 */

/** A planted tracer value. */
export interface Canary {
  /** The literal string planted. Never sent; that is the entire point. */
  value: string;
  kind: 'aadhaar' | 'pan' | 'card';
  /** Stable id for reporting, safe to show and to log. */
  id: string;
}

export interface CanaryReport {
  planted: number;
  escaped: number;
  /** Kinds that escaped. Never the values. */
  escapedKinds: string[];
}

// --- Check-digit generation -------------------------------------------------
// A canary that failed its own checksum would be rejected by `isPII` and would
// sail through the payload untouched, reporting a leak that never happened.
// So these have to be genuinely valid.

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Returns the Verhoeff check digit for an 11-digit body. */
export function verhoeffCheckDigit(body: string): string {
  let c = 0;
  const arr = (body + '0').split('').map(Number).reverse();
  for (let i = 0; i < arr.length; i++) c = D[c][P[i % 8][arr[i]]];
  return String(INV[c]);
}

/** Returns the Luhn check digit for a 15-digit body. */
export function luhnCheckDigit(body: string): string {
  let sum = 0;
  let alt = true; // the check digit's neighbour doubles
  for (let i = body.length - 1; i >= 0; i--) {
    let d = Number(body[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

function randomDigits(n: number, first?: string): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = first ?? '';
  for (let i = out.length; i < n; i++) out += String(bytes[i] % 10);
  return out;
}

function randomLetters(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % 26]).join('');
}

// --- Generation and registry ------------------------------------------------

let planted: Canary[] = [];

/**
 * Mints three fresh canaries for this observation.
 *
 * Fresh each time, not fixed constants: a constant would eventually be
 * committed to a fixture, copied into a test expectation, and end up matching
 * something that is not actually a leak. Randomness also means a canary
 * cannot collide with a real value on the page except by accident so unlikely
 * it is not worth designing around.
 */
export function generateCanaries(): Canary[] {
  // Aadhaar: 12 digits, cannot start with 0 or 1, Verhoeff-valid.
  const aadhaarBody = randomDigits(11, String(2 + (crypto.getRandomValues(new Uint8Array(1))[0] % 8)));
  const aadhaar = aadhaarBody + verhoeffCheckDigit(aadhaarBody);

  // PAN: five letters, four digits, one letter.
  const pan = randomLetters(5) + randomDigits(4) + randomLetters(1);

  // Card: 16 digits, Luhn-valid. The 4 prefix keeps it in test-card space.
  const cardBody = randomDigits(15, '4');
  const card = cardBody + luhnCheckDigit(cardBody);

  planted = [
    { value: aadhaar, kind: 'aadhaar', id: 'canary_aadhaar' },
    { value: pan, kind: 'pan', id: 'canary_pan' },
    { value: card, kind: 'card', id: 'canary_card' },
  ];
  return [...planted];
}

/**
 * Adopts canaries minted elsewhere.
 *
 * The content script plants them, because that is where the DOM is; the
 * worker scans for them, because that is where the network is. This is how
 * the values cross between the two without ever entering a payload.
 */
export function registerCanaries(canaries: Canary[]): void {
  planted = [...canaries];
}

/** The canaries planted for the current observation. */
export function currentCanaries(): Canary[] {
  return [...planted];
}

export function clearCanaries(): void {
  planted = [];
}

/**
 * Scans a *serialised* body for any planted canary.
 *
 * Takes a string, deliberately. An object-graph walk has to decide what
 * counts as a field, and the leak this catches is a value somewhere nobody
 * thought to walk.
 */
export function scanForCanaries(serialised: string, canaries = planted): Canary[] {
  if (!serialised) return [];
  const hay = serialised.replace(/[\s\-]/g, '').toLowerCase();
  return canaries.filter((c) => hay.includes(c.value.replace(/[\s\-]/g, '').toLowerCase()));
}

/** A report safe to render in the panel and to write to the manifest. */
export function canaryReport(escaped: Canary[], canaries = planted): CanaryReport {
  return {
    planted: canaries.length,
    escaped: escaped.length,
    escapedKinds: [...new Set(escaped.map((c) => c.kind))].sort(),
  };
}

/**
 * The last gate before a POST.
 *
 * Throws rather than returning a flag. Everything else in this pipeline
 * prefers returning failure as data, because those failures have a safe
 * degraded outcome — withhold the image, send text only. This one does not:
 * a canary in the body means the redactor is broken in a way we do not
 * understand, and there is no version of continuing that is safe.
 */
export function assertNoCanaries(serialised: string, canaries = planted): void {
  const escaped = scanForCanaries(serialised, canaries);
  if (escaped.length === 0) return;
  const kinds = [...new Set(escaped.map((c) => c.kind))].sort().join(', ');
  throw new CanaryEscape(
    `Canary escaped (${kinds}): a tracer value reached the serialised request body. ` +
      'The request was aborted. This is a redaction failure, not a policy decision.',
    canaryReport(escaped, canaries),
  );
}

export class CanaryEscape extends Error {
  readonly report: CanaryReport;
  constructor(message: string, report: CanaryReport) {
    super(message);
    this.name = 'CanaryEscape';
    this.report = report;
  }
}

/**
 * Scans a planner response.
 *
 * If the model echoes a canary back, the boundary was crossed somewhere
 * upstream — and possibly not by us: it could equally mean the value reached
 * the provider through a path outside this extension. Either way the value is
 * out, and the session should stop.
 */
export function scanPlannerResponse(responseText: string, canaries = planted): Canary[] {
  return scanForCanaries(responseText, canaries);
}
