//@ts-check
/**
 * @file The shared host-widget lifecycle (the third studio forced the
 * extraction): mount boots a nested app into the host node, update
 * reboots ONLY when the document or its revision changed, unmount
 * destroys. The `mount`/`update`/`unmount` trio was byte-identical
 * between the Studio and Flow boundaries; the `destroy` halves
 * differed DELIBERATELY (Studio reports teardown failures, Flow
 * swallows them), so the factory takes both halves as parameters and
 * reconciles nothing by averaging — one factory, three callers, each
 * keeping its own policy.
 */

/**
 * @param {{ boot: (handle: any, props: any) => void,
 *   destroy: (handle: any) => void }} lifecycle
 * @returns {{ mount: Function, update: Function, unmount: Function }}
 */
export function createHostWidget({ boot, destroy }) {
  return {
    mount(host, props, emit) {
      const handle = { host, emit, app: null };
      boot(handle, props);
      return handle;
    },
    update(handle, props, prevProps) {
      if (props.doc === prevProps.doc && props.revision === prevProps.revision) return;
      destroy(handle);
      boot(handle, props);
    },
    unmount(handle) {
      destroy(handle);
    },
  };
}
