//@ts-check
/**
 * @file The unit of work against a model of its documented intent
 * (MODEL-FORMAT §11), on seeded random sequences.
 *
 * A sequence stages `create`, `get`, `add`, `put`, `remove`, `link`,
 * `unlink`, `discard` and `saveChanges()` calls, some inside transactions
 * that commit or roll back, over explicit and `auto` keys, a version guard,
 * many-to-many memberships, `restrict`, `cascade` and `setNull` children and
 * a self-reference. It runs in lockstep against a store and against a
 * reference built from the documentation alone: the intent of the accepted
 * staging calls, the last word per key (`add; remove` is nothing, `remove;
 * put` an update, `add; put` the put's document); a rolled-back save leaving
 * what was pending before it composed with what was staged after it (`remove;
 * save; add` a delete, then an insert; `add; save; remove` nothing; a
 * `discard()` after a save dropping only what was staged since); and a save
 * applying that intent with the actions a straight delete has (restrict
 * refuses, cascade deletes, set-null clears; join rows run before the
 * deletes). One mix moves children around parents a rolled-back save
 * deleted and added back — onto a parent added back, one added in the same
 * save, one that stays, or none — where the order of the updates, the
 * deletes run ahead and the inserts decides where a child lands. Compared:
 * every staging verdict, every read, the whole database
 * after every save, commit and rollback, a last save — which must succeed
 * where the reference calls the intent valid, and otherwise leave the
 * database as committed — and a second save that changes nothing.
 *
 * Whether a `put()` is accepted after a rollback depends on which keys the
 * tracker still holds, which the documentation does not pin for a key no
 * rolled-back save touched; such a verdict is not compared, and the
 * reference follows the store's. A divergence fails with its seed and the
 * sequence shrunk to the operations that still produce it. The seeds are
 * fixed, so every run checks the same sequences; the PostgreSQL half runs
 * where `JAREN_PG_URL` names a server.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { PG_URL, skipFor } from './store-core-engines.js';

const KID = (/** @type {boolean} */ versioned) => ({ type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: ['string', 'null'] }, v: { type: 'integer' },
  ...(versioned ? { rev: { type: 'integer', 'x-entity': { version: true } } } : {}) } });
const MODEL = {
  $model: '0.1',
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Note: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      rev: { type: 'integer', 'x-entity': { version: true } } } } },
    Tag: { schema: { type: 'object', properties: {
      name: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' } } } },
    Post: { schema: { type: 'object', properties: {
      pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' }, v: { type: 'integer' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Parent: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      kidsR: { 'x-entity': { relation: { to: 'KidR', many: true, via: 'parentId', onDelete: 'restrict' } } },
      kidsC: { 'x-entity': { relation: { to: 'KidC', many: true, via: 'parentId', onDelete: 'cascade' } } },
      kidsN: { 'x-entity': { relation: { to: 'KidN', many: true, via: 'parentId', onDelete: 'setNull' } } } } } },
    KidR: { schema: KID(false) },
    KidC: { schema: KID(true) },
    KidN: { schema: KID(false) },
    Node: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, upId: { type: ['string', 'null'] }, v: { type: 'integer' },
      below: { 'x-entity': { relation: { to: 'Node', many: true, via: 'upId', onDelete: 'setNull' } } } } } },
  },
};
/** @type {Record<string, string[]>} */
const KEYS = { Item: ['a', 'b', 'c'], Note: ['a', 'b', 'c'], Tag: ['t1', 't2', 't3'], Parent: ['p1', 'p2', 'p3'],
  KidR: ['k1', 'k2', 'k3'], KidC: ['k1', 'k2', 'k3'], KidN: ['k1', 'k2', 'k3'], Node: ['n1', 'n2', 'n3'] };
/** @type {Record<string, string>} */
const KEY_OF = { Item: 'id', Note: 'id', Tag: 'name', Parent: 'id', KidR: 'id', KidC: 'id', KidN: 'id', Node: 'id', Post: 'pid' };
const VERSIONED = new Set(['Note', 'KidC']);
/** @type {Record<string, string>} */
const KIDS = { KidR: 'restrict', KidC: 'cascade', KidN: 'setNull' };
const MEMBERS = new Set(['Item', 'Post']);
const TRACKED = ['Item', 'Note', 'Tag', 'Parent', 'KidR', 'KidC', 'KidN', 'Node'];
/** The entities a sequence draws its operations from, by mix. @type {Record<string, string[]>} */
const MIXES = {
  all: ['Item', 'Item', 'Note', 'Note', 'Tag', 'Parent', 'KidR', 'KidC', 'KidN', 'Post', 'Post', 'Node'],
  members: ['Item', 'Item', 'Tag', 'Post', 'Post'],
  family: ['Parent', 'Parent', 'KidR', 'KidC', 'KidN'],
  versioned: ['Note', 'Note', 'Note', 'KidC'],
  // children moved around parents deleted ahead (see `generate`)
  reparent: ['Parent', 'KidR', 'KidC', 'KidN'],
};

/** A seeded generator of numbers in [0, 1). @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (/** @type {any} */ x) => structuredClone(x);
const SEP = '\u0001';
const rk = (/** @type {string} */ E, /** @type {any} */ key) => `${E}${SEP}${key}`;
const jk = (/** @type {string} */ E, /** @type {any} */ own, /** @type {string} */ t) => `${E}${SEP}${own}${SEP}${t}`;
/** @returns {any} An empty database view: rows per entity (key to document), join rows. */
const emptyView = () => ({ rows: Object.fromEntries([...TRACKED, 'Post'].map((E) => [E, {}])), joins: { Item: {}, Post: {} } });

/** A document as a row: no version member, no relation members. @param {any} doc */
function strip(doc) {
  const out = { ...doc };
  for (const name of ['rev', 'tags', 'kidsR', 'kidsC', 'kidsN', 'below']) delete out[name];
  if ('parentId' in out && out.parentId === undefined) out.parentId = null;
  if ('upId' in out && out.upId === undefined) out.upId = null;
  return out;
}

