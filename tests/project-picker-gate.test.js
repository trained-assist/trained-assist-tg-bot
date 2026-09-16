// R14 / issue #517 — new-dialog project picker gate.
// Guards the invariant that a FRESH dialog on a profile with ≥2 projects must ASK
// which project (never auto-guess), while continuing dialogs and file uploads skip
// the picker. Tests the REAL predicate wired into handlers/message.js — not a copy.
import { describe, it, expect } from 'vitest';
import { shouldAskProject } from '../src/intake-routing.js';

const ask2 = { action: 'ask', choices: [{ id: 'a' }, { id: 'b' }], active: 'a' };

describe('shouldAskProject — R14 new-dialog project gate', () => {
  it('new dialog + ≥2 projects → ASK (the R14 fix: no auto-guess)', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: false, decision: ask2 })).toBe(true);
  });

  it('continuing dialog → never ask (keeps its stored project)', () => {
    expect(shouldAskProject({ isNewDialog: false, hasFile: false, decision: ask2 })).toBe(false);
  });

  it('file upload → same picker, originals retained before download)', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: true, decision: ask2 })).toBe(true);
  });

  it('single project (action=auto) → no ask', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: false, decision: { action: 'auto', project: { id: 'a' } } })).toBe(false);
  });

  it('no projects yet (action=create) → no ask', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: false, decision: { action: 'create', suggestType: 'generic' } })).toBe(false);
  });

  it('ask with empty choices → no ask (nothing to pick)', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: false, decision: { action: 'ask', choices: [] } })).toBe(false);
  });

  it('missing/undefined decision → no ask (fail closed, no picker on error)', () => {
    expect(shouldAskProject({ isNewDialog: true, hasFile: false, decision: undefined })).toBe(false);
    expect(shouldAskProject({})).toBe(false);
  });
});
