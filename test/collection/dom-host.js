//@ts-check
/** Deterministic element/frame ownership around the existing view DOM stub. */
import { StubDocument } from '../view/dom.stub.js';
/** @param {any} [options] */
export function collectionHost(options = {}) {
  const document = new StubDocument();
  const create = document.createElement.bind(document);
  const frames = new Map(), observers = new Map();let next = 0;
  function matches(node, selector) {
    if (selector.startsWith('.')) return (node.getAttribute('class') ?? node.className ?? '').split(' ').includes(selector.slice(1));
    if (selector.startsWith('[')) return node.getAttribute(selector.slice(1,-1)) != null;
    if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
    return selector.split(',').includes(node.tagName);
  }
  document.createElement = (name) => {
    const el = create(name);
    el.fire = (type,event) => { for(const fn of el.listeners.get(type)??[]) fn(event); };
    el.style = {};el.clientWidth = options.width ?? 320;el.clientHeight = options.height ?? 440;el.scrollTop=0;el.scrollLeft=0;
    el.contains = (other) => { while(other) {if(other===el)return true;other=other.parentNode;} return false; };
    el.remove = () => el.parentNode?.removeChild(el);
    el.querySelectorAll = (selector) => { const found=[];const visit=(node)=>{ for(const child of node.childNodes??[]) {
      if(child.nodeType!==1)continue;if(matches(child,selector))found.push(child);visit(child);}}; visit(el);return found; };
    el.querySelector = (selector) => el.querySelectorAll(selector)[0]??null;
    el.click = () => el.fire('click',{target:el});
    el.closest = (selector) => { let node=el;while(node){if(matches(node,selector))return node;node=node.parentNode;}return null; };
    el.focus = () => {document.activeElement=el;};
    el.getBoundingClientRect = () => ({height:options.contentHeight??28});
    return el;
  };
  const host=document.createElement('main');
  document.getElementById = (id) => host.querySelectorAll('#'+id)[0]??null;
  const requestFrame=(fn)=>{const id=++next;frames.set(id,fn);return id;};
  const cancelFrame=(id)=>frames.delete(id);
  const observe=(node,fn)=>{observers.set(node,fn);return ()=>observers.delete(node);};
  document.defaultView = {requestAnimationFrame:requestFrame,cancelAnimationFrame:cancelFrame,
    ResizeObserver:class{observe(node){this.node=node;observers.set(node,this.fn);}constructor(fn){this.fn=fn;}disconnect(){observers.delete(this.node);}}};
  return {document,host,frames,observers,requestFrame,cancelFrame,observe,
    flush(){const work=[...frames.values()];frames.clear();for(const fn of work)fn();}};
}
