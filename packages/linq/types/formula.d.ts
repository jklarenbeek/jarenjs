/** Author a saved JSON Query formula without executing it. */
export declare function defineFormula(id: string, expression: unknown, options?: {
  revision?: string;
  bindings?: Record<string, unknown>;
  inputSchema?: { id: string; version: string };
  resultSchema?: { id: string; version: string };
  helpers?: { name: string; version: string }[];
  resultMode?: 'value' | 'outcome';
}): any;
