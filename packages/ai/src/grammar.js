//@ts-check
/** One profile decoder and mandatory full-grammar gate for any injected compiler. */
import { JarenValidator } from '@jarenjs/validate';
import { createStructuredOutput } from './structured.js';
import { checkOutcome } from './check.js';
import { createRoutedClient } from './routing.js';

/** @param {{ client: any, grammar: 'query'|'jslt'|'app'|'fsm'|'dag'|'statechart'|'workflow'|'model', profile: any,
 *   schema: any, refs?: any[], compile: (document: any) => any, gate?: any,
 *   maxRepairs?: number, stream?: boolean, onAttempt?: any,
 *   selectModel?: any, limits?: any, onRoute?: any }} options */
export function createGrammarAuthor(options) {
  if (!['query', 'jslt', 'app', 'fsm', 'dag', 'statechart', 'workflow', 'model'].includes(options.grammar))
    throw new TypeError('unknown authored grammar');
  if (!options.profile || !options.schema || typeof options.compile !== 'function')
    throw new TypeError('grammar author needs a derived profile, full schema and compiler');
  const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
  for (const ref of options.refs ?? []) validator.addSchema(ref);
  const full = validator.compile(options.schema);
  const generate = createStructuredOutput({ client: createRoutedClient(options, { purpose: 'author', grammar: options.grammar }), schema: options.profile,
    name: `jaren_${options.grammar}`, strict: false, refs: options.refs,
    maxRepairs: options.maxRepairs, stream: options.stream ?? true, onAttempt: options.onAttempt,
    gate: [(document) => {
      const shape = checkOutcome(full(document));
      if (!shape.valid) return shape;
      try { options.compile(document); return true; }
      catch (error) { return { valid: false, errors: [{ code: error.code ?? 'AI0200',
        docPath: error.docPath ?? '', message: error.reason ?? error.message }] }; }
    }, ...[].concat(options.gate ?? [])],
  });
  return { author: (question, hooks = {}) => generate.generate([
    { role: 'system', content: `Author a ${options.grammar} document. Return only JSON. The full grammar and compiler validate every response.` },
    { role: 'user', content: question },
  ], hooks) };
}
