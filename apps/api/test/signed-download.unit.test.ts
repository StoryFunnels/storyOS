import { describe, expect, it } from 'vitest';
import { DOWNLOAD_URL_TTL_SECONDS, mintDownloadUrl, signDownloadUrl, verifyDownloadSignature } from '../src/files/signed-download';

const ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

describe('signed download URLs (#201)', () => {
  it('round-trips a signature', () => {
    const sig = signDownloadUrl(ID, '1700000000');
    expect(verifyDownloadSignature(ID, '1700000000', sig)).toBe(true);
  });

  it('rejects a tampered id or a tampered expires, with the SAME signature', () => {
    const sig = signDownloadUrl(ID, '1700000000');
    // Same signature, different id — must not verify (this is the "download
    // someone else's file by pasting your own valid sig onto their id" bug).
    expect(verifyDownloadSignature(OTHER_ID, '1700000000', sig)).toBe(false);
    // Same signature, extended expires — must not verify (the "strip the
    // timestamp and mint yourself more time" bug).
    expect(verifyDownloadSignature(ID, '9700000000', sig)).toBe(false);
  });

  it('does not throw on a length-mismatched signature', () => {
    expect(verifyDownloadSignature(ID, '1700000000', 'short')).toBe(false);
  });

  /**
   * The raw-bytes pin (the #42 lesson, per webhook-sender.unit.test.ts).
   *
   * A tamper test alone doesn't prove the HMAC covers the literal `expires`
   * string it was given — a verifier that did
   * `signDownloadUrl(id, String(Number(expiresParam)))` before comparing would
   * still fail an id/expires *tamper* test (different value → different hash)
   * while silently accepting a query string whose `expires` differs only in
   * formatting from what was actually signed. Only a value that round-trips
   * differently through `Number()` — but is still the same instant — tells the
   * two implementations apart.
   */
  it('signs the exact expires string it is given, not a re-parsed number', () => {
    const withLeadingZero = '01700000000'; // Number('01700000000') === 1700000000
    const canonical = '1700000000';
    expect(Number(withLeadingZero)).toBe(Number(canonical));
    expect(withLeadingZero).not.toBe(canonical);

    const sigForLeadingZero = signDownloadUrl(ID, withLeadingZero);
    const sigForCanonical = signDownloadUrl(ID, canonical);
    // Sanity: the two forms genuinely digest differently, so the assertions
    // below are not vacuously true.
    expect(sigForLeadingZero).not.toBe(sigForCanonical);

    // The exact string that was signed verifies…
    expect(verifyDownloadSignature(ID, withLeadingZero, sigForLeadingZero)).toBe(true);
    // …and a signature minted for the re-serialized form is NOT accepted for the
    // original string. This flips to `true` the moment verification re-derives
    // `expires` (e.g. via `String(Number(expiresParam))`) before hashing.
    expect(verifyDownloadSignature(ID, withLeadingZero, sigForCanonical)).toBe(false);
  });

  it('mints a URL that expires DOWNLOAD_URL_TTL_SECONDS from now and verifies', () => {
    const now = 1_700_000_000_000;
    const { url, expiresAt } = mintDownloadUrl(ID, now);
    expect(expiresAt.getTime()).toBe(now + DOWNLOAD_URL_TTL_SECONDS * 1000);
    const parsed = new URL(url, 'http://x');
    const expires = parsed.searchParams.get('expires')!;
    const sig = parsed.searchParams.get('sig')!;
    expect(Number(expires)).toBe(Math.floor(now / 1000) + DOWNLOAD_URL_TTL_SECONDS);
    expect(verifyDownloadSignature(ID, expires, sig)).toBe(true);
  });
});
