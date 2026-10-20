//@ts-check
/**
 * Radiant OS studio kernel: the post office, the board (its DAG of
 * blockers and its collision push-out), the skill ladder, the library
 * (Markdown sections, the lexical index, pages, the offline answer,
 * speech), the coach and its quests, the app blocks and their compiler,
 * and the crew game's whole round — turns, the crew's builds, the
 * employers' review with its absolute veto, the launch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '@jarenjs/app';
import { renderToString } from '@jarenjs/view';
import { FOLDERS, MAIL_LIMITS, emptyMail, postMail, readThread, threadSummaries, unreadCount, isMail } from '../../packages/website/src/os/kernel/mail.js';
import { BOARD_LIMITS, emptyBoard, addCard, editCard, linkCards, removeItem, blockedCards, settleCard, isBoard } from '../../packages/website/src/os/kernel/board.js';
import { LADDER, SKILLS, RANKS, emptyProfile, expected, ratingOf, rate, isMastered, targetDifficulty, pickChallenge, rankOf, award, isProfile } from '../../packages/website/src/os/kernel/ladder.js';
import { SECTION_MAX, sectionPieces, markdownSections, libraryFrom, isLibrary, createLibraryIndex, sentences, speechOf, readSections, answerFromDocs, placeOf } from '../../packages/website/src/os/kernel/library.js';
import { QUESTS, COACH_SIGNALS, emptyCoach, currentStep, stepDone, advanceCoach, isCoach } from '../../packages/website/src/os/kernel/coach.js';
import { BLOCK_KINDS, BLOCK_INKS, BLOCK_CATALOG, isBlock, describeBlock, blockChars, buildApp, planBlock } from '../../packages/website/src/os/kernel/blocks.js';
import {
  IDEAS_PER_TURN, BUILDS_PER_ROUND, MAX_TRIES, CREW, EMPLOYER_COLORS, CREW_FLOW, crewStep, newProject, currentEmployer, addIdea, endTurn,
  openIdeas, build, crewDone, review, approvedBlocks, projectApp, scriptedCrew, isProject,
} from '../../packages/website/src/os/kernel/crew.js';

describe('the post office', () => {
  it('files posts into threads, newest first, and counts what is unread', () => {
    let mail = emptyMail();
    const first = postMail(mail, { subject: 'Hello', folder: 'council', from: 'oracle', to: ['human'], text: 'One', at: 1 });
    mail = first.mail;
    assert.equal(first.thread, 't1');
    const second = postMail(mail, { thread: first.thread, from: 'human', to: ['oracle'], text: 'Two', at: 2, tool: { name: 'x', ok: true } });
    mail = second.mail;
    assert.equal(mail.threads.length, 1);
    assert.equal(mail.threads[0].messages.length, 2);
    assert.equal(mail.threads[0].unread, 1, 'the human’s own words are never unread');
    assert.deepEqual(mail.threads[0].people, ['oracle', 'human']);
    assert.ok(mail.threads[0].messages[1].tool);
    mail = postMail(mail, { thread: 'named', subject: 'x'.repeat(200), folder: 'nowhere', from: 'critic', text: 'Three', at: 3 }).mail;
    assert.equal(mail.threads[0].id, 'named', 'a named new thread keeps its name');
    assert.equal(mail.threads[0].folder, 'inbox', 'an unknown folder is the inbox');
    assert.equal(mail.threads[0].subject.length, 80);
    assert.equal(unreadCount(mail), 2);
    assert.equal(threadSummaries(mail, 'council').length, 1);
    assert.equal(threadSummaries(mail, 'all').length, 2);
    assert.match(threadSummaries(mail)[1].last, /^human: Two/);
    mail = readThread(mail, 't1');
    assert.equal(unreadCount(mail), 1);
    assert.equal(unreadCount(readThread(mail, 'none')), 1, 'an unknown thread changes nothing');
    assert.equal(threadSummaries({ threads: [{ id: 'e', subject: 's', folder: 'inbox', people: [], updated: 0, unread: 0, messages: [] }], seq: 0 })[0].last, '');
    assert.deepEqual(FOLDERS.slice(0, 2), ['inbox', 'council']);
  });

  it('keeps only so much, and restores only what it can read', () => {
    let mail = emptyMail();
    for (let i = 0; i < MAIL_LIMITS.messages + 5; i++) mail = postMail(mail, { thread: 'long', from: 'oracle', text: String(i), at: i }).mail;
    assert.equal(mail.threads[0].messages.length, MAIL_LIMITS.messages);
    for (let i = 0; i < MAIL_LIMITS.threads + 3; i++) mail = postMail(mail, { from: 'oracle', text: `t${i}`, at: i }).mail;
    assert.equal(mail.threads.length, MAIL_LIMITS.threads);
    assert.equal(isMail(mail), true);
    assert.equal(isMail(null), false);
    assert.equal(isMail({ seq: 0, threads: [{ id: 1 }] }), false);
    assert.equal(postMail(emptyMail(), { from: 'x', text: 'y'.repeat(MAIL_LIMITS.text + 10), at: 0 }).mail.threads[0].messages[0].text.length, MAIL_LIMITS.text);
  });
});

describe('the board', () => {
  it('pins, edits, connects and removes cards', () => {
    let board = emptyBoard();
    const a = addCard(board, { kind: 'todo', text: '  Write the brief  ', by: 'human' });
    assert.ok('board' in a);
    board = a.board;
    assert.equal(board.cards[0].text, 'Write the brief');
    const b = addCard(board, { kind: 'todo', text: 'Ship it', by: 'oracle', color: 9, ref: { kind: 'doc', id: 'flow', label: 'Flow' } });
    assert.ok('board' in b);
    board = b.board;
    assert.equal(board.cards[1].color, 5, 'colours clamp');
    const blocks = linkCards(board, { from: a.id, to: b.id, kind: 'blocks' });
    assert.ok('board' in blocks);
    board = blocks.board;
    assert.deepEqual([...blockedCards(board)], [b.id], 'a todo waits on its blocker');
    assert.deepEqual(linkCards(board, { from: b.id, to: a.id, kind: 'blocks' }), { error: 'duplicate' });
    const c = addCard(board, { kind: 'note', text: 'idea', by: 'human' });
    assert.ok('board' in c);
    board = c.board;
    const bc = linkCards(board, { from: b.id, to: c.id, kind: 'blocks' });
    assert.ok('board' in bc);
    board = bc.board;
    assert.deepEqual(linkCards(board, { from: c.id, to: a.id, kind: 'blocks' }), { error: 'cycle' }, 'no cycle of blockers');
    assert.ok('board' in linkCards(board, { from: c.id, to: a.id }), 'a plain relation may close a loop');
    assert.deepEqual(linkCards(board, { from: a.id, to: a.id }), { error: 'self' });
    assert.deepEqual(linkCards(board, { from: a.id, to: 'nope' }), { error: 'not-found' });
    const done = editCard(board, { id: a.id, done: true, text: '  ', color: 2, x: 99999 });
    assert.ok('board' in done);
    board = done.board;
    assert.equal(board.cards[0].text, 'Write the brief', 'empty words keep the old ones');
    assert.equal(board.cards[0].x, BOARD_LIMITS.width - BOARD_LIMITS.cardW, 'moves stay on the wall');
    assert.deepEqual([...blockedCards(board)], [c.id], 'a done blocker releases its todo; the next in the chain still waits');
    assert.deepEqual(editCard(board, { id: 'nope' }), { error: 'not-found' });
    const linkId = board.links[0].id;
    const unlinked = removeItem(board, linkId);
    assert.ok('board' in unlinked && unlinked.board.links.length === board.links.length - 1);
    const removed = removeItem(board, b.id);
    assert.ok('board' in removed && removed.board.cards.length === 2 && removed.board.links.every((l) => l.from !== b.id && l.to !== b.id));
    assert.deepEqual(removeItem(board, 'nope'), { error: 'not-found' });
    assert.equal(isBoard(board), true);
    assert.equal(isBoard({ cards: [{ id: 'x', kind: 'sticker' }], links: [], seq: 0 }), false);
  });

  it('never piles cards: a card dropped on another is pushed clear', () => {
    let board = emptyBoard();
    const a = addCard(board, { kind: 'note', text: 'A', by: 'human', x: 100, y: 100 });
    assert.ok('board' in a);
    board = a.board;
    const b = addCard(board, { kind: 'note', text: 'B', by: 'human', x: 120, y: 110 });
    assert.ok('board' in b);
    board = b.board;
    const [ca, cb] = board.cards;
    const overlap = Math.min(ca.x + BOARD_LIMITS.cardW, cb.x + BOARD_LIMITS.cardW) - Math.max(ca.x, cb.x) > 0
      && Math.min(ca.y + BOARD_LIMITS.cardH, cb.y + BOARD_LIMITS.cardH) - Math.max(ca.y, cb.y) > 0;
    assert.equal(overlap, false);
    assert.equal(settleCard(board, 'nope'), board);
    assert.equal(settleCard(board, a.id), board, 'a card already clear stays put');
    let full = emptyBoard();
    for (let i = 0; i < BOARD_LIMITS.cards; i++) {
      const out = addCard(full, { kind: 'note', text: `n${i}`, by: 'human' });
      assert.ok('board' in out);
      full = out.board;
    }
    assert.deepEqual(addCard(full, { kind: 'note', text: 'one more', by: 'human' }), { error: 'full' });
  });
});

describe('the ladder', () => {
  it('rates attempts the way Monkey Grove does, and aims at two in three', () => {
    assert.equal(expected(600, 600), 0.5);
    assert.ok(Math.abs(expected(600, 600 - LADDER.offset) - 0.65) < 0.01, 'the offset is the 65 % target');
    let profile = emptyProfile();
    assert.deepEqual(ratingOf(profile, 'machine'), { r: 600, n: 0, hist: [] });
    const first = rate(profile, { skill: 'machine', correct: true, difficulty: 600 });
    assert.equal(first.delta, 16, 'a new skill moves by K = 32');
    profile = first.profile;
    const hinted = rate(profile, { skill: 'machine', correct: true, difficulty: 616, hinted: true });
    assert.ok(hinted.delta < first.delta, 'a hinted success counts for less');
    for (let i = 0; i < 30; i++) profile = rate(profile, { skill: 'math', correct: true, difficulty: 1000 }).profile;
    assert.equal(isMastered(ratingOf(profile, 'math')), true);
    assert.equal(ratingOf(profile, 'math').hist.length, LADDER.history);
    const settled = rate(profile, { skill: 'math', correct: false, difficulty: 1000 });
    assert.ok(Math.abs(settled.delta) <= 16, 'a settled skill moves by K = 16');
    assert.equal(targetDifficulty(emptyProfile(), 'x'), 600 - LADDER.offset);
    assert.equal(pickChallenge(emptyProfile(), [{ skill: 'x', difficulty: 900 }, { skill: 'x', difficulty: 500 }])?.difficulty, 500);
    assert.equal(pickChallenge(emptyProfile(), []), null);
    assert.ok(SKILLS.some((s) => s.id === 'turing'));
  });

  it('ranks experience and hands out badges once', () => {
    assert.deepEqual(rankOf(0), { title: 'Chalk', level: 0, next: 'Sketch', progress: 0 });
    assert.equal(rankOf(RANKS[2].xp).title, 'Tag');
    assert.equal(rankOf(1e9).next, null);
    assert.equal(rankOf(1e9).progress, 1);
    const up = award(emptyProfile(), 70, 'first');
    assert.equal(up.rankUp, true);
    assert.deepEqual(up.profile.badges, ['first']);
    assert.deepEqual(award(up.profile, 1, 'first').profile.badges, ['first']);
    assert.equal(award(up.profile, -5).profile.xp, 70);
    assert.equal(isProfile(up.profile), true);
    assert.equal(isProfile({ xp: -1, skills: {}, badges: [] }), false);
  });
});

const MD = `---
package: test
---
# Flow

The flow package runs machines. It compiles documents! See [the docs](./x.md) and \`compileFsm\`.

## Machines

- **States** are ids
- transitions carry _guards_

\`\`\`js
compileFsm(doc);
\`\`\`

| a | b |
| --- | --- |
| 1 | 2 |

![a picture](p.png)
<!-- hidden -->
### Open fence
\`\`\`
never closed`;

describe('the library', () => {
  it('cuts Markdown into plain sections, code apart', () => {
    const sections = markdownSections(MD, { title: 'Doc' });
    assert.deepEqual(sections.map((s) => [s.heading, s.code]), [['Flow', false], ['Machines', false], ['Machines', true], ['Machines', false], ['Open fence', true]]);
    assert.match(sections[0].text, /See the docs and compileFsm\./);
    assert.match(sections[1].text, /• States are ids\n• transitions carry guards/);
    assert.equal(sections[2].text, 'compileFsm(doc);');
    assert.ok(!sections[3].text.includes('---'), 'table rules are dropped');
    assert.equal(sections[4].text, 'never closed');
    assert.equal(markdownSections('plain text', {})[0].heading, '');
  });

  it('continues a long section in the next instead of cutting it off', () => {
    const para = (/** @type {string} */ word) => `${word} `.repeat(300).trim();
    const long = markdownSections(`# Usage\n\n${para('alpha')}\n\n${para('beta')}\n\n${para('gamma')}`);
    assert.deepEqual(long.map((s) => s.heading), ['Usage', 'Usage (2)', 'Usage (3)']);
    assert.deepEqual(long.map((s) => s.text.split(' ')[0]), ['alpha', 'beta', 'gamma'], 'prose breaks at its paragraphs');
    assert.equal(long.map((s) => s.text).join('\n\n'), [para('alpha'), para('beta'), para('gamma')].join('\n\n'), 'nothing is dropped');
    const sentences = sectionPieces(Array.from({ length: 200 }, (_, i) => `Sentence ${i} ends here.`).join(' '), false);
    assert.ok(sentences.length > 1 && sentences.every((p) => p.length <= SECTION_MAX && p.endsWith('.')), 'a long paragraph breaks at its sentences');
    const code = sectionPieces(Array.from({ length: 400 }, (_, i) => `line(${i});`).join('\n'), true);
    assert.ok(code.length > 1 && code.every((p) => p.length <= SECTION_MAX && p.endsWith(';')), 'code breaks at its lines');
    const word = sectionPieces('x'.repeat(SECTION_MAX + 50), false);
    assert.deepEqual(word.map((p) => p.length), [SECTION_MAX, 50], 'only what cannot break is cut, and kept');
    assert.deepEqual(sectionPieces('short', false), ['short']);
  });

  it('indexes, searches, pages, answers and reads aloud', () => {
    const library = libraryFrom([
      { id: 'flow', title: '@jarenjs/flow', source: 'flow.md', markdown: MD },
      { id: 'db', title: '@jarenjs/db', source: 'db.md', markdown: '# Store\n\nThe store keeps documents in SQLite. Collections have keys.' },
    ]);
    assert.equal(isLibrary(library), true);
    assert.equal(isLibrary({ $library: '0.2', docs: [] }), false);
    const index = createLibraryIndex(library);
    assert.equal(index.size, 6);
    const hits = index.search('sqlite store', 3);
    assert.equal(hits[0].doc, 'db');
    assert.match(hits[0].excerpt, /SQLite/);
    assert.equal(index.doc('db')?.title, '@jarenjs/db');
    assert.equal(index.doc('none'), null);
    const answer = answerFromDocs('sqlite store', hits);
    assert.match(answer.text, /^Here is what the documentation says:\n1\. The store keeps documents in SQLite\./);
    assert.equal(answer.citations[0].doc, 'db');
    assert.match(answerFromDocs('nothing at all', []).text, /could not find “nothing at all”/);
    const hit = { doc: 'flow', section: 0, title: 'Flow', heading: 'Flow', excerpt: 'x', score: 1 };
    assert.equal(placeOf(hit), 'Flow', 'a section named like its document is not named twice');
    assert.equal(placeOf({ ...hit, heading: 'Guards' }), 'Flow — Guards');
    assert.equal(placeOf({ ...hit, heading: '' }), 'Flow');
    const page = readSections(library, 'flow', 0, 2);
    assert.equal(page?.sections.length, 2);
    assert.equal(page?.next, 2);
    assert.equal(readSections(library, 'flow', 4, 9)?.next, null);
    assert.equal(readSections(library, 'none'), null);
    assert.deepEqual(sentences('One. Two! • a • b'), ['One.', 'Two!', '• a', '• b']);
    assert.deepEqual(speechOf([{ heading: 'H', text: 'A. B.', code: false }, { heading: 'C', text: 'x', code: true }]), ['H', 'A.', 'B.']);
    const long = createLibraryIndex(libraryFrom([{ id: 'l', title: 'L', source: 'l', markdown: `# L\n\nalpha ${'word '.repeat(80)}beta.` }]));
    assert.ok(long.search('alpha beta', 1)[0].excerpt.endsWith('…'), 'long excerpts are cut');
    index.dispose();
  });
});

