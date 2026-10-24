// Accepted TWP-9: explicit-country contacts, reviewed CSV and encoding-aware estimates.
import {
  normalizePhone,
  saveContact,
  parseCsv,
  reviewCsv,
  smsEstimate,
  unreadCount,
  emptyWorkspace,
} from './model';

it('never guesses a contact country or overwrites another contact with the same number', () => {
  let contacts = saveContact([], {
    name: 'Alex Rivera',
    number: '+1 (202) 555-0101',
  });
  expect(contacts[0].number).toBe('+12025550101');
  expect(normalizePhone('2025550101')).toBeNull();
  expect(normalizePhone('+1 202 NOT A NUMBER')).toBeNull();
  expect(() =>
    saveContact(contacts, { name: 'Another Alex', number: '+12025550101' }),
  ).toThrow('already');
  const edited = saveContact(contacts, { ...contacts[0], name: 'Alex R.' });
  expect(edited).toHaveLength(1);
  expect(edited[0].id).toBe(contacts[0].id);
});

it('reviews realistic quoted CSV, blanks and duplicates without writing or dialing', () => {
  const csv = parseCsv(
    'Full name,Mobile\r\n"Rivera, Alex",+12025550101\r\n\r\n"Jamie ""J"" Chen",+12025550103\r\nUnclear entry,555\r\nMorgan Lee,+12025550103',
  );
  const existing = [{ name: 'Alex', number: '+12025550101' }];
  const before = JSON.stringify(existing);
  expect(reviewCsv(csv, 0, 1, existing).map((r) => r.status)).toEqual([
    'Duplicate',
    'New',
    'Invalid',
    'Duplicate',
  ]);
  expect(reviewCsv(csv, 0, 1, existing)[1].name).toBe('Jamie "J" Chen');
  expect(JSON.stringify(existing)).toBe(before);
  expect(() => parseCsv('Name,Phone\n"Unfinished,+12025550101')).toThrow(
    'not closed',
  );
});

it('counts GSM extension characters and Unicode as the SMS channel bills them', () => {
  const short = 'Meet at 2?';
  expect(smsEstimate(short)).toEqual({
    encoding: 'GSM-7',
    units: short.length,
    segments: 1,
  });
  expect(smsEstimate('Please bring €5 [cash].').units).toBe(
    'Please bring €5 [cash].'.length + 3,
  );
  const emoji = 'Hi Alex 👋';
  expect(smsEstimate(emoji)).toEqual({
    encoding: 'Unicode',
    units: emoji.length,
    segments: 1,
  });
  const details =
    'Hi Alex, our meeting is tomorrow at 2 PM. Please bring the signed documents and use the north entrance. If you arrive early, wait by reception and I will come down to meet you. Thank you.';
  expect(smsEstimate(details).segments).toBe(2);
});

it('local unread state tracks individual inbound messages without relying on delivery receipts', () => {
  const c = {
    number: '+12025550101',
    messages: [
      { sid: 'SM1', direction: 'inbound', body: 'Meet at 2?' },
      { sid: 'SM2', direction: 'outbound', status: 'delivered', body: 'Yes.' },
      { sid: 'SM3', direction: 'inbound', body: 'Thanks.' },
    ],
  };
  const data = emptyWorkspace();
  data.readIds[c.number] = ['SM1'];
  expect(unreadCount(c, data)).toBe(1);
  data.readIds[c.number].push('SM3');
  expect(unreadCount(c, data)).toBe(0);
});
