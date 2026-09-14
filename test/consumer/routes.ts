import { createHashRouteSubscription, createHistoryRouteSubscription, type RouteRecord, type RouteSubscription } from '@jarenjs/app/routes';
const routes: RouteSubscription = createHistoryRouteSubscription({ window, basePath: '/app', maxTurns: 16 });
const stop: () => void = routes({ action: 'arrived' }, (_action, route: Readonly<RouteRecord>) => {
  const values: readonly string[] | undefined = route.query.tag;
  const mode: 'hash' | 'history' = route.mode;
  void [values, mode, route.raw, route.path, route.fragment];
});
routes.navigate('/app/next'); routes.replace('/app/final'); routes.refresh(); stop(); routes.dispose();
createHashRouteSubscription({ maxQueryEntries: 32 });
// @ts-expect-error a subscription must name its action
routes({}, () => {});
// @ts-expect-error replace policy is a boolean
routes.navigate('/app', { replace: 'yes' });
// @ts-expect-error URLs are explicit strings
routes.navigate({ path: '/app' });
