import { describe, expect, it } from 'vitest';
import { classifyMessage, parseTranscript, participantDisplayNames, summarize } from './parser.js';

describe('WhatsApp export parser', () => {
  it('parses Android and multiline messages', () => {
    const rows = parseTranscript('15/08/2026, 10:20 - Alice: Hello\nthere\n15/08/2026, 10:21 - Bob: STK-20260815-WA0001.webp (file attached)');
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe('Hello\nthere');
    expect(summarize(rows)[0]).toMatchObject({ sender: 'Alice', text: 1 });
  });

  it('parses iPhone and common attachment types', () => {
    const rows = parseTranscript('[15/08/2026, 10:20:01] Alice: <attached: 00000001-STK-20260815-WA.webp>\n[15/08/2026, 10:21:01] Bob: <attached: GIF-20260815-WA0001.mp4>');
    expect(summarize(rows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sender: 'Alice', sticker: 1 }),
      expect.objectContaining({ sender: 'Bob', gif: 1 }),
    ]));
  });

  it('does not pretend generic omitted media has a known type', () => {
    expect(classifyMessage('<Media omitted>').type).toBe('unknownMedia');
  });

  it('removes WhatsApp contact markers and disambiguates duplicate first names', () => {
    const rows = [
      { sender: '~\u202fAlex Morgan' },
      { sender: '~\u202fAlex' },
      { sender: '~\u202fCasey Rivera ✨' },
      { sender: 'Taylor Reed (Example Group)' },
    ];
    const names = participantDisplayNames(rows);
    expect(names.get('~\u202fAlex Morgan')).toBe('Alex Morgan');
    expect(names.get('~\u202fAlex')).toBe('Alex');
    expect(names.get('~\u202fCasey Rivera ✨')).toBe('Casey');
    expect(names.get('Taylor Reed (Example Group)')).toBe('Taylor');
  });

  it('uses the true last name rather than a middle name or emoji', () => {
    const rows = [
      { sender: '~\u202fJordan Avery Ellis' },
      { sender: 'Jordan Park ✨' },
    ];
    const names = participantDisplayNames(rows);
    expect(names.get('~\u202fJordan Avery Ellis')).toBe('Jordan Ellis');
    expect(names.get('Jordan Park ✨')).toBe('Jordan Park');
  });
});
