//@ts-check
import { compileContract } from '@jarenjs/contract';
import document from '@jarenjs/studio/contracts/data.contract.json' with { type: 'json' };
/** @type {ReturnType<typeof compileContract>} */
export const dataContract = compileContract(document);
/** @type {{ $contract: string, id: string, operations: Record<string, object> } & Record<string, unknown>} */
export const dataContractDocument = document;
