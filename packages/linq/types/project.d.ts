/** Structural JSON input: readonly documents and schema interfaces participate.
 * Unknown schema extension members still cross the runtime JSON boundary. */
type JsonData = string | number | boolean | null | readonly JsonData[] | { readonly [key: string]: JsonData };
export type JsonInput<T> = unknown extends T ? unknown
  : T extends JsonData ? T
    : T extends (...args: never[]) => unknown ? never
      : T extends object ? { readonly [K in keyof T]: JsonInput<T[K]> } : never;

export type FileKind = 'app' | 'jslt' | 'query' | 'state' | 'data' | 'schema' | 'fsm' | 'dag' | 'model' | 'contract';
export interface ProjectFile<Name extends string = string, Kind extends FileKind = FileKind> {
  readonly name: Name;
  readonly kind: Kind;
  readonly text: string;
}
export interface ProjectLayout {
  readonly mode?: 'classic' | 'right' | 'top';
  readonly ratio?: number;
  readonly autorun?: boolean;
}
export interface ProjectDocument {
  readonly project: '0.1';
  readonly files: readonly ProjectFile[];
  readonly active?: string;
  readonly layout?: ProjectLayout;
}
export const FILE_KINDS: readonly FileKind[];
export function file<const N extends string, K extends FileKind>(name: N, kind: K, text: string): ProjectFile<N, K>;
export function jsonFile<const N extends string, K extends FileKind, const D>(name: N, kind: K, document: D & JsonInput<D>): ProjectFile<N, K>;
/** Names are a phantom; the public document has no extra registry. */
export class ProjectBuilder<Names extends string = never> {
  protected constructor();
  readonly __names: Names;
  readonly schema: ProjectDocument;
  toJSON(): ProjectDocument;
  files<const F extends readonly ProjectFile[]>(files: F): ProjectBuilder<F[number]['name']>;
  file<const N extends string>(file: ProjectFile<N>): ProjectBuilder<Names | N>;
  active(name: Names): ProjectBuilder<Names>;
  layout(layout: ProjectLayout): ProjectBuilder<Names>;
}
export function defineProject<const F extends readonly ProjectFile[] = []>(files?: F, options?: {
  readonly active?: F[number]['name'];
  readonly layout?: ProjectLayout;
}): ProjectBuilder<F[number]['name']>;
/** No filename inference is claimed for an arbitrary raw document. */
export function from(document: ProjectDocument): ProjectBuilder<string>;
