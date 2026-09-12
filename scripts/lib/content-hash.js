import { createHash } from 'node:crypto';
/** Stable serialized-document hash used by generated artifact inventories. */
export const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