/** The documented intent of the staged calls, and the database it leaves. */
class Reference {
  constructor() {
    /** @type {any} */
    this.db = emptyView();
    /** @type {any} the open transaction's view */
    this.view = null;
    /** @type {Map<string, any>} key to { k: 'put' | 'add' | 'rm' | 'pair' | 'cancelled', doc?, guarded? } */
    this.pend = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
    /** @type {Set<string>} */
    this.tracked = new Set();
    /** @type {any} */
    this.tx = null;
    /** @type {any} the composed state at the last save a rollback replays */
    this.atSave = null;
    /** @type {Map<string, any>} the membership array a tracked snapshot carries */
    this.snapTags = new Map();
  }
  get cur() { return this.view ?? this.db; }
  /** Whether a key's row is live in the intent. @param {string} E @param {any} key */
  live(E, key) {
    const s = this.pend.get(rk(E, key));
    if (s?.k === 'add' || s?.k === 'pair' || s?.k === 'put') return s.k !== 'put' || this.cur.rows[E][key] !== undefined;
    if (s?.k === 'rm') return false;
    return this.cur.rows[E][key] !== undefined;
  }
  /** Whether the next save can write a join row to the key: in the view
   * (join rows run before deletes) or pending insert. @param {string} E @param {any} key */
  joinable(E, key) {
    const s = this.pend.get(rk(E, key));
    return s?.k === 'add' || s?.k === 'pair' || this.cur.rows[E][key] !== undefined;
  }
  /** The content a put builds from. @param {string} E @param {any} key */
  content(E, key) {
    const s = this.pend.get(rk(E, key));
    if (s?.doc !== undefined && s.k !== 'rm') return s.doc;
    return this.cur.rows[E][key];
  }
  /** An accepted staging word. @param {any} w */
  word(w) {
    if (this.tx !== null) this.tx.words.push(clone(w));
    this.compose(w, false);
  }
  /** @param {any} w @param {boolean} replay */
  compose(w, replay) {
    const K = rk(w.E, w.key);
    const s = this.pend.get(K);
    switch (w.op) {
      case 'add': {
        if (s?.k === 'cancelled') { this.pend.set(K, { k: 'add', doc: w.doc }); this.tracked.add(K); return; }
        if (s?.k === 'rm' || s?.k === 'pair') {
          if (!replay) throw new Error('reference: an add over a pending removal is refused, never composed');
          this.pend.set(K, { k: 'pair', doc: w.doc, guarded: s.guarded });
        }
        else this.pend.set(K, { k: 'add', doc: w.doc });
        this.tracked.add(K);
        return;
      }
      case 'put': {
        if (s?.k === 'add' || s?.k === 'cancelled') this.pend.set(K, { k: 'add', doc: w.doc });
        else if (s?.k === 'pair') this.pend.set(K, { k: 'pair', doc: w.doc, guarded: s.guarded });
        else this.pend.set(K, { k: 'put', doc: w.doc });
        this.tracked.add(K);
        return;
      }
      case 'remove': {
        if (s?.k === 'add') {
          if (replay) { this.pend.set(K, { k: 'cancelled', doc: s.doc }); return; }
          this.pend.delete(K);
          this.dropLinksOf(w.E, w.key);
          this.tracked.delete(K);
          return;
        }
        // a remove() after one that cancelled a pending add removes the row
        // the key names, as it does live
        if (s?.k === 'cancelled') { this.pend.set(K, { k: 'rm', guarded: w.guarded }); return; }
        if (s?.k === 'rm') return;
        if (s?.k === 'pair') {
          this.pend.set(K, { k: 'rm', guarded: s.guarded });
          this.dropLinksOf(w.E, w.key);
          this.tracked.delete(K);
          return;
        }
        this.pend.set(K, { k: 'rm', guarded: w.guarded });
        return;
      }
      case 'link': case 'unlink':
        this.links.set(jk(w.E, w.key, w.t), { word: w.op, ownLive: w.ownLive, targetLive: w.targetLive });
        return;
      case 'discard': {
        const touched = this.atSave !== null && (this.atSave.pend.has(K)
          || [...this.atSave.links.keys()].some((id) => id.startsWith(`${w.E}${SEP}${w.key}${SEP}`)));
        if (replay && touched) {
          // a discard() after a save drops only what was staged since it, of
          // a key the save touched; another key's tracking it drops for good
          const was = this.atSave.pend.get(K);
          if (was === undefined) this.pend.delete(K); else this.pend.set(K, clone(was));
          this.dropLinksOf(w.E, w.key);
          for (const [id, l] of this.atSave.links) {
            const [e, own] = id.split(SEP);
            if (e === w.E && own === String(w.key)) this.links.set(id, clone(l));
          }
          if (this.atSave.tracked.has(K)) this.tracked.add(K); else this.tracked.delete(K);
          return;
        }
        this.pend.delete(K);
        this.tracked.delete(K);
        this.dropLinksOf(w.E, w.key);
        this.snapTags.delete(K);
        return;
      }
      case 'saveMark':
        this.atSave = { pend: new Map(clone([...this.pend])), links: new Map(clone([...this.links])), tracked: new Set(this.tracked) };
        return;
      case 'track': this.tracked.add(K); return;
      default: throw new Error(`reference: word ${w.op}`);
    }
  }
  /** @param {string} E @param {any} key */
  dropLinksOf(E, key) {
    for (const id of [...this.links.keys()]) {
      const [e, own] = id.split(SEP);
      if (e === E && own === String(key)) this.links.delete(id);
    }
  }
  begin() {
    this.view = clone(this.db);
    this.tx = { pend: clone([...this.pend]), links: clone([...this.links]), tracked: [...this.tracked], words: [], created: [],
      snapTags: clone([...this.snapTags]) };
  }
  commit() { this.db = this.view; this.view = null; this.tx = null; }
  rollback() {
    const { pend, links, tracked, words, created, snapTags } = this.tx;
    this.view = null; this.tx = null;
    this.pend = new Map(pend); this.links = new Map(links); this.tracked = new Set(tracked);
    this.snapTags = new Map(snapTags);
    this.atSave = null;
    for (const w of words) this.compose(w, true);
    this.atSave = null;
    for (const [K, st] of [...this.pend]) {
      if (st.k !== 'cancelled') continue;
      const [E, key] = K.split(SEP);
      this.pend.delete(K);
      this.dropLinksOf(E, key);
      this.tracked.delete(K);
    }
    // a row created inside the transaction is gone, and so is its tracking
    for (const K of created) if (!this.pend.has(K)) this.tracked.delete(K);
  }
  /** The composed intent applied to the current view. @returns {{ valid: boolean, reasons: string[], view: any }} */
  applySave() {
    const before = this.cur;
    const after = clone(before);
    /** @type {string[]} */
    const reasons = [];
    const deleted = new Set();
    const exists = (/** @type {string} */ E, /** @type {any} */ key) => after.rows[E][key] !== undefined;
    for (const [K, s] of this.pend) {
      const [E, key] = K.split(SEP);
      const had = before.rows[E][key] !== undefined;
      if (s.k === 'put') {
        if (!had) { reasons.push(`put-missing ${K}`); continue; }
        after.rows[E][key] = strip(s.doc);
      }
      else if (s.k === 'add') {
        if (E !== 'Post' && had) { reasons.push(`dup ${K}`); continue; }
        after.rows[E][key] = strip(s.doc);
      }
      else if (s.k === 'rm') {
        if (!had) { if (s.guarded && VERSIONED.has(E)) reasons.push(`guarded-missing ${K}`); continue; }
        delete after.rows[E][key];
        deleted.add(K);
      }
      else if (s.k === 'pair') {
        if (!had && s.guarded && VERSIONED.has(E)) reasons.push(`guarded-missing ${K}`);
        if (had) deleted.add(K);
        after.rows[E][key] = strip(s.doc);
      }
    }
    const pendOf = (/** @type {string} */ E, /** @type {any} */ key) => this.pend.get(rk(E, key));
    for (const [E, action] of Object.entries(KIDS)) {
      for (const [key, row] of Object.entries(before.rows[E])) {
        const s = pendOf(E, key);
        if (s?.k === 'rm' || s?.k === 'pair') continue;
        const parentDeleted = row.parentId != null && deleted.has(rk('Parent', row.parentId));
        const reparented = s?.k === 'put' && (s.doc.parentId ?? null) !== (row.parentId ?? null);
        if (parentDeleted && !reparented) {
          if (action === 'restrict') reasons.push(`restrict ${E}:${key}->${row.parentId}`);
          else if (action === 'cascade') { delete after.rows[E][key]; deleted.add(rk(E, key)); continue; }
          else after.rows[E][key] = { ...after.rows[E][key], parentId: null };
        }
      }
      for (const [key, row] of Object.entries(after.rows[E])) {
        if (row.parentId == null || exists('Parent', row.parentId)) continue;
        const s = pendOf(E, key);
        // written under a parent the same save deletes: the parent's action applies
        if (deleted.has(rk('Parent', row.parentId)) && (s?.k === 'add' || s?.k === 'pair' || s?.k === 'put')) {
          if (action === 'restrict') reasons.push(`restrict ${E}:${key}->${row.parentId}`);
          else if (action === 'cascade') { delete after.rows[E][key]; deleted.add(rk(E, key)); }
          else after.rows[E][key] = { ...row, parentId: null };
          continue;
        }
        if (s?.k === 'add' || s?.k === 'pair' || s?.k === 'put') reasons.push(`fk-missing ${E}:${key}->${row.parentId}`);
        else if (!deleted.has(rk('Parent', row.parentId))) reasons.push(`fk-dangling ${E}:${key}->${row.parentId}`);
      }
    }
    for (const [key, row] of Object.entries(after.rows.Node)) {
      if (row.upId != null && !exists('Node', row.upId)) reasons.push(`fk-missing Node:${key}->${row.upId}`);
    }
    for (const E of ['Item', 'Post']) {
      for (const own of Object.keys(after.joins[E])) {
        if (deleted.has(rk(E, own)) || !exists(E, own)) { delete after.joins[E][own]; continue; }
        after.joins[E][own] = after.joins[E][own].filter((/** @type {string} */ t) => exists('Tag', t) && !deleted.has(rk('Tag', t)));
      }
    }
    for (const [K, s] of this.pend) {
      const [E, key] = K.split(SEP);
      if (!MEMBERS.has(E) || !(s.k === 'add' || s.k === 'pair')) continue;
      const tags = s.doc.tags ?? [];
      for (const t of tags) {
        const st = this.pend.get(rk('Tag', t));
        if (before.rows.Tag[t] === undefined && st?.k !== 'add' && st?.k !== 'pair') reasons.push(`array-missing ${E}:${key}->${t}`);
      }
      if (tags.length > 0) after.joins[E][key] = [...new Set(tags)].filter((t) => exists('Tag', t));
    }
    for (const [id, l] of this.links) {
      const [E, own, t] = id.split(SEP);
      const ownOk = exists(E, own);
      if (l.word === 'unlink') {
        if (ownOk && after.joins[E][own]) after.joins[E][own] = after.joins[E][own].filter((/** @type {string} */ x) => x !== t);
        continue;
      }
      if (ownOk && exists('Tag', t)) {
        after.joins[E][own] = [...new Set([...(after.joins[E][own] ?? []), t])];
        continue;
      }
      // a link to a row that existed when it was staged, or that the save still
      // finds, vanishes with it; to one that never did, refuses
      const joinableNow = (/** @type {string} */ EE, /** @type {any} */ kk) => before.rows[EE][kk] !== undefined
        || ['add', 'pair'].includes(this.pend.get(rk(EE, kk))?.k);
      if ((!ownOk && !l.ownLive && !joinableNow(E, own)) || (!exists('Tag', t) && !l.targetLive && !joinableNow('Tag', t)))
        reasons.push(`link-missing ${id}`);
    }
    for (const E of ['Item', 'Post']) for (const own of Object.keys(after.joins[E])) {
      after.joins[E][own] = [...new Set(after.joins[E][own])].sort();
      if (after.joins[E][own].length === 0) delete after.joins[E][own];
    }
    return { valid: reasons.length === 0, reasons, view: after };
  }
  /** A successful save leaving `view`. @param {any} view */
  saved(view) {
    if (this.view !== null) this.view = view; else this.db = view;
    if (this.tx !== null) this.tx.words.push({ op: 'saveMark' });
    for (const [K, s] of this.pend) if (s.k === 'rm') this.tracked.delete(K); else this.tracked.add(K);
    for (const [K, s] of this.pend) {
      if (s.k === 'rm') this.snapTags.delete(K);
      else if ((s.k === 'add' || s.k === 'pair') && Array.isArray(s.doc.tags)) this.snapTags.set(K, [...s.doc.tags]);
      else if (s.k === 'add' || s.k === 'pair') this.snapTags.delete(K);
    }
    this.pend = new Map();
    this.links = new Map();
  }
}

