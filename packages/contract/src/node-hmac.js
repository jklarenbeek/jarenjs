//@ts-check
/**
 * @file The HMAC-SHA256 plumbing the Node-only helpers share: key
 * material, the strict base64url decoding, the MAC itself and the
 * constant-time comparison. Internal; the browser root never imports it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A key is bytes, 32–1024 of them: no shorter than the MAC (RFC 7518 §3.2). @param {unknown} value @returns {value is Uint8Array} */
export const isKeyBytes = value => value instanceof Uint8Array && value.byteLength >= 32 && value.byteLength <= 1024;

/**
 * Decode only the canonical, unpadded base64url spelling of a non-empty
 * text; anything else (padding, the standard alphabet, trailing bits) is
 * `null`.
 * @param {string} text
 * @returns {Buffer | null}
 */
export function decodeBase64url(text) {
  if (!text.length || /[^A-Za-z0-9_-]/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/**
 * HMAC-SHA256 over the parts in order, a string part as its UTF-8 bytes.
 * @param {Uint8Array} key
 * @param {readonly (string | Uint8Array)[]} parts
 * @returns {Buffer}
 */
export function hmacSha256(key, parts) {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/**
 * Whether two byte strings are equal, in time independent of where they
 * differ; a length difference answers `false` at once (a MAC's length is
 * public).
 * @param {Uint8Array} expected
 * @param {Uint8Array} presented
 * @returns {boolean}
 */
export function bytesMatch(expected, presented) {
  return expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented);
}
