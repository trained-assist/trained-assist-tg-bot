import { describe, expect, it } from 'vitest';
import { sandboxMediaFixture } from '../src/sandbox-tg/test-fixtures.js';

describe('isolated sandbox media fixtures', () => {
  it('provides actual photo and document bytes for the E2E upload path', () => {
    const photo = sandboxMediaFixture('photo');
    expect(photo.photo).toBe(true);
    expect(photo.mime).toBe('image/jpeg');
    expect([...photo.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const pdf = sandboxMediaFixture('pdf');
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 8))).toBe('%PDF-1.4');
    expect(new TextDecoder().decode(pdf.bytes)).toContain('ORBIT');

    const docx = sandboxMediaFixture('docx');
    expect([...docx.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(sandboxMediaFixture('csv').bytes)).toContain('PLUM');
  });

  it('rejects unexpected fixture kinds', () => {
    expect(sandboxMediaFixture('__proto__')).toBeNull();
    expect(sandboxMediaFixture({})).toBeNull();
  });
});