/** The reference's verdict on an op: { ok, code?, soft?, value?, reasons? }.
 * `soft` marks a verdict the documentation does not pin.
 * @param {Reference} ref @param {any} op @returns {any} */
function predict(ref, op) {
  const E = op.E;
  const key = op.title ?? op.key ?? op.doc?.[KEY_OF[E]] ?? op.doc?.title;
  switch (op.op) {
    case 'create': {
      if (ref.cur.rows[E][key] !== undefined) return { ok: false, code: 'JD2001' };
      if (E in KIDS && op.doc.parentId != null && ref.cur.rows.Parent[op.doc.parentId] === undefined) return { ok: false, code: 'JD2005' };
      if (E === 'Node' && op.doc.upId != null && ref.cur.rows.Node[op.doc.upId] === undefined) return { ok: false, code: 'JD2005' };
      return { ok: true };
    }
    case 'get': return { ok: true, value: ref.cur.rows[E][key] ?? null };
    case 'add': {
      const s = ref.pend.get(rk(E, key));
      if (E !== 'Post' && (s?.k === 'rm' || s?.k === 'pair')) return { ok: false, code: 'JD2003' };
      return { ok: true };
    }
    case 'put': return ref.tracked.has(rk(E, key)) ? { ok: true, soft: true } : { ok: false, code: 'JD2006', soft: true };
    case 'save': {
      const r = ref.applySave();
      return r.valid ? { ok: true, view: r.view } : { ok: false, code: '*', reasons: r.reasons };
    }
    default: return { ok: true };
  }
}

