/**
 * Redaction tests.
 *
 * The cases that matter are the ones where redaction is *expected to fail*, and
 * they are here as much as the passing ones. A safety mechanism whose test
 * suite only demonstrates its successes is how you end up believing a regex is
 * a control.
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

import { DefaultRedactor, detect, blackOutRegions, atSink } from '../dist/index.js';

const redactor = new DefaultRedactor();

// ---------------------------------------------------------------------------
// Detection: what it catches
// ---------------------------------------------------------------------------

test('a payment card that passes Luhn is high confidence', () => {
  const [found] = detect('card 4111 1111 1111 1111 on file');
  assert.equal(found.entity, 'PAYMENT_CARD');
  assert.equal(found.classification, 'financial');
  assert.ok(found.confidence > 0.9);
});

test('a digit run that fails Luhn is reported with low confidence, not silently', () => {
  const found = detect('reference 4111111111111112', 0.1);
  assert.equal(found[0].entity, 'PAYMENT_CARD');
  assert.ok(found[0].confidence < 0.5, 'a failed checksum must lower confidence');
});

test('a credential assignment is classified secret', () => {
  for (const line of ['CUA_APP_PASSWORD=hunter2xyz', 'token: abcd1234efgh', 'api_key = "zzzz9999"']) {
    const [found] = detect(line);
    assert.equal(found?.classification, 'secret', line);
  }
});

test('the bearer scheme is not mistaken for the token it introduces', () => {
  const { text } = redactor.redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9');
  assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(text, /Bearer \[REDACTED:BEARER_TOKEN\]/);
});

test('a credential keyword in prose does not swallow the next word', () => {
  // A redactor that shreds ordinary sentences gets turned off, so this is a
  // deliberate non-detection rather than a gap.
  assert.match(redactor.redactText('please reset your password today').text, /password today/);
});

test("the application's own account numbers are recognised", () => {
  const [found] = detect('posted to SV-0012345 overnight');
  assert.equal(found.entity, 'FINANCIAL_ACCOUNT');
});

test('money is financial', () => {
  const [found] = detect('balance $4,231.08');
  assert.equal(found.entity, 'MONEY');
  assert.equal(found.classification, 'financial');
});

test('a labelled member number is an identifier; a bare five-digit run is not', () => {
  const labelled = detect('member id 12345');
  assert.equal(labelled[0].entity, 'MEMBER_ID');

  // Deliberate: redacting every five-digit number would shred the evidence logs
  // this system depends on. See the recognizer comment in detect.ts.
  assert.equal(detect('waited 12345 ms').length, 0);
});

test('a member name in the vendor record format is pii, with or without an initial', () => {
  // The leak that motivated this recognizer: the model read the name off the
  // member detail screen and wrote it into its own free-text run summary.
  const summary = detect('opened the member detail page (Renner, Alice M) and read the balance');
  assert.equal(summary[0].entity, 'PERSON_NAME');
  assert.equal(summary[0].classification, 'pii');

  assert.equal(detect('Kwon, Dana')[0]?.entity, 'PERSON_NAME', 'a middle initial is optional');
  assert.equal(detect('Lo, Susan')[0]?.entity, 'PERSON_NAME', 'so is a long surname');

  // Prose without the surname-first comma is out of reach, and the header says
  // so. This asserts the limitation rather than papering over it.
  assert.equal(detect('spoke to Alice Renner about the account').length, 0);
});

test('overlapping detections are reported once, as the strongest', () => {
  const found = detect('card 4111 1111 1111 1111');
  assert.equal(found.length, 1, 'a card must not also be reported as a digit run');
});

// ---------------------------------------------------------------------------
// Redaction: the text is scrubbed and the audit record is not the leak
// ---------------------------------------------------------------------------

test('redacted text no longer contains the value', () => {
  const { text, found } = redactor.redactText('member Alice, card 4111 1111 1111 1111, bal $4,231.08');
  assert.doesNotMatch(text, /4111/);
  assert.doesNotMatch(text, /4,231\.08/);
  assert.match(text, /\[REDACTED:PAYMENT_CARD\]/);
  assert.equal(found.length, 2);
});

test('the audit record carries counts and confidence but never the value', () => {
  const { found } = redactor.redactText('cards 4111 1111 1111 1111 and 5500 0000 0000 0004');
  const record = found.find((f) => f.entity === 'PAYMENT_CARD');
  assert.equal(record.count, 2);
  assert.ok(record.confidence > 0.9);
  assert.equal(
    Object.values(record).some((v) => String(v).includes('4111')),
    false,
    'the record must not embed the detected value',
  );
});

test('sink is recorded so a prompt leak and a log leak are distinguishable', () => {
  const { found } = redactor.redactText('token: abcd1234efgh');
  assert.equal(found[0].sink, 'log');
  assert.equal(atSink(found, 'prompt')[0].sink, 'prompt');
});

// ---------------------------------------------------------------------------
// Known values: the strong mechanism
// ---------------------------------------------------------------------------

test('a supplied parameter value is removed wherever it appears', () => {
  const scoped = redactor.withParameters({ memberId: '12345' }, { memberId: 'identifier' });
  const { text } = scoped.redactText('navigated to /admin/detail.htm?mid=12345 for 12345');
  assert.doesNotMatch(text, /12345/);
  assert.match(text, /\[REDACTED:SUPPLIED_IDENTIFIER\]/);
});

test('a value classified none is left alone', () => {
  const scoped = redactor.withParameters({ branch: 'Northgate' }, { branch: 'none' });
  assert.match(scoped.redactText('branch Northgate').text, /Northgate/);
});

test('known values do not leak between runs', () => {
  const a = redactor.withParameters({ memberId: '12345' }, { memberId: 'identifier' });
  redactor.withParameters({ memberId: '67890' }, { memberId: 'identifier' });
  assert.match(a.redactText('67890').text, /67890/, 'each redactor is independent');
});

test('classify anchors on the whole value, so a field is judged as a field', () => {
  assert.equal(redactor.classify('$4,231.08').classification, 'financial');
  assert.equal(redactor.classify('active').classification, 'none');
  // A sentence that merely contains money is not itself a money field.
  assert.equal(redactor.classify('the balance is $4,231.08 today').classification, 'none');
});

// ---------------------------------------------------------------------------
// Honest limits. These document what this mechanism does NOT do.
// ---------------------------------------------------------------------------

test("a name outside the vendor's record format is not detected, and we say so", () => {
  // The record format `Renner, Alice M` is covered by PERSON_NAME; the same
  // person written the way a human writes it is not, and no regex will fix that.
  // The honest limit moved — it did not go away. REPORT §6.
  const { text } = redactor.redactText('spoke with Alice Renner about the account');
  assert.match(text, /Alice Renner/, 'regex detection cannot find arbitrary names');
});

test('an account number written in words is not detected', () => {
  const { text } = redactor.redactText('account ess vee zero zero one two three four five');
  assert.match(text, /ess vee/);
});

// ---------------------------------------------------------------------------
// Screenshot blackout
// ---------------------------------------------------------------------------

/** A minimal RGBA PNG of a solid colour, built by hand so the test has no deps. */
function makePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = rgba[0];
      raw[at + 1] = rgba[1];
      raw[at + 2] = rgba[2];
      raw[at + 3] = rgba[3];
    }
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td), 0);
    return Buffer.concat([len, td, c]);
  };

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read a pixel back out of a PNG this module produced.
 *
 * Only handles what `blackOutRegions` emits — 8-bit RGBA, filter 0 on every
 * scanline — which is enough to assert on actual pixels rather than on "the
 * bytes changed".
 */
