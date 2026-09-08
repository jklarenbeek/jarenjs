import { catalog, from, message, inline, type Msgid, type CatalogDocument } from '@jarenjs/linq/messages';
import { contractMessagesEn } from '@jarenjs/contract';
const complete = catalog('contract', 'en').entries(contractMessagesEn).complete();
const document: CatalogDocument<Msgid<'contract'>> = complete;
void document;
catalog('forms', 'en').entry('form/required', 'Required').partial();
from(contractMessagesEn, { source: 'contract' }).complete();
message('minimum', { params: { limit: 3 }, message: 'At least {limit}' });
message('form/required', { params: {} });
declare const optionalEntries: Partial<Record<Msgid<'forms'>, string>>;
declare const chosenId: Msgid<'forms'>;
// @ts-expect-error optional keys do not prove that every entry is present
catalog('forms').entries(optionalEntries).complete();
// @ts-expect-error one union-valued id is not every id in its union
catalog('forms').entry(chosenId, 'Required').complete();
// @ts-expect-error a parameterless message has no accepted parameter names
message('form/required', { params: { typo: 1 } });
inline('Custom {value}');
// @ts-expect-error incomplete catalog
catalog('contract').entry('contract/not-found', 'missing').complete();
// @ts-expect-error undeclared id
catalog('contract').entry('contract/typo', 'oops');
// @ts-expect-error wrong keyspace
catalog('forms').entry('minimum', 'at least {limit}');
// @ts-expect-error extra id in bulk entry
catalog('forms').entries({ 'form/required': 'Required', typo: 'no' });
// @ts-expect-error function renderers are not JSON catalog entries
catalog('forms').entry('form/required', () => 'Required');
// @ts-expect-error undeclared message id
message('missing');
// @ts-expect-error undeclared parameter
message('minimum', { params: { typo: 3 } });
// @ts-expect-error dynamic key map does not prove completeness
from({} as Record<string, string>, { source: 'forms' }).complete();
import { compileMessageTemplate } from '@jarenjs/core/message';
const parameters: readonly string[] = compileMessageTemplate('{n}').parameters;
void parameters;
// @ts-expect-error compiler metadata is readonly
compileMessageTemplate('{n}').parameters.push('other');
