/** Public app subscription composition, reused from installed packages in browsers. */
import { createApp } from '@jarenjs/app';
import { createHashRouteSubscription, createHistoryRouteSubscription } from '@jarenjs/app/routes';

export function createRouteConsumer(window, mode, existing) {
  const routes = existing ?? (mode === 'hash' ? createHashRouteSubscription : createHistoryRouteSubscription)({
    window, basePath: mode === 'hash' ? '/' : '/route-harness',
  });
  const app = createApp({ state: { route: null, count: 0 }, view: [{ match: '$', body: ['output'] }],
    actions: { arrived: { patch: [
      { op: 'replace', path: '/route', value: '$payload' },
      { op: 'replace', path: '/count', value: { $add: ['$.count', 1] } },
    ] } }, subs: [{ run: 'routes', with: { action: 'arrived' } }],
  }, { schedule: flush => flush(), subs: { routes } });
  return { app, routes };
}