/** Advance the reference by an op's ACTUAL outcome. @param {Reference} ref @param {any} op @param {any} actual */
function settle(ref, op, actual) {
  const E = op.E;
  const key = op.title ?? op.key ?? op.doc?.[KEY_OF[E]] ?? op.doc?.title;
  switch (op.op) {
    case 'create':
      if (!actual.ok) return;
      ref.cur.rows[E][key] = strip(op.doc);
      if (MEMBERS.has(E) && Array.isArray(op.doc.tags)) {
        ref.cur.joins[E][key] = [...new Set(op.doc.tags)].sort();
        if (ref.pend.get(rk(E, key)) === undefined) ref.snapTags.set(rk(E, key), [...op.doc.tags]);
      }
      if (ref.tx !== null) ref.tx.created.push(rk(E, key));
      ref.compose({ op: 'track', E, key }, false);
      return;
    case 'get':
      if (actual.ok && actual.value !== null && actual.value !== undefined) {
        const st = ref.pend.get(rk(E, key));
        if (st === undefined || st.k === 'rm') ref.snapTags.delete(rk(E, key));
        ref.word({ op: 'track', E, key });
      }
      return;
    case 'add': if (actual.ok) ref.word({ op: 'add', E, key, doc: clone(op.doc) }); return;
    case 'put': {
      if (!actual.ok) return;
      const base = ref.content(E, key) ?? {};
      const snap = ref.snapTags.get(rk(E, key));
      ref.word({ op: 'put', E, key,
        doc: { ...strip(base), ...op.change, [E === 'Post' ? 'title' : KEY_OF[E]]: key, ...(snap ? { tags: [...snap] } : {}) } });
      return;
    }
    case 'remove': if (actual.ok) ref.word({ op: 'remove', E, key, guarded: ref.tracked.has(rk(E, key)) }); return;
    case 'link': case 'unlink':
      if (actual.ok) ref.word({ op: op.op, E, key, t: op.t, ownLive: ref.joinable(E, key), targetLive: ref.joinable('Tag', op.t) });
      return;
    case 'discard': if (actual.ok) ref.word({ op: 'discard', E, key }); return;
    case 'save': if (actual.ok) ref.saved(ref.applySave().view); return;
    case 'begin': ref.begin(); return;
    case 'commit': if (actual.ok) ref.commit(); else ref.rollback(); return;
    case 'rollback': ref.rollback(); return;
    default: throw new Error(op.op);
  }
}

/** One sequence: seeded rows, then staged calls, some inside transactions,
 * drawn by simulating the reference. @param {number} seed @param {string} mix @returns {any[]} */
