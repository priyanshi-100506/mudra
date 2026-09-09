import { describe, it, expect } from 'vitest';
import { redactPageIR, buildOutbound, isSensitive } from '../../extension/src/shared/redact';
import type { PageIR, PageElement } from '../../extension/src/shared/types';

const el = (p: Partial<PageElement>): PageElement => ({
  id: 'e1', role: 'textbox', name: '', visible: true, enabled: true, ...p,
});

const ir = (elements: PageElement[], over: Partial<PageIR> = {}): PageIR => ({
  url: 'https://bank.example.in/login',
  title: 'Login',
  elements,
  text_snippets: [],
  observed_at: '2026-09-06T00:00:00.000Z',
  ...over,
});

describe('isSensitive — identity, not just content', () => {
  it('flags a password input even when empty', () => {
    expect(isSensitive(el({ input_type: 'password', value: '' }))).toBe(true);
  });

  it('flags a card field by its label alone', () => {
    expect(isSensitive(el({ name: 'Credit Card Number' }))).toBe(true);
    expect(isSensitive(el({ name: 'Card Verification Code' }))).toBe(true);
  });

  it('flags by autocomplete token', () => {
    expect(isSensitive(el({ name: 'x', autocomplete: 'cc-number' }))).toBe(true);
    expect(isSensitive(el({ name: 'x', autocomplete: 'current-password' }))).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(isSensitive(el({ name: 'Company' }))).toBe(false);
    expect(isSensitive(el({ name: 'City' }))).toBe(false);
  });
});

describe('redactPageIR', () => {
  it('replaces sensitive ids with opaque refs and keeps ordinary ids', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
      el({ id: 'e2', name: 'Company', value: 'Acme' }),
    ]));
    const [pw, co] = r.elements;
    expect(pw.sensitive).toBe(true);
    expect(pw.ref).not.toBe('e1');
    expect(pw.ref).toMatch(/^ref_/);
    expect(co.sensitive).toBe(false);
    expect(co.ref).toBe('e2');
  });

  it('SceneElement carries no value field at all', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    expect(Object.keys(r.elements[0])).not.toContain('value');
  });

  it('keeps the element id on RedactedField for on-device use only', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    expect(r.fields[0].elementId).toBe('e1');
    expect(r.fields[0]).not.toHaveProperty('value');
  });
});

describe('buildOutbound — the load-bearing assertion', () => {
  const SECRETS = ['hunter2', '4111111111111111', 'ABCDE1234F', '234567890123'];

  it('never serialises a protected value', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
      el({ id: 'e2', name: 'Credit Card Number', value: '4111111111111111' }),
      el({ id: 'e3', name: 'PAN', value: 'ABCDE1234F' }),
      el({ id: 'e4', name: 'Aadhaar', value: '234567890123' }),
    ]));
    const source = ir([]);
    const { payload, summary } = buildOutbound(r, source);
    const wire = JSON.stringify(payload);
    for (const s of SECRETS) expect(wire).not.toContain(s);
    expect(summary.rawPixelsSent).toBe(0);
    expect(summary.piiValuesSent).toBe(0);
  });

  it('the preview shown in the UI is also clean', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    expect(buildOutbound(r, ir([])).summary.preview).not.toContain('hunter2');
  });

  it('throws rather than sending if a value ever survives redaction', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    // simulate a regression that leaks the value back into the graph
    (r.elements[0] as unknown as { name: string }).name = 'hunter2';
    expect(() => buildOutbound(r, ir([]))).toThrow(/Redaction failed/);
  });
});

describe('buildOutbound — the whole body, not just the elements', () => {
  it('redacts PII embedded in page text snippets', () => {
    // Regression: the worker used to spread the raw PageIR alongside the
    // redacted elements, so headings went out verbatim.
    const source = ir([], {
      text_snippets: ['Welcome back', 'Your PAN on file is ABCDE1234F'],
    });
    const { payload } = buildOutbound(redactPageIR(source), source);
    expect(JSON.stringify(payload)).not.toContain('ABCDE1234F');
    expect(payload.text_snippets[0]).toBe('Welcome back');
  });

  it('redacts PII in the document title', () => {
    const source = ir([], { title: 'Account ABCDE1234F — Overview' });
    const { payload } = buildOutbound(redactPageIR(source), source);
    expect(payload.title).not.toContain('ABCDE1234F');
  });

  it('strips sensitive query parameters and the fragment from the url', () => {
    const source = ir([], {
      url: 'https://bank.example.in/acct?token=s3cr3t&page=2#pan-ABCDE1234F',
    });
    const { payload } = buildOutbound(redactPageIR(source), source);
    expect(payload.url).not.toContain('s3cr3t');
    expect(payload.url).not.toContain('ABCDE1234F');
    expect(payload.url).toContain('page=2'); // benign context is preserved
  });

  it('carries only the agreed keys onto the wire', () => {
    const source = ir([el({ id: 'e1', name: 'Full name', value: 'Kavya' })]);
    const { payload } = buildOutbound(redactPageIR(source), source);
    expect(Object.keys(payload).sort()).toEqual(
      ['elements', 'observed_at', 'text_snippets', 'title', 'url'],
    );
  });
});
