// Whether a photo message may be sent, and why not in words a person can act on.
//
// Accepted limits (docs/phone-ux-plan.md, piece 4): the United States and Canada
// only, at most 10 photos, JPEG and PNG only, text and photos together under
// 5 MB, links that last 24 hours. Every check here runs before anything is
// stored as sent, linked or handed to Twilio.

const { US, CA } = require('./nanpAreaCodes');

const MAX_PHOTOS = 10;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024; // text and photos together, exclusive
const LINK_HOURS = 24;

// 'US' | 'CA' | null for an E.164 number. +1 alone does not decide it: the
// area code does (see nanpAreaCodes.js). A number that is not +1 is not here.
function photoCountry(e164) {
  const m = /^\+1([2-9]\d{2})\d{7}$/.exec(e164 || '');
  if (!m) return null;
  const area = Number(m[1]);
  if (CA.has(area)) return 'CA';
  if (US.has(area)) return 'US';
  return null;
}

const COUNTRY_NAMES = { US: 'the United States', CA: 'Canada' };

// Everything that can stop a photo message, as { code, message } or null.
//   to           E.164 recipient
//   photos       descriptions of the photos to send ({ bytes })
//   textBytes    UTF-8 size of the caption
//   publicBaseUrl  the tunnel address Twilio fetches photos from, or null
//   sender       the number photos send from, or null
//   senderMms    'yes' | 'no' | 'unknown'
function checkPhotoSend({ to, photos, textBytes, publicBaseUrl, sender, senderMms }) {
  if (photos.length > MAX_PHOTOS) {
    return { code: 'too-many', message: `A message can carry up to ${MAX_PHOTOS} photos.` };
  }
  const total = photos.reduce((sum, p) => sum + p.bytes, 0) + textBytes;
  if (total >= MAX_MESSAGE_BYTES) {
    return {
      code: 'too-large',
      message: 'The text and photos together must be under 5 MB. Remove a photo or shorten the text.',
    };
  }
  if (!photoCountry(to)) {
    return {
      code: 'unsupported-country',
      message:
        'Photos can be sent only to numbers in the United States and Canada. ' +
        'This number is somewhere else, so send text only.',
    };
  }
  if (!sender) {
    return { code: 'no-sender', message: 'No sending number is set up. Open Settings → Twilio account.' };
  }
  if (senderMms === 'no') {
    return {
      code: 'sender-no-mms',
      message: 'Your Twilio number cannot send photos (MMS). Choose a number that can, or send text only.',
    };
  }
  if (!publicBaseUrl) {
    return {
      code: 'no-public-address',
      message:
        'Photos need Operator’s public address, so Twilio can fetch them. Start with npm run phone, ' +
        'or set PUBLIC_BASE_URL. Nothing was sent.',
    };
  }
  return null;
}

module.exports = {
  photoCountry,
  checkPhotoSend,
  COUNTRY_NAMES,
  MAX_PHOTOS,
  MAX_MESSAGE_BYTES,
  LINK_HOURS,
};
