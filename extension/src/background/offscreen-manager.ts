/**
 * Owns the offscreen document's lifetime.
 *
 * Chrome allows exactly one offscreen document per extension and tears it
 * down on its own schedule, which makes this a small state machine rather
 * than a one-line create call. Two failure modes matter, and both show up on
 * the first click rather than the hundredth:
 *
 *   - Creating one when it already exists rejects. So do two observations
 *     racing to create it at once, which is the ordinary case when a page
 *     triggers a re-observation while the first is still starting.
 *   - Chrome having silently torn it down between observations, so a call
 *     that worked a minute ago now has nothing on the other end.
 *
 * The classic version of this bug is a cold start that drops the first
 * observation and works from the second onward — invisible in development,
 * guaranteed on stage. So `ensureOffscreen` is idempotent, serialised through
 * a single in-flight promise, and re-checked rather than remembered.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** In-flight creation, shared by every caller that arrives while it runs. */
let creating: Promise<void> | null = null;

type OffscreenApi = {
  hasDocument?(): Promise<boolean>;
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument?(): Promise<void>;
};

function api(): OffscreenApi | null {
  return (chrome as unknown as { offscreen?: OffscreenApi }).offscreen ?? null;
}

/** True when the document is up right now — asked, never assumed. */
export async function offscreenExists(): Promise<boolean> {
  const off = api();
  if (!off) return false;
  if (off.hasDocument) return off.hasDocument();
  // Older Chrome: fall back to asking the runtime which contexts exist.
  const getContexts = (chrome.runtime as unknown as {
    getContexts?(f: unknown): Promise<unknown[]>;
  }).getContexts;
  if (!getContexts) return false;
  const contexts = await getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/**
 * Brings the offscreen document up if it is not already, and returns once it
 * is usable.
 *
 * Throws only when it genuinely cannot be created. "Already exists" is a
 * success, not an error: it is the expected result of two observations
 * racing, and treating it as a failure would drop one of them.
 */
export async function ensureOffscreen(): Promise<void> {
  const off = api();
  if (!off) throw new Error('offscreen API unavailable; no image can be processed.');

  if (await offscreenExists()) return;
  if (creating) return creating;

  creating = (async () => {
    try {
      await off.createDocument({
        url: OFFSCREEN_PATH,
        // DOM_PARSER covers canvas and image decoding; WORKERS covers the
        // Tesseract worker the OCR pass spawns.
        reasons: ['DOM_PARSER', 'WORKERS'],
        justification:
          'Runs face detection, OCR and screenshot redaction locally. ' +
          'Raw pixels never leave this document.',
      });
    } catch (err) {
      // Another caller won the race. That is the outcome we wanted, so it is
      // a success rather than a failure.
      //
      // The phrasing is Chrome's, not ours, and it is easy to get wrong:
      // the message is "Only a single offscreen document may be created",
      // which contains neither "already" nor "exists". Matching too narrowly
      // here reintroduces exactly the dropped-first-observation bug this
      // function exists to prevent, so re-check the real state instead of
      // trusting the wording alone.
      const message = err instanceof Error ? err.message : String(err);
      const looksLikeRace = /already|existing|single offscreen/i.test(message);
      if (!looksLikeRace && !(await offscreenExists())) throw err;
    } finally {
      creating = null;
    }
  })();

  return creating;
}

/** Tears the document down. Used when a task ends, and by tests. */
export async function closeOffscreen(): Promise<void> {
  const off = api();
  if (!off?.closeDocument) return;
  if (!(await offscreenExists())) return;
  await off.closeDocument().catch(() => { /* already gone is fine */ });
}
