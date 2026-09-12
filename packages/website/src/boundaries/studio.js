//@ts-check
/** Site renderers and seeds for the shared isolated document host. */
import { createStudioDocumentHost } from '@jarenjs/studio/component';
import { md, mdArticle, UNTRUSTED } from './markdown.js';
import { mermaid } from './mermaid.js';
import { STUDIO_TEMPLATES } from '../content/appTemplates.js';
const host = createStudioDocumentHost({
  markdown: source => mdArticle(md.view(source, UNTRUSTED)),
  diagram: source => mermaid.view(source), templates: STUDIO_TEMPLATES,
});
export const { validateAppDocument, STUDIO_WIDGETS, auditDocumentRender, loadStudioDocument } = host;