function generate(seed, mix) {
  const rand = mulberry32(seed);
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (/** @type {number} */ p) => rand() < p;
  const ref = new Reference();
  let counter = 0;
  let postCounter = 0;
  const savedPosts = new Set();
  const pendingPosts = new Set();
  /** @type {any[]} */
  const steps = [];
  const simulate = (/** @type {any} */ op) => {
    const expect = predict(ref, op);
    settle(ref, op, expect.ok ? { ok: true, value: expect.value } : { ok: false, code: expect.code });
  };
  const refreshPosts = () => {
    savedPosts.clear(); pendingPosts.clear();
    for (const title of Object.keys(ref.cur.rows.Post)) savedPosts.add(title);
    for (const [K, s] of ref.pend) {
      const [E, key] = K.split(SEP);
      if (E === 'Post' && s.k === 'add') pendingPosts.add(key);
    }
  };
  const length = 3 + Math.floor(rand() * 10);
  /** @type {any[]} */
  const seedOps = [];
  for (const t of KEYS.Tag) if (chance(0.7)) seedOps.push({ op: 'create', E: 'Tag', doc: { name: t, v: 0 } });
  for (const p of KEYS.Parent) if (chance(0.8)) seedOps.push({ op: 'create', E: 'Parent', doc: { id: p, v: 0 } });
  for (const E of ['Item', 'Note']) for (const k of KEYS[E]) if (chance(0.4)) seedOps.push({ op: 'create', E, doc: { id: k, v: 0 } });
  for (const E of Object.keys(KIDS)) for (const k of KEYS[E]) if (chance(0.5)) {
    const parents = seedOps.filter((o) => o.E === 'Parent').map((o) => o.doc.id);
    if (parents.length) seedOps.push({ op: 'create', E, doc: { id: k, parentId: pick(parents), v: 0 } });
  }
  for (const n of KEYS.Node) if (chance(0.6)) seedOps.push({ op: 'create', E: 'Node', doc: { id: n, upId: null, v: 0 } });
  for (const op of seedOps) { steps.push(op); simulate(op); }
  if (chance(0.5)) { const op = { op: 'save' }; steps.push(op); simulate(op); }
  if (mix === 'reparent') {
    // reads; a rolled-back save of parent removals that adds some of them
    // back (and maybe a new parent), which leaves deletes to run ahead of
    // their inserts; maybe a parent added outside it; then children moved
    // onto ONE parent — one added back, a new one, one that stays, or none —
    // so that no two moves cross, or edited where they are
    const push = (/** @type {any} */ op) => { steps.push(op); simulate(op); };
    const parents = KEYS.Parent.filter((p) => ref.cur.rows.Parent[p] !== undefined);
    for (const p of parents) if (chance(0.7)) push({ op: 'get', E: 'Parent', key: p });
    const kids = Object.keys(KIDS).flatMap((E) => Object.keys(ref.cur.rows[E]).map((k) => [E, k]));
    for (const [E, k] of kids) if (chance(0.8)) push({ op: 'get', E, key: k });
    const removed = parents.filter(() => chance(0.6));
    const fresh = () => KEYS.Parent.filter((p) => !ref.live('Parent', p) && ref.pend.get(rk('Parent', p)) === undefined);
    if (removed.length > 0) {
      push({ op: 'begin' });
      for (const p of removed) push({ op: 'remove', E: 'Parent', key: p });
      push({ op: 'save' });
      for (const p of removed) if (chance(0.8)) push({ op: 'add', E: 'Parent', doc: { id: p, v: ++counter } });
      if (chance(0.3) && fresh().length > 0) push({ op: 'add', E: 'Parent', doc: { id: pick(fresh()), v: ++counter } });
      push({ op: 'rollback' });
    }
    if (fresh().length > 0 && chance(0.5)) push({ op: 'add', E: 'Parent', doc: { id: pick(fresh()), v: ++counter } });
    const target = pick([...KEYS.Parent.filter((p) => ref.live('Parent', p)), null]);
    for (const [E, k] of kids) {
      if (!chance(0.6) || !ref.tracked.has(rk(E, k))) continue;
      push({ op: 'put', E, key: k, change: chance(0.8) ? { parentId: target } : { v: ++counter } });
    }
    if (chance(0.3)) push({ op: 'save' });
    return steps;
  }

  const randomOp = (/** @type {boolean} */ inTx) => {
    const r = rand();
    const E = pick(MIXES[mix]);
    if (E === 'Post') {
      const titles = [...savedPosts, ...pendingPosts];
      if (r < 0.3 || titles.length === 0) {
        const title = `P${++postCounter}`;
        pendingPosts.add(title);
        /** @type {any} */
        const doc = { title, v: ++counter };
        if (chance(0.25)) doc.tags = KEYS.Tag.filter((t) => ref.live('Tag', t) && chance(0.5));
        return { op: 'add', E, doc };
      }
      const title = pick(titles);
      const liveTags = KEYS.Tag.filter((t) => ref.live('Tag', t));
      const tagChoice = () => (chance(0.15) || liveTags.length === 0 ? pick(KEYS.Tag) : pick(liveTags));
      if (r < 0.55) return { op: chance(0.7) ? 'link' : 'unlink', E, title, t: tagChoice() };
      if (!savedPosts.has(title)) return { op: 'link', E, title, t: tagChoice() };
      if (r < 0.7) return { op: 'get', E, title };
      if (r < 0.85) return { op: 'put', E, title, change: { v: ++counter } };
      return { op: 'remove', E, title };
    }
    const keyName = KEY_OF[E];
    const wild = chance(0.15); // otherwise prefer a choice the documentation calls valid
    const liveParents = KEYS.Parent.filter((p) => ref.live('Parent', p));
    const parentChoice = () => (wild || liveParents.length === 0 ? pick([...KEYS.Parent, null]) : pick([...liveParents, ...liveParents, null]));
    const liveTags = KEYS.Tag.filter((t) => ref.live('Tag', t));
    const tagChoice = () => (wild || liveTags.length === 0 ? pick(KEYS.Tag) : pick(liveTags));
    let key = pick(KEYS[E]);
    if (r < 0.12 && !inTx) {
      /** @type {any} */
      const doc = { [keyName]: key, v: ++counter };
      if (E in KIDS) doc.parentId = pick([...KEYS.Parent, null]);
      if (E === 'Node') doc.upId = pick([...KEYS.Node.filter((n) => n !== key), null]);
      return { op: 'create', E, doc };
    }
    if (r < 0.12) {
      // inside a transaction only a create that succeeds (PostgreSQL spends the transaction otherwise)
      if (ref.cur.rows[E][key] !== undefined || E in KIDS || E === 'Node') return { op: 'get', E, key };
      return { op: 'create', E, doc: { [keyName]: key, v: ++counter } };
    }
    if (r < 0.25) return { op: 'get', E, key };
    if (r < 0.42 && E !== 'Node') {
      if (!wild) {
        const free = KEYS[E].filter((k) => !ref.live(E, k) && ref.pend.get(rk(E, k))?.k !== 'rm' && ref.pend.get(rk(E, k))?.k !== 'pair');
        if (free.length) key = pick(free);
        else if (E !== 'Tag' && E !== 'Parent') return { op: 'remove', E, key };
      }
      /** @type {any} */
      const doc = { [keyName]: key, v: ++counter };
      if (E in KIDS) doc.parentId = parentChoice();
      if (E === 'Item' && chance(0.25)) doc.tags = (wild ? KEYS.Tag : liveTags).filter(() => chance(0.5));
      return { op: 'add', E, doc };
    }
    if (r < 0.62) {
      if (!wild) {
        const known = KEYS[E].filter((k) => ref.tracked.has(rk(E, k)) && ref.content(E, k) !== undefined);
        if (known.length) key = pick(known);
      }
      const change = E in KIDS && chance(0.4) ? { parentId: parentChoice() }
        : E === 'Node' && chance(0.5) ? { upId: pick([...KEYS.Node.filter((n) => n !== key), null]) }
          : { v: ++counter };
      return { op: 'put', E, key, change };
    }
    if (r < 0.78 && E !== 'Node') {
      if (!wild && E === 'Parent') {
        // a parent whose restricting children stay would refuse its delete
        const removable = KEYS.Parent.filter((p) => !Object.entries(ref.cur.rows.KidR).some(([k, row]) => /** @type {any} */ (row).parentId === p
          && ref.pend.get(rk('KidR', k))?.k !== 'rm'));
        if (removable.length) key = pick(removable);
      }
      return { op: 'remove', E, key };
    }
    if (r < 0.9 && E === 'Item') return { op: chance(0.7) ? 'link' : 'unlink', E, key, t: tagChoice() };
    if (r < 0.95) return { op: 'discard', E, key };
    return { op: 'get', E, key };
  };

  let t = 0;
  while (t < length) {
    if (chance(0.35)) {
      const n = 1 + Math.floor(rand() * 5);
      const commit = chance(0.4);
      steps.push({ op: 'begin' }); simulate({ op: 'begin' });
      let saved = false;
      for (let i = 0; i < n; i++) {
        const op = chance(0.3) || (i === Math.floor(n / 2) && !saved) ? { op: 'save' } : randomOp(true);
        if (op.op === 'save') saved = true;
        steps.push(op); simulate(op);
        if (op.op === 'save') refreshPosts();
      }
      const end = { op: commit ? 'commit' : 'rollback' };
      steps.push(end); simulate(end);
      if (!commit) refreshPosts();
      t += n;
    }
    else {
      const op = chance(0.2) ? { op: 'save' } : randomOp(false);
      steps.push(op); simulate(op);
      if (op.op === 'save') refreshPosts();
      t += 1;
    }
  }
  return steps;
}

