//@ts-check
/** Standalone public-package virtual interaction example; business writes stay in the host. */
import { mountCollection, mountCollectionDrag, createDraggableCollectionWidget } from '@jarenjs/collection/component';
import { createDomRenderer } from '@jarenjs/view';

/** @param {HTMLElement} host @param {any} [options] */
export function mountDragGrid(host, options = {}) {
  const keys = Array.from({ length: 10000 }, (_, index) => `row-${index}`);
  const columns = ['day-a', 'day-b', 'day-c', 'day-d', 'day-e'];
  const items = new Map([['item-a', { key: 'item-a', revision: 1 }]]);
  let source = { container: 'left', key: 'row-2', column: 'day-a' };
  const commands = [], containers = [], hosts = [];
  let permission = true, commandResult = true, permissionResolve = null;
  let visits = 0;
  for (const id of ['left', 'right']) {
    const node = host.ownerDocument.createElement('section'); hosts.push(node); host.appendChild(node);
    node.style.width = '420px'; node.style.overflow = 'hidden';
    const mounted = mountCollection(node, { count: keys.length, keyAt: (i) => keys[i], indexOf: (key) => keys.indexOf(key),
      getItem: (i) => { visits++; return { key: keys[i] }; }, height: 264, columnCount: columns.length,
      columnSize: 120, overscan: 1, rowPins: [0], rowPinBudget: 3, columnPinBudget: 3,
      renderCell: (row, column) => id === source.container && row.key === source.key && columns[column] === source.column
        ? ['button', { 'data-jc-drag': 'item-a', style: { touchAction: 'none' } }, 'Move item']
        : column === 1 && row.key === 'row-3' ? ['input', { 'aria-label': 'Editable note', value: 'Type here' }] : `${row.key} ${columns[column]}`,
      ...options.collection,
    });
    containers.push({ id, mounted, columnKey: (i) => columns[i], indexOfColumn: (key) => columns.indexOf(key) });
  }
  const drag = mountCollectionDrag(containers, { resolveSource: (key) => items.get(key), locateSource: () => source,
    validTarget: () => true, disabled: (target) => options.disabled === target.key,
    validate: () => permission === 'pending' ? new Promise((resolve) => { permissionResolve = resolve; }) : permission,
    commit: (intent) => { if (commandResult === false) return false; commands.push(intent); return true; },
    ...options.drag,
  });
  return {
    drag, containers, commands, keys, columns, items,
    setPermission(value) { permission = value; },
    resolvePermission(value) { permissionResolve?.(value); },
    setCommandResult(value) { commandResult = value; },
    reset() { for (const container of containers) container.mounted.update({ snapshot: 'reset' }); },
    reorder() { [keys[2], keys[4]] = [keys[4], keys[2]]; for (const container of containers) container.mounted.update({}); },
    removeSource() { items.delete('item-a'); for (const container of containers) container.mounted.update({}); },
    moveSource(target) { source = target; for (const container of containers) container.mounted.update({}); },
    stats: () => ({ ...drag.stats(), visits, collections: containers.map((container) => container.mounted.stats()) }),
    dispose() { try { drag.dispose(); } finally { for (const container of containers) container.mounted.dispose(); for (const node of hosts) node.remove(); } },
  };
}

/** A public WidgetDef example with replaceable authority and one renderer lifetime. */
export function mountDragWidget(host) {
  let handle;
  const commands = [];
  const widget = createDraggableCollectionWidget((props) => ({ id: 'grid', columnKey: () => 'column', indexOfColumn: () => 0,
    collection: { count: 10000, height: 264, keyAt: (i) => `row-${i}`, indexOf: (key) => Number(key.slice(4)),
      getItem: (i) => i, renderCell: (i) => i === 2 ? ['button', { 'data-jc-drag': 'item-a' }, 'Move item'] : String(i) },
    drag: { resolveSource: () => ({ key: 'item-a', revision: 1 }), locateSource: () => ({ container: 'grid', key: 'row-2', column: 'column' }),
      validTarget: () => !props.disabled, commit: (intent) => { commands.push(intent); } },
  }));
  const render = createDomRenderer(host, { widgets: { drag: { ...widget,
    mount(...args) { handle = widget.mount(...args); return handle; } } } });
  return { commands, show: (props = {}) => render(['jaren-widget', { name: 'drag', props }]),
    hide: () => render(null), dispose: () => render.destroy(),
    stats: () => ({ drag: handle.drag.stats(), collection: handle.mounted.stats() }) };
}
