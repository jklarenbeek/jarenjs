import type { ExprBase, UnknownExpr } from './index.js';
import type { Json, JsonSchema } from './schema.js';

export type Match = string | { readonly path?: string; readonly schema?: JsonSchema };
export type Output = 'text' | 'xml';
export type Segment = string | Readonly<Record<string, Json>> | readonly Segment[];
export interface RuleDocument {
  readonly match?: Match;
  readonly mode?: string;
  readonly priority?: number;
  readonly body: readonly Segment[];
}
export type TemplateDocument = readonly RuleDocument[] | {
  readonly $jtlt: '0.1';
  readonly output?: Output;
  readonly rules: readonly RuleDocument[];
};
export type QueryInput<N extends string = never> = Json | ((value: UnknownExpr, externals: Readonly<Record<N | 'root' | 'path', UnknownExpr>>) => ExprBase<unknown> | Json);
export interface QueryOptions<N extends string> { readonly externals?: readonly N[] }
export function text(value: string): string;
export function query<N extends string = never>(value: QueryInput<N>, options?: QueryOptions<N>): string | Readonly<Record<string, Json>>;
export function raw<N extends string = never>(value: QueryInput<N>, options?: QueryOptions<N>): { readonly $raw: Json };
export function json<N extends string = never>(value: QueryInput<N>, options?: QueryOptions<N>): { readonly $json: Json };
export function apply<N extends string = never>(value: QueryInput<N>, mode?: string, options?: QueryOptions<N>): { readonly $apply: Json };
export class RuleBuilder {
  protected constructor();
  readonly schema: RuleDocument;
  toJSON(): RuleDocument;
  body(value: readonly Segment[]): RuleBuilder;
  match(value: Match): RuleBuilder;
  mode(value: string): RuleBuilder;
  priority(value: number): RuleBuilder;
}
export function rule(body?: readonly Segment[], options?: Omit<RuleDocument, 'body'>): RuleBuilder;
export class TemplateBuilder {
  protected constructor();
  readonly schema: TemplateDocument;
  toJSON(): TemplateDocument;
  rules(values: readonly (RuleBuilder | RuleDocument)[]): TemplateBuilder;
  rule(value: RuleBuilder | RuleDocument): TemplateBuilder;
  output(value: Output): TemplateBuilder;
}
export function stylesheet(rules?: readonly (RuleBuilder | RuleDocument)[], options?: { readonly output?: Output }): TemplateBuilder;
export function bare(rules?: readonly (RuleBuilder | RuleDocument)[]): TemplateBuilder;
export function from(document: TemplateDocument): TemplateBuilder;
