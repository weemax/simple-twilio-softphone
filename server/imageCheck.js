// What an image file actually is, judged from its bytes alone.
//
// Photos are JPEG or PNG only. The name, the Content-Type a browser sent and
// the type Twilio declared for incoming media are never trusted: the file must
// carry the signature and a well-formed structure of one of the two formats.
// A truncated file, a renamed GIF/HEIC/PDF, a PNG with a damaged chunk and a
// PNG with data appended after its end are all refused.
//
// This does not decode pixels (nothing here compresses or re-encodes an image),
// so the structure is the evidence: PNG chunk lengths, CRCs, header values,
// IDAT presence and a valid zlib header, and an IEND with nothing after it;
// JPEG markers, segment lengths, a frame header with real dimensions, at least
// one scan, and the end-of-image marker. Dimensions are bounded so a tiny file
// cannot claim to be gigantic.

const MAX_DIMENSION = 20000;
const MAX_PIXELS = 100 * 1000 * 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = null;
function crc32(buf, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bad(reason) {
  return { ok: false, reason };
}

function sizeOk(width, height) {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    width * height <= MAX_PIXELS
  );
}

// PNG color type -> allowed bit depths.
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function inspectPng(buf) {
  let pos = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawPalette = false;
  let colorType = 0;
  let firstData = null;
  for (;;) {
    if (pos + 12 > buf.length) return bad('The PNG ends before its last section.');
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return bad('The PNG has a damaged section.');
    const dataStart = pos + 8;
    const crcAt = dataStart + length;
    if (length > 0x7fffffff || crcAt + 4 > buf.length) return bad('The PNG ends before its last section.');
    if (crc32(buf, pos + 4, crcAt) !== buf.readUInt32BE(crcAt)) return bad('The PNG has a damaged section.');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return bad('The PNG does not start with a valid header.');
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      const depth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filter = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];
      if (!sizeOk(width, height)) return bad('The photo is empty or has impossible dimensions.');
      if (!(PNG_DEPTHS[colorType] || []).includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) {
        return bad('The PNG has a damaged header.');
      }
      sawHeader = true;
    } else if (type === 'IHDR') {
      return bad('The PNG has a second header.');
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 768) return bad('The PNG has a damaged palette.');
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (length >= 2 && firstData === null) firstData = buf.readUInt16BE(dataStart);
      if (length > 0) sawData = true;
    } else if (type === 'IEND') {
      if (length !== 0) return bad('The PNG has a damaged end.');
      if (crcAt + 4 !== buf.length) return bad('The PNG has extra data after its end.');
      if (!sawData) return bad('The PNG has no picture data.');
      if (colorType === 3 && !sawPalette) return bad('The PNG is missing its palette.');
      // The picture data is one zlib stream: deflate, 32 KB window, valid check bits.
      if (firstData === null || ((firstData >> 8) & 0x0f) !== 8 || firstData % 31 !== 0) {
        return bad('The PNG picture data is damaged.');
      }
      return { ok: true, type: 'image/png', width, height };
    }
    pos = crcAt + 4;
  }
}

function inspectJpeg(buf) {
  let pos = 2; // after SOI
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let scans = 0;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return bad('The JPEG has a damaged section.');
    while (buf[pos] === 0xff) pos++; // fill bytes
    const marker = buf[pos];
    pos++;
    if (marker === undefined) break;
    if (marker === 0xd9) {
      if (!sawFrame || !scans) return bad('The JPEG has no picture data.');
      return { ok: true, type: 'image/jpeg', width, height };
    }
    if (marker === 0x00) return bad('The JPEG has a damaged section.');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length
    if (pos + 2 > buf.length) return bad('The JPEG ends before its last section.');
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) return bad('The JPEG ends before its last section.');
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (sawFrame) return bad('The JPEG has a second frame.');
      if (length < 8) return bad('The JPEG has a damaged header.');
      height = buf.readUInt16BE(pos + 3);
      width = buf.readUInt16BE(pos + 5);
      const components = buf[pos + 7];
      if (!sizeOk(width, height)) return bad('The photo is empty or has impossible dimensions.');
      if (components < 1 || components > 4 || length !== 8 + components * 3) {
        return bad('The JPEG has a damaged header.');
      }
      sawFrame = true;
    }
    pos += length;
    if (marker === 0xda) {
      if (!sawFrame) return bad('The JPEG scan comes before its header.');
      scans++;
      // Entropy-coded data runs until a marker that is not a stuffed 0xFF00 or a restart.
      for (;;) {
        const ff = buf.indexOf(0xff, pos);
        if (ff === -1 || ff + 1 >= buf.length) return bad('The JPEG ends before its last section.');
        const next = buf[ff + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos = ff + 2;
          continue;
        }
        pos = ff;
        break;
      }
    }
  }
  return bad('The JPEG ends before its last section.');
}

// { ok: true, type, width, height } or { ok: false, reason } in words to show a person.
function inspectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return bad('The file is not a JPEG or PNG photo.');
  if (buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return inspectPng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return inspectJpeg(buf);
  return bad('The file is not a JPEG or PNG photo.');
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png' };

module.exports = { inspectImage, EXTENSIONS, MAX_DIMENSION };
