import { DocumentBuilder, snapshot, optionsOf, captureQuery } from '@jarenjs/linq/authoring';
import { checkOutcome, composeChecks } from '@jarenjs/core/check';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
import { registerWebMcp, type WebMcpResult } from '@jarenjs/contract/webmcp';

class Draft extends DocumentBuilder<{ title: string }> {}
const draft: Draft = new Draft({ title: 'plain' }).with({ title: 'edited' });
const title: string = draft.schema.title;
const immutable: Readonly<{ title: string }> = snapshot({ title });
optionsOf(immutable, ['title'], 'draft');
captureQuery<{ price: number }, never>('price', [], row => row.get('price').add(1));
// @ts-expect-error replacement uses the existing document shape
 draft.with({ title: 4 });
const valid: boolean = composeChecks(() => true)(draft.schema).valid;
void checkOutcome(valid);
const guard = createGuardedRefiner({ read: async () => ({ title }), validateProposal: () => true,
  apply: value => value, validateCandidate: () => true, planCommit: value => value, commit: async value => value });
void guard.commit({ title });
const binding = registerWebMcp([{ name: 'title', description: 'Read the title', inputSchema: { type: 'object' }, execute: () => ({ title }) }], { realm: {} });
const result: WebMcpResult = await binding.ready;
const status: WebMcpResult['status'] = result.status;
void status;
await binding.dispose();
