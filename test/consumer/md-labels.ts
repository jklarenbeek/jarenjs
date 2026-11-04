// Accessible names in another language: a labels object of templates and
// closures reaches every md surface that renders them, and a misspelt or
// mistyped member fails to compile instead of rendering English.
import { compileMarkdown, mdToVnode, toHtml, DEFAULT_LABELS } from '@jarenjs/md';
import { createMdComponent } from '@jarenjs/md/component';

const labels = {
  pageBreak: 'Paginascheiding',
  permalink: (params: Record<string, unknown>) => `Permalink naar ${String(params.text)}`,
  backref: 'Terug naar verwijzing {number}',
};
const compiled = compileMarkdown('# Opzet\n', { headingIds: true, headingAnchors: true, labels });
const html: string = toHtml(compiled.doc, { labels, footnotesLabel: 'Voetnoten' });
const vnode: unknown = mdToVnode(compiled.doc, { labels: { backrefOccurrence: 'keer {occurrence}' } });
const md = createMdComponent({ headingIds: true, labels });
const viewed: unknown = md.view('# Opzet\n', { labels: { permalinkSection: 'Permalink naar deze sectie' } });
const english: string = DEFAULT_LABELS.permalink;
// @ts-expect-error a label member is named exactly
toHtml(compiled.doc, { labels: { pagebreak: 'Paginascheiding' } });
// @ts-expect-error a label is a template or a closure
mdToVnode(compiled.doc, { labels: { pageBreak: 1 } });
void [html, vnode, viewed, english];
