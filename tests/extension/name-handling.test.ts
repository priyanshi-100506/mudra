import { describe, it, expect } from 'vitest';
import { isSensitive, redactPageIR, buildOutbound } from '../../extension/src/shared/redact';
import type { PageElement, PageIR } from '../../extension/src/shared/types';

const el = (name: string, value = '', over: Partial<PageElement> = {}): PageElement =>
  ({ id: 'e1', role: 'textbox', name, value, visible: true, enabled: true, ...over });

describe('name-labelled fields are sealed', () => {
  const sealed = [
    'Full name', 'First name', 'Last name', 'Middle name', 'Given name',
    'Name as on Aadhaar', 'Name as per PAN', 'Applicant name', 'Account holder name',
    "Father's name", "Mother's name", 'Spouse name', 'Nominee name', 'Surname',
  ];
  for (const label of sealed) {
    it(`seals "${label}"`, () => {
      expect(isSensitive(el(label, 'Asha Verma'))).toBe(true);
    });
  }

  it('seals an empty name field too — it is a name field either way', () => {
    expect(isSensitive(el('Full name', ''))).toBe(true);
  });

  it('seals a field marked with a name autocomplete token', () => {
    expect(isSensitive(el('Applicant', 'Asha', { autocomplete: 'given-name' }))).toBe(true);
  });
});

describe('fields that merely contain the word "name" are left readable', () => {
  // An over-sealed form is one the agent cannot fill. Every one of these is
  // a field the planner legitimately needs to read.
  const readable = [
    'Product name', 'File name', 'Username', 'Bank name', 'Branch name',
    'Company name', 'Scheme name', 'Document name', 'City name',
  ];
  for (const label of readable) {
    it(`leaves "${label}" alone`, () => {
      expect(isSensitive(el(label, 'something'))).toBe(false);
    });
  }
});

describe('a sealed value is scrubbed wherever else it appears', () => {
  const ir: PageIR = {
    url: 'https://kyc.example.in/verify',
    // Pages repeat themselves: the name is in a field and again in the title.
    title: 'KYC — Asha Verma',
    elements: [
      el('Full name', 'Asha Verma'),
      { ...el('City', 'Bengaluru'), id: 'e2' },
    ],
    text_snippets: ['Welcome, Asha Verma', 'Your application is pending'],
    observed_at: '2026-01-01T00:00:00Z',
  };

  it('removes the name from the title', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir);
    expect(payload.title).not.toContain('Asha Verma');
    expect(payload.title).toContain('KYC');
  });

  it('removes the name from text snippets', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir);
    expect(JSON.stringify(payload.text_snippets)).not.toContain('Asha Verma');
  });

  it('replaces it with the same reference the field got, not a blank', () => {
    // The planner should still be able to tell that the title names the
    // person whose field this is.
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir);
    const ref = payload.elements.find((e) => e.sensitive)!.ref;
    expect(payload.title).toContain(ref);
  });

  it('leaves unrelated page text intact', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir);
    expect(payload.text_snippets.join(' ')).toContain('application is pending');
    // The City field stays readable to the planner — as a described element,
    // not as a value. No element value is ever in the payload, sensitive or
    // not, so the scrub cannot be checked by looking for one.
    const city = payload.elements.find((e) => e.name === 'City');
    expect(city?.sensitive).toBe(false);
    expect(city?.ref).toBe('e2');
  });

  it('does not scrub values too short to be identifying', () => {
    const shortIr: PageIR = {
      ...ir,
      title: 'Page 1 of 4',
      elements: [el('Full name', 'Al')],
      text_snippets: [],
    };
    const r = redactPageIR(shortIr);
    expect(buildOutbound(r, shortIr).payload.title).toBe('Page 1 of 4');
  });

  it('survives a value containing regex metacharacters', () => {
    const oddIr: PageIR = {
      ...ir,
      title: 'KYC — A. (Asha) Verma+',
      elements: [el('Full name', 'A. (Asha) Verma+')],
      text_snippets: [],
    };
    const r = redactPageIR(oddIr);
    expect(buildOutbound(r, oddIr).payload.title).not.toContain('(Asha)');
  });
});

describe('the documented limit', () => {
  it('does NOT find a name that only ever appears in prose', () => {
    // No labelled field held it, so nothing sealed it, so there is nothing
    // to scrub. This is pattern matching, not named-entity recognition, and
    // the eval reports namedEntities as an honest zero.
    const ir: PageIR = {
      url: 'https://news.example/article',
      title: 'Interview with Asha Verma',
      elements: [],
      text_snippets: ['Asha Verma told us that…'],
      observed_at: '2026-01-01T00:00:00Z',
    };
    const { payload } = buildOutbound(redactPageIR(ir), ir);
    expect(payload.title).toContain('Asha Verma');
  });
});
