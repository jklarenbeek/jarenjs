import { fixedRange, createVirtualAxis } from '@jarenjs/core/virtual';
import { createCollection, createCollectionInteraction, createDragInteraction, type DragIntent } from '@jarenjs/collection';
import { mountCollection, createCollectionWidget, mountProviderCollection, mountCollectionDrag, createDraggableCollectionWidget } from '@jarenjs/collection/component';
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
const rows = [{ id: 'a' }];
const provider = createArrayRangeProvider(rows);
const coordinator = createCollectionCoordinator(provider, {pageRows: 8});
const engine = createCollection({count: 1, keyAt: String, getItem: (i: number) => rows[i], renderCell: (row: {id: string}) => row.id});
const range: number = fixedRange({count:1,size:44,viewport:440}).end;
const axis = createVirtualAxis({count:100,estimateSize:44,maxBytes:1024});
axis.measure(0,'a',50);axis.range({offset:0,viewport:440});
const interaction = createCollectionInteraction({count:1,keyAt:String});interaction.focusIndex(0);interaction.key({key:' '});
const element = document.createElement('div');
const mounted = mountCollection(element, engine.options());mounted.scrollToIndex(0);mounted.dispose();
createCollectionWidget(engine.options());
const connected = mountProviderCollection(element, coordinator, engine.options());
connected.output({write: (_rows: unknown[]) => {},commit:()=>{}},{selection:interaction.state().selection});
connected.print({write: (_rows: unknown[]) => {},commit:()=>{}});
connected.dispose();engine.dispose();axis.dispose();void range;
const dragPolicy = { resolveSource: (key: string) => ({key, revision: 1}), validTarget: () => true,
  commit: (intent: DragIntent) => { const key: string = intent.target.key; void key; } };
const dragging = createDragInteraction(dragPolicy);
dragging.begin('a', { input: 'keyboard' });
dragging.move({x:0,y:0}, {container:'grid',key:'a',column:'day-a'});
dragging.drop(); dragging.dispose();
const dragHost = mountCollectionDrag([{id:'grid',mounted,columnKey:String,indexOfColumn:Number}], {
  ...dragPolicy, locateSource: () => ({container:'grid',key:'a',column:'day-a'}),
});
dragHost.update({ validTarget: () => false }); dragHost.cancel(); dragHost.dispose();
createDraggableCollectionWidget({collection:engine.options()});
// @ts-expect-error target columns are stable string keys
dragging.move({x:0,y:0}, {container:'grid',key:'a',column:0});
