//@ts-check
/**
 * One shared Markdown visual component (`@jarenjs/md/component`) for the
 * whole site. The playground's Markdown tab and the docs-page README
 * dialog both derive their vnodes through `md.view(...)`, so they share
 * one memo cache: the same source string renders to the same
 * reference-equal vnode, which the DOM patcher skips in O(1).
 */

import { createMdComponent } from '@jarenjs/md/component';

export const md = createMdComponent();
