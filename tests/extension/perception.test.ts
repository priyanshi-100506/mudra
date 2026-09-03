import { describe, it, expect, beforeEach } from 'vitest';
import { capturePageIR } from '../../extension/src/content/perception';

describe('DOM Perception Walker', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('filters hidden elements and captures interactive candidates with IDs', () => {
    document.body.innerHTML = `
      <h1>Login Page</h1>
      <button id="btn1">Click Me</button>
      <input type="text" id="input1" placeholder="Enter text" />
      <div style="display: none;"><button id="btn2">Hidden Button</button></div>
    `;

    // Mock getBoundingClientRect for DOM elements in jsdom environment
    Element.prototype.getBoundingClientRect = function () {
      if (this.id === 'btn2') {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => {} };
      }
      return { x: 0, y: 0, width: 100, height: 30, top: 0, right: 100, bottom: 30, left: 0, toJSON: () => {} };
    };

    const ir = capturePageIR();

    expect(ir.text_snippets).toContain('Login Page');
    expect(ir.elements.length).toBe(2);
    expect(ir.elements[0].id).toBe('e1');
    expect(ir.elements[0].name).toBe('Click Me');
    expect(ir.elements[1].id).toBe('e2');
    expect(ir.elements[1].name).toBe('Enter text');
  });
});