//@ts-check
/**
 * @jarenjs/md - Markdown + frontmatter as JSON documents.
 *
 * parseMarkdown turns Markdown (CommonMark core + GFM tables,
 * strikethrough, task lists, footnotes and autolink literals +
 * YAML/JSON/TOML frontmatter) into a plain
 * JSON AST the rest of the suite consumes natively: JSLT/JTLT and
 * query documents transform it, `mdToVnode` projects it to
 * @jarenjs/view vnodes with content-hash keys, `toMarkdown` prints
 * canonical round-trip text, and `loadMarkdown`/`streamMarkdown` pull
 * documents lazily from any URL with caching, AbortSignal and
 * block-by-block streaming. Extensibility is compile-time plugins
 * (`definePlugin`, `@jarenjs/md/plugins`) baked into dispatch tables.
 *
 * The normative contracts: docs/MD-FORMAT.md (AST + frontmatter),
 * docs/PLUGINS.md (plugin system), docs/LOADER.md (loader).
 */

export {
  parseMarkdown,
  createIncrementalParser,
  buildPluginTables,
} from './parser.js';

export {
  compileMarkdown,
  frontmatterExternals,
  mdToForm,
} from './compiler.js';

export {
  loadMarkdown,
  streamMarkdown,
  createMdCache,
  defaultMdCache,
} from './loader.js';

export { toMarkdown } from './to-md.js';

export { toHtml } from './to-html.js';

export {
  mdToVnode,
  createMdRenderer,
} from './to-vnode.js';

export {
  scanDirectives,
  replaceDirectives,
  scanSourceDirectives,
  parseMarker,
} from './directives.js';

export { bake } from './bake.js';

export { definePlugin } from './plugins/index.js';

export { parseHtmlFragment, parseHtmlTag } from './html.js';

export {
  MD_VERSION,
  walkAst,
  visitAst,
  textOf,
  isContainerNode,
} from './ast.js';

export {
  parseFrontmatter,
  parseYamlSubset,
  parseTomlSubset,
  MdFrontmatterError,
} from './frontmatter.js';

export { hashContent } from './utils.js';
