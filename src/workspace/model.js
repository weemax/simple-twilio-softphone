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
  // Photos attached to each recipient's draft, as the local service described
  // them ({ id, type, bytes, width, height, name }). The bytes stay in the
  // service's photo folder; nothing is uploaded until Send.
  attachments: {},
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

// Photos (accepted TWP-9 piece 4). The limits mirror server/photoPolicy.js, which
// enforces them; the composer reads them from the service's policy answer and
// uses these only until that answer arrives.
export const PHOTO_LIMITS = { maxPhotos: 10, maxBytes: 5 * 1024 * 1024 };

export const photoLabel = (count) =>
  count === 1 ? 'Photo' : `${count} photos`;

// What a conversation row or notification says for a message: its text, or
// for a photo-only message the photos.
export const messageSummary = (message) =>
  message?.body || (message?.media?.length ? photoLabel(message.media.length) : '');

export function utf8Length(text) {
  let bytes = 0;
  for (const c of text) {
    const code = c.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Text and photos together, in bytes: the figure the 5 MB limit applies to.
export const messageBytes = (text, photos) =>
  utf8Length(text) + photos.reduce((sum, p) => sum + p.bytes, 0);

export const formatSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// The same message to the same number: the same words and the same photos.
export const sameContent = (a, b) =>
  a.body === b.body &&
  (a.media || []).join() === (b.media || []).join();
