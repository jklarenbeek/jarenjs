//@ts-check
/**
 * @file Public surface of @jarenjs/contract: `compileContract` turns a
 * `$contract` document into a frozen `Contract` (docs/CONTRACT-FORMAT.md);
 * the error classes, the `JC` code table and the `ContractFailure`
 * factory are what a host catches, reads and returns. The bindings live
 * behind their own subpaths (`./http`, `./fetch`, `./node`, `./ledger`)
 * so a consumer that only compiles never loads them. The path matcher is
 * deliberately NOT exported — it is reached only through `contract.match`
 * and `contract.allowed`.
 */

export { compileContract } from './compile.js';
export {
  ContractCompileError, ContractRuntimeError, ContractHostError,
  ContractFailure, isContractFailure, CONTRACT_CODES,
} from './errors.js';
export { contractMessagesEn, contractCatalogEn } from './messages.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('./compile.js').CompiledHttp} CompiledHttp
 * @typedef {import('./compile.js').CompiledPolicy} CompiledPolicy
 * @typedef {import('./compile.js').CompiledInput} CompiledInput
 * @typedef {import('./compile.js').CompiledOutput} CompiledOutput
 * @typedef {import('./compile.js').CompiledErrorDecl} CompiledErrorDecl
 * @typedef {import('./compile.js').InputTransport} InputTransport
 * @typedef {import('./compile.js').CompileContractOptions} CompileContractOptions
 * @typedef {import('./describe.js').ContractDescription} ContractDescription
 * @typedef {import('./describe.js').OperationDescription} OperationDescription
 * @typedef {import('./errors.js').ContractFailureValue} ContractFailureValue
 */
