// Accepted TWP-9 piece 3: local contacts, reviewed CSV and SMS segment estimates.
export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^\+[\d\s().-]+$/.test(value.trim()))
    return null;
  const number = '+' + value.replace(/\D/g, '');
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}

export function saveContact(contacts, input) {
  const name = input.name.trim();
  const number = normalizePhone(input.number);
  if (!name) throw new Error('Enter a contact name.');
  if (!number)
    throw new Error('Include the country code, for example +1 202 555 0101.');
  if (contacts.some((c) => c.number === number && c.id !== input.id)) {
    throw new Error('This number already belongs to a contact.');
  }
  const contact = {
    id:
      input.id ||
      `contact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    number,
  };
  return [...contacts.filter((c) => c.id !== contact.id), contact].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

// RFC 4180-style quoted fields (including commas, escaped quotes and newlines).
// Import is a review, never a write: the caller must explicitly confirm valid new rows.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    afterQuote = false;
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else if (c === undefined)
        throw new Error('A quoted CSV field is not closed.');
      else field += c;
    } else if (c === ',' || c === '\n' || c === undefined) {
      row.push(field.trim());
      field = '';
      afterQuote = false;
      if (c !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else if (c === '"') {
      if (field.trim() || afterQuote)
        throw new Error('Check the CSV quotation marks.');
      field = '';
      quoted = true;
    } else {
      if (afterQuote && c.trim())
        throw new Error('A quoted field must end with a comma or a new line.');
      field += c;
    }
  }
  if (rows.length < 2)
    throw new Error('Include a header row and at least one contact.');
  return { headers: rows[0], rows: rows.slice(1) };
}

export function reviewCsv(csv, nameColumn, phoneColumn, contacts) {
  const known = new Set(contacts.map((c) => c.number));
  return csv.rows.map((cells, i) => {
    const name = (cells[nameColumn] || '').trim();
    const rawNumber = cells[phoneColumn] || '';
    const number = normalizePhone(rawNumber);
    const status =
      !name || !number ? 'Invalid' : known.has(number) ? 'Duplicate' : 'New';
    if (status === 'New') known.add(number);
    return { row: i + 2, name, rawNumber, number, status };
  });
}

// 3GPP GSM-7 default alphabet and extension table; extension characters use two septets.
const GSM = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
const EXT = new Set(Array.from('\f^{}\\[~]|€'));
export function smsEstimate(text) {
  let units = 0,
    gsm = true;
  for (const c of text) {
    if (GSM.has(c)) units++;
    else if (EXT.has(c)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  // Twilio uses UTF-16 code units for UCS-2, so a supplementary emoji takes two.
  if (!gsm) units = text.length;
  const single = gsm ? 160 : 70,
    multipart = gsm ? 153 : 67;
  const segments =
    units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multipart);
  return { encoding: gsm ? 'GSM-7' : 'Unicode', units, segments };
}

export const emptyWorkspace = () => ({
  version: 1,
  view: 'messages',
  contacts: [],
  drafts: {},
  readIds: {},
  archived: {},
  scroll: {},
  recentCalls: [],
  selected: null,
  seeded: false,
  uncertain: {},
});
export const messageKey = (m) => m.sid || `${m.at}:${m.body}`;
export const inboundIds = (c) =>
  (c.messages || []).filter((m) => m.direction === 'inbound').map(messageKey);
export const unreadCount = (c, data) =>
  inboundIds(c).filter((id) => !(data.readIds[c.number] || []).includes(id))
    .length;

// Version-1 metadata from an earlier session may hold one attempt rather than a list.
export const uncertainAttempts = (value) =>
  value ? (Array.isArray(value) ? value : [value]) : [];