describe('the coach', () => {
  it('walks its quests as the signals allow, awarding as it goes', () => {
    assert.ok(QUESTS.length >= 8);
    assert.ok(QUESTS.every((q) => q.steps.length > 0 && q.steps.every((s) => typeof s.target === 'string')));
    let coach = emptyCoach();
    assert.equal(isCoach(coach), true);
    assert.equal(currentStep(coach)?.quest.id, 'first-dance');
    const none = advanceCoach(coach, emptyProfile(), { marks: {}, sessions: 0 });
    assert.deepEqual(none.events, []);
    const all = { marks: { open_machine: 1, draft: 1, propose: 1 }, sessions: 0, verdicts: 0, notes: 0, links: 0, ticked: 0 };
    const out = advanceCoach(coach, emptyProfile(), all);
    assert.deepEqual(out.events.map((e) => e.kind), ['step', 'step', 'quest'], 'several steps at once when the player is ahead');
    assert.ok(out.profile.xp > 0);
    assert.ok(out.profile.badges.includes('quest:first-dance'));
    coach = out.coach;
    assert.deepEqual(coach.done, ['first-dance']);
    assert.notEqual(coach.quest, 'first-dance');
    assert.equal(stepDone({ text: '', target: '', check: { $ge: ['$.nope.deeper', 1] } }, null), false, 'a check that cannot evaluate is not done');
    assert.equal(currentStep({ ...coach, quest: null }), null);
    assert.equal(currentStep({ ...coach, step: 99 }), null);
    // finishing everything leaves the coach with no quest
    const marks = Object.fromEntries(QUESTS.flatMap((q) => q.steps.flatMap((s) => [...JSON.stringify(s.check).matchAll(/marks\.([a-z_]+)/g)].map((m) => [m[1], 9]))));
    const done = advanceCoach(emptyCoach(), emptyProfile(), { marks, sessions: 9, verdicts: 9, notes: 9, links: 9, ticked: 9 });
    assert.equal(done.coach.quest, null);
    assert.equal(done.coach.done.length, QUESTS.length);
    assert.match(done.events.at(-1)?.text ?? '', /last one/);
    assert.ok(done.events.some((e) => e.kind === 'rank'));
    assert.equal(isCoach({ quest: 3 }), false);
    assert.ok('marks' in COACH_SIGNALS);
  });
});