const codeOf = (/** @type {any} */ e) => e?.code ?? e?.name ?? 'Error';

/** The whole database as the reference holds it, and each post's key by title. @param {any} h */
async function dump(h) {
  const view = emptyView();
  for (const E of TRACKED) {
    const rows = await h.entity(E).asNoTracking().load(MEMBERS.has(E) ? { include: { tags: true } } : {});
    for (const row of rows) {
      const k = row[KEY_OF[E]];
      if (MEMBERS.has(E) && row.tags?.length) view.joins[E][k] = row.tags.map((/** @type {any} */ t) => t.name).sort();
      const s = strip(row);
      if (E in KIDS && !('parentId' in s)) s.parentId = null;
      if (E === 'Node' && !('upId' in s)) s.upId = null;
      view.rows[E][k] = s;
    }
  }
  const pids = new Map();
  for (const row of await h.entity('Post').asNoTracking().load({ include: { tags: true } })) {
    pids.set(row.title, row.pid);
    if (row.tags?.length) view.joins.Post[row.title] = row.tags.map((/** @type {any} */ t) => t.name).sort();
    const s = strip(row); delete s.pid;
    view.rows.Post[row.title] = s;
  }
  return { view, pids };
}

/** A view in comparable form. @param {any} view */
function norm(view) {
  const out = clone(view);
  for (const E of Object.keys(KIDS)) for (const r of Object.values(out.rows[E])) if (/** @type {any} */ (r).parentId === undefined) /** @type {any} */ (r).parentId = null;
  for (const r of Object.values(out.rows.Node)) if (/** @type {any} */ (r).upId === undefined) /** @type {any} */ (r).upId = null;
  for (const r of Object.values(out.rows.Post)) delete /** @type {any} */ (r).pid;
  for (const E of ['Item', 'Post']) for (const own of Object.keys(out.joins[E])) {
    out.joins[E][own] = [...new Set(out.joins[E][own])].sort();
    if (out.joins[E][own].length === 0) delete out.joins[E][own];
  }
  const sorted = (/** @type {any} */ o) => (o && typeof o === 'object' && !Array.isArray(o)
    ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  return sorted(out);
}
/** Where two views differ. @param {any} a @param {any} b @returns {string[]} */
function diffViews(a, b) {
  const na = norm(a); const nb = norm(b);
  const out = [];
  for (const part of ['rows', 'joins']) {
    for (const E of Object.keys(na[part])) {
      for (const k of new Set([...Object.keys(na[part][E]), ...Object.keys(nb[part][E])])) {
        const empty = part === 'rows' ? null : [];
        const x = JSON.stringify(na[part][E][k] ?? empty); const y = JSON.stringify(nb[part][E][k] ?? empty);
        if (x !== y) out.push(`${E}${part === 'joins' ? '.tags' : ''}:${k} expected ${x} got ${y}`);
      }
    }
  }
  return out;
}

/**
 * Run a sequence in lockstep on a fresh store. Answers the first divergence
 * that is not a soft one, or null.
 * @param {(fn: (store: any) => Promise<any>) => Promise<any>} withFresh
 * @param {any[]} steps @returns {Promise<{ at: any, kind: string, detail: string } | null>}
 */
async function run(withFresh, steps) {
  return withFresh(async (store) => {
    const ref = new Reference();
    let pids = new Map();
    const pendingPostDocs = new Map();
    /** @type {any} */
    let txHandle = null;
    /** @type {any} */
    let txControl = null;
    const refreshPids = async () => { pids = (await dump(txHandle ?? store)).pids; };
    for (let i = 0; i < steps.length; i++) {
      const op = steps[i];
      if (op.op === 'begin') {
        ref.begin();
        /** @type {() => void} */
        let release = () => {};
        const ready = new Promise((resolve) => { release = () => resolve(undefined); });
        /** @type {any[]} */
        const queue = [];
        /** @type {any} */
        let wake = null;
        // the transaction's body takes each op from the queue the steps fill
        const promise = store.transaction(async (/** @type {any} */ tx) => {
          txHandle = tx;
          release();
          for (;;) {
            if (queue.length === 0) await new Promise((r) => { wake = r; });
            const item = queue.shift();
            if (item.end === 'commit') return 'committed';
            if (item.end === 'rollback') throw new Error('rollback-marker');
            try { item.resolve(await item.fn(tx)); } catch (e) { item.reject(e); }
          }
        });
        promise.catch(() => {});
        await ready;
        txControl = {
          promise,
          send: (/** @type {any} */ fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); wake?.(); wake = null; }),
          end: (/** @type {string} */ end) => { queue.push({ end }); wake?.(); wake = null; },
        };
        continue;
      }
      if (op.op === 'commit' || op.op === 'rollback') {
        txControl.end(op.op);
        let ok = true;
        try { await txControl.promise; }
        catch (e) {
          ok = false;
          if (op.op === 'commit') return { at: i, kind: 'commit-failed', detail: `${codeOf(e)} ${/** @type {any} */ (e).message}` };
        }
        txHandle = null; txControl = null;
        settle(ref, op, { ok: op.op === 'commit' && ok });
        await refreshPids();
        const d = diffViews(ref.db, (await dump(store)).view);
        if (d.length) return { at: i, kind: `state-after-${op.op}`, detail: d.join('; ') };
        continue;
      }
      const exec = (/** @type {any} */ fn) => (txControl ? txControl.send(fn) : fn(store));
      const expect = predict(ref, op);
      /** @type {any} */
      let actual;
      try {
        const value = await exec(async (/** @type {any} */ hh) => {
          const set = hh.entity(op.E ?? 'Item');
          switch (op.op) {
            case 'create': return set.create(clone(op.doc));
            case 'get': {
              if (op.E !== 'Post') return set.get(op.key);
              const pid = pids.get(op.title);
              return pid === undefined ? '__skip' : set.get(pid);
            }
            case 'add': {
              const doc = set.add(clone(op.doc));
              if (op.E === 'Post') pendingPostDocs.set(op.doc.title, doc);
              return doc;
            }
            case 'put': {
              const key = op.E === 'Post' ? op.title : op.key;
              const pid = pids.get(op.title);
              if (op.E === 'Post' && pid === undefined) return '__skip';
              const base = ref.content(op.E, key) ?? {};
              const snap = ref.snapTags.get(rk(op.E, key));
              return set.put({ ...strip(base), ...op.change, ...(op.E === 'Post' ? { pid, title: op.title } : { [KEY_OF[op.E]]: op.key }),
                ...(snap ? { tags: snap } : {}) });
            }
            case 'remove': {
              if (op.E !== 'Post') { set.remove(op.key); return true; }
              const pid = pids.get(op.title);
              if (pid === undefined) return '__skip';
              set.remove(pid);
              return true;
            }
            case 'link': case 'unlink': {
              const own = op.E !== 'Post' ? op.key : pids.has(op.title) ? pids.get(op.title) : pendingPostDocs.get(op.title);
              if (own === undefined) return '__skip';
              set[op.op](own, 'tags', op.t);
              return true;
            }
            case 'discard': set.discard(op.key); return true;
            case 'save': return hh.saveChanges();
            default: throw new Error(op.op);
          }
        });
        actual = value === '__skip' ? { skip: true } : { ok: true, value };
      }
      catch (e) {
        actual = { ok: false, code: codeOf(e), message: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300) };
      }
      if (actual.skip) continue;
      if (op.op === 'save') {
        if (expect.ok && !actual.ok) return { at: i, kind: `save-failed:${actual.code}`, detail: actual.message };
        if (!expect.ok && actual.ok) return { at: i, kind: 'save-unexpected-success', detail: expect.reasons.join(', ') };
        settle(ref, op, actual);
        if (actual.ok) {
          await (txControl ? txControl.send(async () => { await refreshPids(); }) : refreshPids());
          const { view } = txControl ? await txControl.send((/** @type {any} */ tx) => dump(tx)) : await dump(store);
          const d = diffViews(ref.cur, view);
          if (d.length) return { at: i, kind: 'state-after-save', detail: d.join('; ') };
        }
        continue;
      }
      if (op.op === 'get') {
        if (!actual.ok) return { at: i, kind: 'get-failed', detail: `${actual.code} ${actual.message}` };
        const one = (/** @type {any} */ doc) => {
          if (doc === null || doc === undefined) return null;
          const s = strip(doc);
          if (op.E in KIDS && s.parentId === undefined) s.parentId = null;
          if (op.E === 'Node' && s.upId === undefined) s.upId = null;
          if (op.E === 'Post') delete s.pid;
          return JSON.stringify(norm({ rows: { ...emptyView().rows, X: { v: s } }, joins: emptyView().joins }).rows.X);
        };
        if (one(actual.value) !== one(expect.value))
          return { at: i, kind: 'get-mismatch', detail: `expected ${one(expect.value)} got ${one(actual.value)}` };
        settle(ref, op, actual);
        continue;
      }
      if (!expect.soft && (expect.ok !== actual.ok || (!expect.ok && expect.code !== actual.code))) {
        return { at: i, kind: `refusal-${op.op}:${expect.ok ? 'ok' : expect.code}->${actual.ok ? 'ok' : actual.code}`,
          detail: actual.message ?? '' };
      }
      settle(ref, op, actual);
    }
    if (txControl) {
      txControl.end('rollback');
      await txControl.promise.catch(() => {});
      txHandle = null; txControl = null;
      ref.rollback();
    }
    // the last save, in its own transaction
    const expect = predict(ref, { op: 'save' });
    try { await store.saveChanges(); }
    catch (e) {
      if (expect.ok) return { at: 'last', kind: `last-save-failed:${codeOf(e)}`, detail: String(/** @type {any} */ (e).message).slice(0, 300) };
      // a failed save writes nothing: the database is as committed
      const d = diffViews(ref.db, (await dump(store)).view);
      return d.length ? { at: 'last', kind: 'state-after-failed-save', detail: d.join('; ') } : null;
    }
    if (!expect.ok) return { at: 'last', kind: 'last-save-unexpected-success', detail: expect.reasons.join(', ') };
    settle(ref, { op: 'save' }, { ok: true });
    const d = diffViews(ref.db, (await dump(store)).view);
    if (d.length) return { at: 'last', kind: 'last-state', detail: d.join('; ') };
    // a second save of nothing changes nothing
    const again = await store.saveChanges().then((/** @type {any} */ r) => r, (/** @type {any} */ e) => ({ error: codeOf(e) }));
    if (again.error || again.inserted + again.updated + again.deleted + again.joinInserted + again.joinDeleted > 0)
      return { at: 'last', kind: 'not-idempotent', detail: JSON.stringify(again.error ?? again.statements) };
    return null;
  });
}

