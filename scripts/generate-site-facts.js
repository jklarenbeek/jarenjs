//@ts-check
import { buildSiteContent } from './generate-site-data.js';
import { docsSections } from '../packages/website/src/app/viewmodel.js';
/** The website documentation count uses the same merged content as its navigation. */
export const siteFacts = {
  name: 'site content facts',
  docs: () => ['packages/website/README.md'],
  facts: () => ({ 'site.documentation': () => `${docsSections(buildSiteContent()).length} documentation sections` }),
};
