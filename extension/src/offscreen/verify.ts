/**
 * Re-OCR verification.
 *
 * Every redaction pipeline asserts that it worked. This one checks.
 *
 * After the masks are painted, the redacted image is read back with the same
 * OCR engine and the result is held against two conditions: no PII value seen
 * during this observation may still be readable, and no string that was not
 * seen before may now pass `isPII`. The second condition matters as much as
 * the first — a mask can shift a line of text into a new arrangement, or the
 * face detector can miss a card sitting behind a person, and neither of those
 * failures is visible from the list of rectangles we asked for.
 *
 * A failure is not a warning. The image is not sent.
 */
import { isPII, piiKind } from '../content/redaction';
import { candidateTokens } from './ocr';

export interface VerificationResult {
  verified: boolean;
  /**
   * Why verification failed, safe to log.
   *
   * Deliberately names only the *kind* of value still readable, never the
   * value. A verifier that wrote the leaking Aadhaar number into a log line
   * would have leaked it itself, which is a genuinely easy mistake to make
   * while debugging exactly this code.
   */
  reason?: string;
  /** Kinds still readable after redaction. Never the values. */
  leakedKinds: string[];
}

/** Normalises for comparison: OCR spacing and case are not reliable. */
function normalise(s: string): string {
  return s.replace(/[\s\-]/g, '').toLowerCase();
}

/**
 * Checks the text read back off the redacted image.
 *
 * `knownPiiValues` are the raw values this observation saw — from the DOM
 * fields and from the first OCR pass. They stay local; they are passed here
 * precisely so that the last thing we do before sending is confirm none of
 * them survived.
 */
export function verifyRedactedText(
  reOcrText: string[],
  knownPiiValues: string[],
): VerificationResult {
  const haystack = normalise(reOcrText.join('\n'));
  const leaked = new Set<string>();

  // 1. Nothing we already know to be sensitive may still be readable.
  for (const value of knownPiiValues) {
    const needle = normalise(value);
    // Very short values would collide with ordinary page text; they are not
    // identifying on their own and are handled by the pattern check below.
    if (needle.length < 6) continue;
    if (haystack.includes(needle)) leaked.add(piiKind(value) ?? 'KNOWN_VALUE');
  }

  // 2. Nothing newly readable may look like PII either. The mask list is a
  // statement of intent; this is the only check on the result.
  for (const block of reOcrText) {
    for (const token of candidateTokens(block)) {
      const kind = piiKind(token);
      if (kind) leaked.add(kind);
      else if (isPII(token)) leaked.add('UNCLASSIFIED');
    }
  }

  if (leaked.size === 0) return { verified: true, leakedKinds: [] };
  const kinds = [...leaked].sort();
  return {
    verified: false,
    leakedKinds: kinds,
    reason: `re-OCR found readable ${kinds.join(', ')} after redaction; image withheld`,
  };
}