describe('the building blocks', () => {
  /** @type {any[]} */
  const every = [
    { kind: 'title', text: 'Water' }, { kind: 'note', text: 'n'.repeat(60) }, { kind: 'counter', label: 'glasses', step: 2, start: 1 },
    { kind: 'checklist', label: 'Morning', items: ['tea'] }, { kind: 'input', label: 'Friends', placeholder: 'name' },
    { kind: 'toggle', label: 'Reminders', on: true }, { kind: 'quiz', question: '2+2?', options: ['3', '4'], answer: 1 },
    { kind: 'palette', label: 'Accent', colors: [1, 3] },
  ];

  it('checks, describes and measures every kind', () => {
    assert.deepEqual(BLOCK_KINDS, every.map((b) => b.kind));
    assert.equal(BLOCK_CATALOG.length, BLOCK_KINDS.length);
    assert.equal(BLOCK_INKS.length, 6);
    for (const b of every) {
      assert.equal(isBlock(b), true, b.kind);
      assert.ok(describeBlock(b).length > 5);
      assert.equal(blockChars(b), JSON.stringify(b).length);
    }
    assert.match(describeBlock(every[1]), /…/);
    assert.match(describeBlock({ kind: 'checklist', label: 'x', items: ['a', 'b'] }), /2 items/);
    for (const bad of [null, { kind: 'title', text: '' }, { kind: 'counter', label: 'x', step: 0 }, { kind: 'counter', label: 'x', start: 5000 },
      { kind: 'checklist', label: 'x', items: [] }, { kind: 'input', label: 'x', placeholder: 'p'.repeat(41) }, { kind: 'toggle', label: 'x', on: 'yes' },
      { kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 2 }, { kind: 'palette', label: 'x', colors: [9, 1] }, { kind: 'video' }]) {
      assert.equal(isBlock(bad), false, JSON.stringify(bad));
    }
  });

  it('compiles blocks into an app document the app runtime runs', () => {
    const doc = buildApp(every, { title: 'Water' });
    const app = createApp(doc, { schedule: (/** @type {() => void} */ f) => f(), onError: (/** @type {any} */ e) => { throw e; } });
    app.dispatch('b2/up');
    app.dispatch('b2/down');
    app.dispatch('b2/up');
    app.dispatch('b3/tick0');
    app.dispatch('b5/flip');
    app.dispatch('b6/pick1');
    app.dispatch('b7/pick1');
    app.dispatch('b4/add');
    const s = app.getState();
    assert.equal(s.b2.count, 3);
    assert.deepEqual(s.b3.done, [true]);
    assert.equal(s.b5.on, false);
    assert.deepEqual(s.b4.items, [], 'nothing typed, nothing added');
    const html = renderToString(app.getVnode());
    assert.match(html, /Right!/);
    assert.match(html, /--mini-accent:#16a34a/, 'the palette’s pick is the accent');
    app.dispatch('b6/pick0');
    assert.match(renderToString(app.getVnode()), /Not quite/);
    app.destroy();
    assert.match(renderToString(createApp(buildApp([]), {}).getVnode()), /Nothing built yet/);
  });

  it('plans a block from an idea in plain words', () => {
    assert.deepEqual(planBlock('A counter for glasses of water'), { kind: 'counter', label: 'glasses of water', step: 1 });
    assert.deepEqual(planBlock('A checklist: milk, eggs and bread').items, ['milk', 'eggs', 'bread']);
    assert.deepEqual(planBlock('Quiz "Capital of France?": Paris, Rome'), { kind: 'quiz', question: 'Capital of France?', options: ['Paris', 'Rome'], answer: 0 });
    assert.deepEqual(planBlock('a quiz').options, ['Yes', 'No']);
    assert.equal(planBlock('Dark mode switch').kind, 'toggle');
    assert.equal(planBlock('Let people add names of friends').kind, 'input');
    assert.equal(planBlock('Pick colours').kind, 'palette');
    assert.deepEqual(planBlock('Call it "Daily Dance"'), { kind: 'title', text: 'Daily Dance' });
    assert.equal(planBlock('Something nice').kind, 'note');
    assert.equal(planBlock('todo').kind, 'checklist');
    assert.equal(planBlock(`A counter for ${'x'.repeat(80)}`).label.length, 40);
    for (const idea of ['', 'counter', 'quiz: a', 'checklist']) assert.equal(isBlock(planBlock(idea || 'note')), true, idea);
  });
});

describe('the crew game', () => {
  it('turns: employers add ideas, pass, and hand over to the crew', () => {
    assert.equal(CREW_FLOW.$fsm, '0.1');
    assert.deepEqual(crewStep('employer', 'pass', { last: false }), { phase: 'employer', effects: ['next-employer'] });
    assert.deepEqual(crewStep('employer', 'pass', { last: true }), { phase: 'crew', effects: ['crew-turn'] });
    assert.deepEqual(crewStep('review', 'reviewed', { approved: 4, goal: 4 }), { phase: 'shipped', effects: ['launch'] });
    let p = newProject({ title: '  Water  ', players: ['Ada', ' ', 'Bo'], goal: 99 });
    assert.equal(p.title, 'Water');
    assert.equal(p.goal, 12);
    assert.deepEqual(p.players.map((e) => e.name), ['Ada', 'Employer 2', 'Bo']);
    assert.equal(p.players[2].color, EMPLOYER_COLORS[2]);
    assert.equal(newProject({ title: '', players: [] }).players[0].name, 'Employer');
    assert.equal(currentEmployer(p).name, 'Ada');
    const one = addIdea(p, { text: 'a counter for glasses' });
    assert.ok('project' in one);
    p = one.project;
    assert.deepEqual(addIdea(p, { text: '   ' }), { error: 'empty' });
    const two = addIdea(p, { text: 'a checklist: tea, toast', kind: 'polish' });
    assert.ok('project' in two);
    p = two.project;
    assert.deepEqual(addIdea(p, { text: 'one too many' }), { error: 'turn-full' });
    assert.equal(IDEAS_PER_TURN, 2);
    const pass = endTurn(p);
    assert.ok('project' in pass);
    p = pass.project;
    assert.equal(currentEmployer(p).name, 'Employer 2');
    const pass2 = endTurn(p);
    assert.ok('project' in pass2);
    const pass3 = endTurn(pass2.project);
    assert.ok('project' in pass3);
    p = pass3.project;
    assert.equal(p.phase, 'crew');
    assert.deepEqual(pass3.effects, ['crew-turn']);
    assert.deepEqual(addIdea(p, { text: 'late' }), { error: 'not-your-turn' });
    assert.deepEqual(endTurn(p), { error: 'not-your-turn' });
    assert.equal(openIdeas(p).length, 2);
  });

  it('builds, reviews with the absolute veto, and ships', () => {
    let p = newProject({ title: 'Water', players: ['Ada'], goal: 2 });
    for (const text of ['a counter for glasses', 'call it "Water"']) {
      const out = addIdea(p, { text });
      assert.ok('project' in out);
      p = out.project;
    }
    const passed = endTurn(p);
    assert.ok('project' in passed);
    p = passed.project;
    const moves = scriptedCrew(p);
    assert.deepEqual(moves.map((m) => m.by), ['dancer', 'architect'], 'each idea goes to the member who builds that kind');
    assert.match(moves[0].say, /^Let us make it move: a counter for glasses\.$/);
    assert.deepEqual(build(p, { by: 'dancer', idea: 'nope', block: moves[0].block }), { error: 'not-found' });
    assert.deepEqual(build(p, { by: 'dancer', idea: moves[0].idea, block: { kind: 'video' } }), { error: 'invalid-block' });
    for (const m of moves) {
      const out = build(p, m);
      assert.ok('project' in out);
      p = out.project;
    }
    assert.deepEqual(build({ ...p, phase: 'review' }, moves[0]), { error: 'not-crew-turn' });
    assert.deepEqual(review(p, { task: 'x', verdict: 'veto' }), { error: 'not-in-review' });
    const done = crewDone(p);
    assert.ok('project' in done);
    p = done.project;
    assert.equal(p.phase, 'review');
    assert.deepEqual(crewDone(p), { error: 'not-crew-turn' });
    assert.equal(projectApp(p).state.b0.count, 0, 'a review tries the app with the pending blocks in it');
    const [t1, t2] = p.tasks;
    assert.deepEqual(review(p, { task: 'nope', verdict: 'approve' }), { error: 'not-found' });
    const v = review(p, { task: t1.id, verdict: 'veto' });
    assert.ok('project' in v);
    p = v.project;
    assert.deepEqual(v.effects, []);
    assert.equal(p.points.dancer, -1);
    assert.equal(p.ideas[0].status, 'new', 'a vetoed idea goes back to the crew');
    const a = review(p, { task: t2.id, verdict: 'approve' });
    assert.ok('project' in a);
    p = a.project;
    assert.deepEqual(a.effects, ['next-round']);
    assert.equal(p.round, 2);
    assert.equal(p.players[0].score, 2, 'an approved idea scores for whoever had it');
    assert.equal(p.phase, 'employer');
    // round two: the crew retries the vetoed idea; this time it passes and the project ships
    const passed2 = endTurn(p);
    assert.ok('project' in passed2);
    p = passed2.project;
    const retry = scriptedCrew(p);
    assert.equal(retry.length, 1);
    const b2 = build(p, retry[0]);
    assert.ok('project' in b2);
    const d2 = crewDone(b2.project);
    assert.ok('project' in d2);
    p = d2.project;
    const shipped = review(p, { task: p.tasks[2].id, verdict: 'approve' });
    assert.ok('project' in shipped);
    p = shipped.project;
    assert.deepEqual(shipped.effects, ['launch']);
    assert.equal(p.phase, 'shipped');
    assert.equal(p.stars, 3);
    assert.equal(approvedBlocks(p).length, 2);
    assert.equal(isProject(p), true);
    assert.equal(isProject({ ...p, phase: 'party' }), false);
    assert.equal(MAX_TRIES, 2);
  });

  it('drops an idea vetoed too often, skips an empty round, caps a round, and grades by rounds', () => {
    let p = newProject({ title: 'T', players: ['A'], goal: 2 });
    const one = addIdea(p, { text: 'a note' });
    assert.ok('project' in one);
    const ended = endTurn(one.project);
    assert.ok('project' in ended);
    p = ended.project;
    for (let round = 0; round < MAX_TRIES; round++) {
      const [move] = scriptedCrew(p);
      const b = build(p, move);
      assert.ok('project' in b);
      const d = crewDone(b.project);
      assert.ok('project' in d);
      const v = review(d.project, { task: d.project.tasks.at(-1)?.id ?? '', verdict: 'veto' });
      assert.ok('project' in v);
      const e = endTurn(v.project);
      assert.ok('project' in e);
      p = e.project;
    }
    assert.equal(p.ideas[0].status, 'dropped');
    const empty = crewDone(p);
    assert.ok('project' in empty);
    assert.deepEqual(empty.effects, ['next-round'], 'nothing to build goes straight back');
    let big = newProject({ title: 'Big', players: ['A', 'B', 'C'], goal: 12 });
    for (let k = 0; k < 3; k++) {
      for (const text of ['a note', 'another note']) {
        const add = addIdea(big, { text });
        assert.ok('project' in add);
        big = add.project;
      }
      const e = endTurn(big);
      assert.ok('project' in e);
      big = e.project;
    }
    assert.equal(scriptedCrew(big).length, BUILDS_PER_ROUND, 'four builds a round at most');
    for (const m of scriptedCrew(big)) {
      const b = build(big, m);
      assert.ok('project' in b);
      big = b.project;
    }
    const extra = openIdeas(big)[0];
    assert.deepEqual(build(big, { by: 'critic', idea: extra.id, block: { kind: 'note', text: 'x' } }), { error: 'round-full' });
    assert.equal(scriptedCrew(big).length, 0);
    const graded = (/** @type {number} */ round) => {
      let g = newProject({ title: 'g', players: ['A'], goal: 2 });
      g = { ...g, round, phase: 'review', tasks: [
        { id: 'k1', idea: 'i1', by: 'critic', block: { kind: 'note', text: 'a' }, status: 'approved', round },
        { id: 'k2', idea: 'i2', by: 'critic', block: { kind: 'note', text: 'b' }, status: 'review', round },
      ], ideas: [{ id: 'i1', by: 'p1', text: 'a', kind: 'feature', status: 'approved', tries: 0 }, { id: 'i2', by: 'p1', text: 'b', kind: 'feature', status: 'built', tries: 0 }] };
      const out = review(g, { task: 'k2', verdict: 'approve' });
      return 'project' in out ? out.project.stars : -1;
    };
    assert.deepEqual([graded(1), graded(3), graded(5)], [3, 2, 1]);
    assert.equal(CREW.length, 4);
  });
});
