import type { Json } from './schema.js';
import type { ExprBase, UnknownExpr } from './index.js';
export type Query = Json | ((value: UnknownExpr) => ExprBase<unknown> | Json);
export interface ChunkOptions { readonly strategy?: 'size' | 'line' | 'separator'; readonly size?: number }
export interface GrepOptions { readonly pattern: string; readonly flags?: 'i' | 'm' | 'im' | ''; readonly limit?: number }
export interface AnswerOptions { readonly chars?: number }
export interface StepOptions {
  chunk: ChunkOptions; grep: GrepOptions; select: { readonly query: Json };
  stat: {}; peek: {}; map: { readonly prompt: string }; reduce: { readonly query: Json }; answer: AnswerOptions;
}
export type Operation = keyof StepOptions;
export type Step<K extends Operation, F extends string = string, N extends string = string> = {
  readonly op: K; readonly from: F;
} & (K extends 'answer' ? {} : { readonly as: N }) & StepOptions[K];
export type StepDocument = { [K in Operation]: Step<K> }[Operation];
export interface ProgramDocument { readonly steps: readonly StepDocument[] }
export function chunk<const F extends string, const N extends string>(from: F, as: N, options?: ChunkOptions): Step<'chunk', F, N>;
export function grep<const F extends string, const N extends string>(from: F, as: N, options: GrepOptions): Step<'grep', F, N>;
export function select<const F extends string, const N extends string>(from: F, as: N, query: Query): Step<'select', F, N>;
export function stat<const F extends string, const N extends string>(from: F, as: N): Step<'stat', F, N>;
export function peek<const F extends string, const N extends string>(from: F, as: N): Step<'peek', F, N>;
export function map<const F extends string, const N extends string>(from: F, as: N, prompt: string): Step<'map', F, N>;
export function reduce<const F extends string, const N extends string>(from: F, as: N, query: Query): Step<'reduce', F, N>;
export function answer<const F extends string>(from: F, options?: AnswerOptions): Step<'answer', F>;

type Kind = Exclude<Operation, 'answer'> | 'slot';
type Bindings = Record<string, Kind>;
type Names<B, K extends Kind = Kind> = { [N in keyof B]: B[N] extends K ? N : never }[keyof B] & string;
type Single<B> = Names<B, Exclude<Kind, 'chunk' | 'map'>>;
type Fresh<B, N extends string> = N extends keyof B ? B[N] extends 'slot' ? N : never : N;
type Add<B, N extends string, K extends Kind> = Omit<B, N> & Record<N, K>;
type InputFor<B, K extends Operation> = K extends 'reduce' ? Names<B, 'map'> : K extends 'select' | 'answer' ? Single<B> : Names<B>;
type StepKeys<K extends Operation> = 'op' | 'from' | (K extends 'answer' ? never : 'as') | keyof StepOptions[K];
type CheckStep<B, T extends StepDocument> = Exclude<keyof T, StepKeys<T['op']>> extends never ? T['from'] extends InputFor<B, T['op']>
  ? T extends { readonly as: infer N extends string } ? N extends Fresh<B, N> ? unknown : never : unknown : never : never;
type AfterStep<B, T extends StepDocument> = T extends { readonly as: infer N extends string; readonly op: infer K extends Kind } ? Add<B, N, K> : B;
export class ProgramBuilder<B extends Bindings = {}, Done extends boolean = false> {
  protected constructor();
  readonly __bindings: B;
  readonly __done: Done;
  readonly schema: ProgramDocument;
  toJSON(): ProgramDocument;
  step<const T extends StepDocument>(this: ProgramBuilder<B, false>, step: T & CheckStep<B, T>): ProgramBuilder<AfterStep<B, T>, T['op'] extends 'answer' ? true : false>;
  chunk<N extends string>(this: ProgramBuilder<B, false>, from: Names<B>, as: Fresh<B, N>, options?: ChunkOptions): ProgramBuilder<Add<B, N, 'chunk'>>;
  grep<N extends string>(this: ProgramBuilder<B, false>, from: Names<B>, as: Fresh<B, N>, options: GrepOptions): ProgramBuilder<Add<B, N, 'grep'>>;
  select<N extends string>(this: ProgramBuilder<B, false>, from: Single<B>, as: Fresh<B, N>, query: Query): ProgramBuilder<Add<B, N, 'select'>>;
  stat<N extends string>(this: ProgramBuilder<B, false>, from: Names<B>, as: Fresh<B, N>): ProgramBuilder<Add<B, N, 'stat'>>;
  peek<N extends string>(this: ProgramBuilder<B, false>, from: Names<B>, as: Fresh<B, N>): ProgramBuilder<Add<B, N, 'peek'>>;
  map<N extends string>(this: ProgramBuilder<B, false>, from: Names<B>, as: Fresh<B, N>, prompt: string): ProgramBuilder<Add<B, N, 'map'>>;
  reduce<N extends string>(this: ProgramBuilder<B, false>, from: Names<B, 'map'>, as: Fresh<B, N>, query: Query): ProgramBuilder<Add<B, N, 'reduce'>>;
  answer(this: ProgramBuilder<B, false>, from: Single<B>, options?: AnswerOptions): ProgramBuilder<B, true>;
}
export function program<const S extends readonly string[] = []>(slots?: S): ProgramBuilder<Record<S[number], 'slot'>>;
/** Raw documents make no binding-order or terminal-state inference. */
export function from(document: ProgramDocument): ProgramBuilder<Record<string, Kind>, boolean>;
