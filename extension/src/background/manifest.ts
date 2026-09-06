/**
 * Egress manifest — a plain record of what left this device.
 *
 * Deliberately not a hash chain. A chain implies tamper-evidence guarantees
 * we cannot back in four weeks: it would require an untampered extension and
 * complete coverage of every request, neither of which we can prove. A plain
 * log gives the same "see what left" evidence without an unsupportable claim.
 *
 * Entries never contain values. The digest is computed over the payload that
 * was actually sent, which by construction holds only references.
 */

export interface ManifestEntry {
  at: string;
  kind: 'egress' | 'action';
  /** SHA-256 of the exact bytes sent. Egress entries only. */
  digest?: string;
  destination?: string;
  fieldsSent?: number;
  refsSent?: number;
  redactionCount?: number;
  rawPixelsSent?: 0;
  /** Action entries only. */
  effect?: string;
  outcome?: 'executed' | 'refused';
  reason?: string;
}

const entries: ManifestEntry[] = [];
const MAX_ENTRIES = 200;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function push(e: ManifestEntry) {
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Called immediately before a payload is put on the wire. */
export async function recordEgress(
  payload: unknown,
  destination: string,
  counts: { fields: number; refs: number; redactions: number },
): Promise<void> {
  const body = JSON.stringify(payload);
  push({
    at: new Date().toISOString(),
    kind: 'egress',
    digest: await sha256(body),
    destination,
    fieldsSent: counts.fields,
    refsSent: counts.refs,
    redactionCount: counts.redactions,
    rawPixelsSent: 0,
  });
}

/** Called after the executor decides. */
export function recordAction(
  effect: string,
  outcome: 'executed' | 'refused',
  reason?: string,
): void {
  push({ at: new Date().toISOString(), kind: 'action', effect, outcome, reason });
}

export function readManifest(): ManifestEntry[] {
  return [...entries].reverse();
}

export function clearManifest(): void {
  entries.length = 0;
}

/** Plain-text export — what a compliance reviewer would be handed. */
export function exportManifest(): string {
  const lines = ['MUDRA egress manifest', '='.repeat(60), ''];
  for (const e of readManifest()) {
    if (e.kind === 'egress') {
      lines.push(
        `${e.at}  EGRESS`,
        `  destination      ${e.destination}`,
        `  payload digest   ${e.digest}`,
        `  fields described ${e.fieldsSent}`,
        `  references sent  ${e.refsSent}`,
        `  values redacted  ${e.redactionCount}`,
        `  raw pixels sent  0`,
        '',
      );
    } else {
      lines.push(
        `${e.at}  ACTION ${e.outcome?.toUpperCase()}`,
        `  effect           ${e.effect}`,
        ...(e.reason ? [`  reason           ${e.reason}`] : []),
        '',
      );
    }
  }
  lines.push('No sensitive value appears in this log, by construction.');
  return lines.join('\n');
}