function pixelAt(png, x, y) {
  const buf = Buffer.from(png);
  let offset = 8;
  let width = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') width = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const at = y * (stride + 1) + 1 + x * 4;
  assert.equal(raw[y * (stride + 1)], 0, 'this helper assumes filter 0');
  return [raw[at], raw[at + 1], raw[at + 2], raw[at + 3]];
}

test('blacking out a region blackens those pixels and leaves the rest alone', async () => {
  const png = makePng(20, 10, [255, 0, 0, 255]);
  const out = await redactor.redactImage(png, [[2, 2, 5, 5]]);

  assert.deepEqual(pixelAt(out, 3, 3), [0, 0, 0, 255], 'inside the region');
  assert.deepEqual(pixelAt(out, 0, 0), [255, 0, 0, 255], 'outside the region');
  assert.deepEqual(pixelAt(out, 7, 7), [255, 0, 0, 255], 'just past the far corner');
  assert.deepEqual(pixelAt(out, 6, 6), [0, 0, 0, 255], 'the far corner itself');
});

test('regions are clipped to the image rather than overflowing it', async () => {
  const png = makePng(8, 8, [10, 20, 30, 255]);
  const out = await redactor.redactImage(png, [[-4, -4, 6, 6]]);
  assert.deepEqual(pixelAt(out, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(out, 3, 3), [10, 20, 30, 255]);
});

test('no regions means the image is returned untouched', async () => {
  const png = makePng(4, 4, [1, 2, 3, 255]);
  const out = await redactor.redactImage(png, []);
  assert.equal(Buffer.compare(Buffer.from(out), png), 0);
});

test('an unsupported image fails loudly rather than passing an unredacted one through', () => {
  assert.throws(() => blackOutRegions(Buffer.from('not a png at all'), [[0, 0, 1, 1]]), /not a PNG/);
});
