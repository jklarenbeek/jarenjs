// @jarenjs/linq/model — the type half of the agreement: InferMeta<> of the
// fixture model rebuilt through the pen is IDENTICAL to the EntityMetaMap
// @jarenjs/db's entityEmitModel + @jarenjs/emit generate for the same
// document (db-generated.ts), member by member and as a whole; the typed
// store binds to it with no generate step; the negatives are pinned.
import * as m from '@jarenjs/linq/model';
import type { InferMeta, EntityDoc, EntityInput, RelationBuilder } from '@jarenjs/linq/model';
import { EntityNeverBuilder } from '@jarenjs/linq/model';
import type * as G from './db-generated.js';
import { typedStore } from '@jarenjs/db/typed';
import type { Store } from '@jarenjs/db';
import type { DateTime } from '@jarenjs/linq';
import { fixtureModel, notesModel, placesModel, Place } from '../linq/model-corpus.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Meta = InferMeta<typeof fixtureModel>;

// member by member, so a drift names its member
const userDoc: Equals<Meta['User']['doc'], G.User> = true;
const userInput: Equals<Meta['User']['input'], G.UserInput> = true;
const userKey: Equals<Meta['User']['key'], string> = true;
const userRelations: Equals<Meta['User']['relations'], G.EntityMetaMap['User']['relations']> = true;
const postDoc: Equals<Meta['Post']['doc'], G.Post> = true;
const postInput: Equals<Meta['Post']['input'], G.PostInput> = true;
const postKey: Equals<Meta['Post']['key'], number> = true;
const postRelations: Equals<Meta['Post']['relations'], G.EntityMetaMap['Post']['relations']> = true;
const labelDoc: Equals<Meta['Label']['doc'], G.Label> = true;
const labelInput: Equals<Meta['Label']['input'], G.LabelInput> = true;
const gradeDoc: Equals<Meta['Grade']['doc'], G.Grade> = true;
const gradeInput: Equals<Meta['Grade']['input'], G.GradeInput> = true;
const gradeKey: Equals<Meta['Grade']['key'], { student: string; course: string }> = true;
// and the whole map
const whole: Equals<Meta, G.EntityMetaMap> = true;
void [userDoc, userInput, userKey, userRelations, postDoc, postInput, postKey, postRelations,
  labelDoc, labelInput, gradeDoc, gradeInput, gradeKey, whole];

// the brand survives: a date-formatted member reads as DateTime, writes as a string
const joined: Equals<Meta['User']['doc']['joined'], DateTime | undefined> = true;
const joinedIn: Equals<Meta['User']['input']['joined'], string | undefined> = true;
void [joined, joinedIn];

// the typed store binds without a generate step; load results widen by include
declare const store: Store;
const typed = typedStore<Meta>(store);
async function loads(): Promise<void> {
  const users = await typed.entity('User').load({ include: { posts: true, labels: { count: true } } });
  const firstPosts: G.Post[] = users[0].posts;
  const labelCount: number = users[0].labels;
  const created: G.User = await typed.entity('User').create({ email: 'a@x' });
  const post = await typed.entity('Post').get(1);
  const author: G.User | undefined = post?.author;
  void [firstPosts, labelCount, created, author];
  // @ts-expect-error — a relation projection is not writable
  await typed.entity('User').create({ email: 'a@x', posts: [] });
  // @ts-expect-error — a wrong include key never types
  await typed.entity('User').load({ include: { nope: true } });
}
void loads;

// the other corpus models type too
type Notes = InferMeta<typeof notesModel>;
const noteInput: Equals<Notes['Note']['input'], { text: string; id?: string; slug?: string; created?: string; touched?: string; kind?: 'memo' | 'todo'; weight?: number; tags?: string[] }> = true;
const noteDoc: Equals<Notes['Note']['doc'], { id: string; text: string; slug?: string; created?: DateTime; touched?: DateTime; kind?: 'memo' | 'todo'; weight?: number; tags?: string[] }> = true;
const noRelations: Equals<Notes['Note']['relations'], {}> = true;
const noEntities: Equals<keyof InferMeta<typeof placesModel>, never> = true;
void [noteInput, noteDoc, noRelations, noEntities];

// an index path is checked against the collection's document shape
void m.collection(Place, { key: (d) => d.id, indexes: [m.index((p) => p.embedding, { derive: 'vector', dims: 4 })] });
void m.collection(Place, { indexes: [m.index([(p) => p.series, (p) => p.t])] });

// the x-entity primitive is typed to the closed vocabulary, and carries no flag
void m.string().entity({ key: true, unique: true });
void m.datetime().entity({ column: 'integer', default: 'now' });
void m.integer().entity({ version: true });
// an array's unique() is the schema pen's uniqueItems, and keeps the subclass
const uniq: m.EntityArrayBuilder<string[], string[]> = m.array(m.string()).unique();
void uniq;

// ——— the negatives ———
// @ts-expect-error — a relation target the model does not declare
void m.defineModel({ entities: { User: m.object({ id: m.string().key(), posts: m.rel.hasMany('Psot', { via: 'authorId', onDelete: 'cascade' }) }), Post: m.object({ pid: m.integer().key() }) } });
// @ts-expect-error — identity('uuid') allocates a string key; an integer takes 'auto'
void m.integer().identity('uuid');
// @ts-expect-error — identity('auto') is an integer's; a string takes 'uuid'
void m.string().identity('auto');
// @ts-expect-error — a misspelled member is not a path into this shape
void m.collection(Place, { indexes: [m.index((p) => p.nope)] });
// @ts-expect-error — an entity has no indexes option: it is a builder, not a collection()
void m.defineModel({ entities: { Place: m.collection(Place, { indexes: [] }) } });
// @ts-expect-error — column('integer') is an epoch column over a date-formatted string
void m.string().column('integer');
// @ts-expect-error — x-entity is owned here
void m.string().meta({ 'x-entity': { key: true } });
// @ts-expect-error — the schema pen's builders carry no vocabulary
void (await import('@jarenjs/linq/schema')).string().key();
// @ts-expect-error — entity() writes the closed x-entity vocabulary
void m.string().entity({ bogus: true });
// @ts-expect-error — the concurrency token is an integer column
void m.string().version();
// @ts-expect-error — an object member has no column of its own
void m.object({ a: m.string() }).key();
// @ts-expect-error — nor does an array member
void m.array(m.string()).index();

// the surface, named
const doc: EntityDoc<{ A: typeof Place }, 'A'> = { id: 'a', loc: [1], series: 's', t: 1 };
const input: EntityInput<{ A: typeof Place }, 'A'> = doc;
void [input];

// ——— the declared surface and the runtime surface are one set ———
// RelationBuilder is a TYPE — a relation member is a plain builder at
// run time, met through rel.* — and EntityNeverBuilder is a VALUE the
// module really exports. The census in test/linq/types.test.js holds
// both halves equal for every pen.
const authored: RelationBuilder<'User', false, 'oneToOne'> =
  m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' });
const many: RelationBuilder<'Tag', true, 'manyToMany'> = m.rel.belongsToMany('Tag');
const isNever: boolean = m.never() instanceof EntityNeverBuilder;
void [authored, many, isNever];

// @ts-expect-error RelationBuilder is exported as a type only
void m.RelationBuilder;