/** Whether a sequence opens and closes its transactions in order. @param {any[]} steps */
function balanced(steps) {
  let open = false;
  for (const s of steps) {
    if (s.op === 'begin') { if (open) return false; open = true; }
    if (s.op === 'commit' || s.op === 'rollback') { if (!open) return false; open = false; }
  }
  return !open;
}

/**
 * Shrink a diverging sequence to the operations that still produce the same
 * kind of divergence: drop runs of operations, then unwrap transactions.
 * @param {(fn: (store: any) => Promise<any>) => Promise<any>} withFresh
 * @param {any[]} steps @param {string} kind
 */
async function shrink(withFresh, steps, kind) {
  const same = async (/** @type {any[]} */ candidate) => {
    try { return (await run(withFresh, candidate))?.kind === kind; }
    catch { return false; }
  };
  let current = steps;
  for (let progress = true; progress;) {
    progress = false;
    for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1; size = Math.floor(size / 2)) {
      for (let at = 0; at + size <= current.length; at++) {
        const cut = [...current.slice(0, at), ...current.slice(at + size)];
        if (balanced(cut) && await same(cut)) { current = cut; progress = true; at--; }
      }
    }
    for (let at = 0; at < current.length; at++) {
      if (current[at].op !== 'begin') continue;
      const end = current.findIndex((s, j) => j > at && (s.op === 'commit' || s.op === 'rollback'));
      const cut = [...current.slice(0, at), ...current.slice(at + 1, end), ...current.slice(end + 1)];
      if (await same(cut)) { current = cut; progress = true; break; }
    }
  }
  return current;
}

