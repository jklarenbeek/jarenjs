//@ts-check
/** CRC-32 checksums for byte sequences, shared by binary format writers. */

const table = new Int32Array(256);
for (let n = 0; n < table.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  table[n] = value;
}

/**
 * The unsigned CRC-32 used by PNG and ZIP, with an initial and final XOR
 * of 0xffffffff. Reads only the supplied view; the bytes are not changed.
 * An empty sequence answers 0. This detects accidental corruption and
 * does not authenticate the input.
 * @param {Uint8Array} bytes
 * @returns {number} an unsigned 32-bit checksum
 */
export function crc32(bytes) {
  let value = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    value = table[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
