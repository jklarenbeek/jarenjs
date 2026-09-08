import type { Json } from './schema.js';
import type { CatalogIds, MessageParameters } from './message-vocabulary.js';
export type { CatalogIds, MessageParameters } from './message-vocabulary.js';
export type CatalogSource = keyof CatalogIds | 'all';
export type Msgid<S extends CatalogSource = 'all'> = S extends keyof CatalogIds ? CatalogIds[S] : keyof MessageParameters;
export type CatalogDocument<I extends string = Msgid> = Readonly<Record<I, string>>;
type Present<D> = string extends keyof D ? never : {
  [K in keyof D]-?: {} extends Pick<D, K> ? never : K
}[keyof D] & string;
// A union-valued id adds one unknown member, not every member of that union.
type SingleId<I, Whole = I> = I extends unknown ? [Whole] extends [I] ? I : never : never;
export const CATALOGS: { readonly [S in keyof CatalogIds]: { readonly [I in CatalogIds[S]]: readonly (I extends keyof MessageParameters ? MessageParameters[I] : never)[] } };
export class CatalogBuilder<S extends CatalogSource = 'all', P extends string = never> {
  protected constructor();
  readonly __source: S;
  readonly __present: P;
  entry<I extends Msgid<S>>(id: I, template: string): CatalogBuilder<S, P | SingleId<I>>;
  entries<const D extends Partial<Record<Msgid<S>, string>>>(values: D & Record<Exclude<keyof D, Msgid<S>>, never>): CatalogBuilder<S, P | Present<D>>;
  partial(): CatalogDocument<P>;
  complete(this: Exclude<Msgid<S>, P> extends never ? CatalogBuilder<S, P> : never): CatalogDocument<Msgid<S>>;
  toJSON(this: Exclude<Msgid<S>, P> extends never ? CatalogBuilder<S, P> : never): CatalogDocument<Msgid<S>>;
}
export function catalog<S extends CatalogSource = 'all'>(source?: S, locale?: string): CatalogBuilder<S>;
/** Raw drafts remain subject to runtime key/placeholder checks at either exit. */
export function from<const D extends Record<string, string>, S extends CatalogSource = 'all'>(document: D, options?: { readonly source?: S; readonly locale?: string }): CatalogBuilder<S, Present<D>>;
export function inline(template: string): string;
export interface MessageSpec<I extends Msgid = Msgid> {
  readonly $msgid: I;
  readonly message?: string;
  readonly params?: [MessageParameters[I]] extends [never] ? Readonly<Record<string, never>> : Readonly<Partial<Record<MessageParameters[I], Json>>>;
}
export function message<I extends Msgid>(id: I, options?: Omit<MessageSpec<I>, '$msgid'>): MessageSpec<I>;
