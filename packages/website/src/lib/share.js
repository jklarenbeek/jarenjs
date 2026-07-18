//@ts-check
/**
 * Share-link codec: an engine snapshot as a base64url token in the
 * `s` query param of a playground link. Unicode-safe (TextEncoder),
 * portable between browser and Node, and forgiving on the way in — a
 * corrupt token decodes to `null`, never a throw.
 */

/**
 * @param {any} snapshot - `{ e: engine, i: inputs }`
 * @returns {string} base64url token
 */
export function encodeShare(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {string} token
 * @returns {any} the snapshot, or `null` when the token is unusable
 */
export function decodeShare(token) {
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const snapshot = JSON.parse(new TextDecoder().decode(bytes));
    return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
  }
  catch {
    return null;
  }
}