/** @param {number} from @param {number} to */
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

/** Fixed seeds per mix: a run of consecutive ones, and the seeds whose
 * sequences reach a rolled-back save, an allocated key or a delete run
 * ahead of its insert. @type {Record<string, Record<string, number[]>>} */
const SEEDS = {
  sqlite: {
    all: [...range(100000, 100100), 100144, 100148, 100297, 100613, 100647, 100744, 100776, 100819, 101201, 101448, 101722],
    members: [...range(200000, 200050), 200114, 200129, 200142, 200178, 200196, 200213, 200272, 200289, 200292, 200358, 200374,
      200418, 200502, 200602, 200617, 200639, 200662, 200779, 200868, 200902, 200906, 200911, 200944],
    family: [...range(300000, 300050), 300085, 300217, 300303, 300384, 300406, 300560, 300561, 300760, 300874],
    versioned: [...range(400000, 400050), 400081, 400082, 400131, 400208, 400221, 400229, 400293, 400294, 400345, 400402, 400423,
      400457, 400511, 400535, 400551, 400568, 400587, 400615, 400638, 400723, 400769, 400830, 400860, 400862, 400867, 400879,
      400924, 400984, 400999],
    reparent: range(700000, 700120),
  },
  postgres: {
    all: [...range(100000, 100008), 100079, 100144, 100148, 100297, 100613, 100647, 100744, 100776],
    members: [...range(200000, 200010), 200028, 200043, 200114, 200129, 200142, 200171, 200178, 200196, 200213, 200272, 200292,
      200335, 200358, 200374],
    family: [...range(300000, 300010), 300046, 300085, 300217, 300303, 300384],
    versioned: [...range(400000, 400010), 400012, 400034, 400081, 400082, 400131, 400208, 400221, 400229, 400293, 400294, 400345],
    reparent: range(700000, 700020),
  },
};

for (const engine of ['sqlite', 'postgres']) {
  describe(`the unit of work does what its staged calls document, on seeded sequences (${engine})`, { skip: skipFor(engine) }, () => {
    /** @type {any} */
    let pool = null;
    let schemas = 0;
    after(async () => { await pool?.end(); });
    /** A fresh store for one sequence: in memory, or on a schema of its own,
     * dropped afterwards. @param {(store: any) => Promise<any>} fn */
    const withFresh = async (fn) => {
      if (engine === 'sqlite') {
        const store = await openStore(MODEL, { driver: nodeDriver() });
        try { return await fn(store); }
        finally { await store.close().catch(() => {}); }
      }
      if (pool === null) {
        const { default: pg } = await import('pg');
        pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
      }
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      const schema = `jaren_tracker_model_${process.pid}_${++schemas}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      try {
        const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
        try { return await fn(store); }
        finally { await store.close().catch(() => {}); }
      }
      finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {}); }
    };
    for (const [mix, seeds] of Object.entries(SEEDS[engine])) {
      it(`${seeds.length} sequences from the ${mix} mix`, async () => {
        /** @type {any[]} */
        const failures = [];
        for (const seed of seeds) {
          const steps = generate(seed, mix);
          const divergence = await run(withFresh, steps);
          if (divergence === null) continue;
          // the first one is shrunk to the operations that still produce it
          const shrunk = failures.length === 0 ? await shrink(withFresh, steps, divergence.kind) : undefined;
          failures.push({ seed, mix, ...divergence, ...(shrunk === undefined ? {} : { steps: shrunk }) });
        }
        if (failures.length > 0) assert.fail(`${failures.length} sequence(s) diverged from the documented intent:\n`
          + failures.map((failure) => JSON.stringify(failure)).join('\n'));
      });
    }
  });
}
