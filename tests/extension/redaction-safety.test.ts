import { describe, it, expect } from 'vitest';
import { redactPageIR, buildOutbound, isSensitive } from '../../extension/src/shared/redact';
import type { PageIR, PageElement } from '../../extension/src/shared/types';

const el = (p: Partial<PageElement>): PageElement => ({
  id: 'e1', role: 'textbox', name: '', visible: true, enabled: true, ...p,
});

const ir = (elements: PageElement[]): PageIR => ({
  url: 'https://bank.example.in/login',
  title: 'Login',
  elements,
  text_snippets: [],
  observed_at: '2026-09-06T00:00:00.000Z',
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
    const { payload, summary } = buildOutbound(r);
    const wire = JSON.stringify(payload);
    for (const s of SECRETS) expect(wire).not.toContain(s);
    expect(summary.rawPixelsSent).toBe(0);
    expect(summary.piiValuesSent).toBe(0);
  });

  it('the preview shown in the UI is also clean', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    expect(buildOutbound(r).summary.preview).not.toContain('hunter2');
  });

  it('throws rather than sending if a value ever survives redaction', () => {
    const r = redactPageIR(ir([
      el({ id: 'e1', name: 'Password', input_type: 'password', value: 'hunter2' }),
    ]));
    // simulate a regression that leaks the value back into the graph
    (r.elements[0] as unknown as { name: string }).name = 'hunter2';
    expect(() => buildOutbound(r)).toThrow(/Redaction failed/);
  });
});
