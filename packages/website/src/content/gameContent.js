//@ts-check
/**
 * "The Unbearable Lightness of Being a Pirate" — the adventure content as
 * plain data (validated at boot against the game domain schemas). The high-
 * level design came from the three-model pipeline (orchestrator + storyteller);
 * this is the curated, shippable script. Every puzzle is soft-lock-proof and
 * every character keeps a consistent voice — the same voices the dynamic AI
 * tier is told to speak in when the player brings a key.
 *
 * No player death, no dead ends: the scene graph is bidirectional and every
 * puzzle has a dialogue clue you can always re-hear.
 */

export const TITLE = 'The Unbearable Lightness of Being a Pirate';
export const GOAL = "Assemble the World's Most Delicious Sea-Sandwich before the rival culinary pirate fleet docks at dawn.";

/** The point-and-click verbs. */
export const VERBS = [
  { id: 'look', label: 'Look at' },
  { id: 'take', label: 'Pick up' },
  { id: 'use', label: 'Use' },
  { id: 'talk', label: 'Talk to' },
  { id: 'give', label: 'Give' },
];

/** Locations. `exits` is bidirectional by construction (see gameFsms). */
export const LOCATIONS = {
  wharf: {
    id: 'wharf', name: 'The Dock of Shame', icon: '⚓',
    look: 'A crooked pier smelling of damp rope and poor decisions, where ships arrive reluctantly and seagulls judge your footwear. A bolted cargo crate sulks in the corner.',
    exits: ['market', 'diner'],
  },
  market: {
    id: 'market', name: 'The Bazaar of Bargains', icon: '🫙',
    look: 'A sprawl of stalls selling questionable spices, overpriced charts, and the undivided attention of one very polite skeleton who keeps asking for the time.',
    exits: ['wharf', 'galleon'],
  },
  diner: {
    id: 'diner', name: 'The Salty Spoon', icon: '🍽️',
    look: "A grease-stained tavern with a menu written entirely in metaphors and a view of the horizon you didn't order.",
    exits: ['wharf', 'lighthouse'],
  },
  galleon: {
    id: 'galleon', name: 'The Gilded Guppy', icon: '⛵',
    look: "Captain Crumble's prize ship: meticulously clean, confusingly organized, and perpetually playing a tinny brass band on loop.",
    exits: ['market', 'lighthouse'],
  },
  lighthouse: {
    id: 'lighthouse', name: 'Periscope Peak', icon: '🗼',
    look: 'A leaning tower of glass and brass that doubles as a dueling ground, a storage closet, and a surprisingly decent vantage point. A great switch juts from the wall, jammed.',
    exits: ['diner', 'galleon'],
  },
};
export const START_LOCATION = 'wharf';

/** Characters. `voice` is fed verbatim to the dynamic AI tier. */
export const CHARACTERS = {
  gullbert: {
    id: 'gullbert', name: 'Gullbert the Gull', at: 'wharf', mood: 'ominous',
    voice: 'A seagull who speaks in one-word gravelly grunts that somehow convey profound existential dread and, occasionally, a genuinely useful tip. Never more than a few words.',
    look: 'A gull of enormous dignity and questionable diet, perched like a small, damp philosopher.',
  },
  marina: {
    id: 'marina', name: 'Dr. Marina Barnacle', at: 'market', mood: 'serene',
    voice: 'A slow, melodic alchemist and flavor theorist who speaks ENTIRELY in culinary metaphors, with gentle, slightly condescending warnings. Wise but insufferable.',
    look: 'An alchemist whose lab coat is stained with fourteen kinds of reduction.',
  },
  miles: {
    id: 'miles', name: "Miles 'The Marinated' O'Flaherty", at: 'diner', mood: 'anxious',
    voice: 'A nervous, fast-talking former sous-chef turned reluctant pirate who describes absolutely everything — combat, weather, grief — as if it were a dinner service running behind.',
    look: "The Salty Spoon's chef, sweating gently over a pan that hasn't been lit in years.",
  },
  crumble: {
    id: 'crumble', name: 'Captain Barnaby Crumble', at: 'galleon', mood: 'earnest',
    voice: 'A deep, resonant, PAINFULLY earnest rival captain who takes every naval term literally and gets genuinely flustered by slang. Never actually villainous — just very committed.',
    look: 'A rival captain standing at parade rest beside a brass megaphone that emits only static.',
  },
  finch: {
    id: 'finch', name: 'First Mate Pippin Finch', at: 'lighthouse', mood: 'theatrical',
    voice: 'An overly theatrical duelist and lighthouse keeper who narrates his own life in a dramatic voice, then catches himself and apologizes for it mid-sentence.',
    look: 'A lighthouse keeper mid-flourish, blocking the great jammed switch with a rapier and a monologue.',
  },
};

/** Inventory items. `examine` is the look-at text; `combine` maps partner→result. */
export const ITEMS = {
  compass: {
    id: 'compass', name: 'magnetized compass', at: 'wharf', portable: true,
    examine: 'A brass compass whose needle points not north, but at whatever it most resents. Faintly magnetic.',
  },
  bottle: {
    id: 'bottle', name: 'empty bottle', at: 'wharf', portable: true,
    examine: 'An empty bottle. The label reads "MESSAGE INSIDE" but there is, pointedly, no message.',
    combine: { tidepool: 'seawater' },
  },
  crackers: {
    id: 'crackers', name: 'archipelago biscuits', at: 'diner', portable: true,
    examine: 'Ship\'s biscuits so dry they shatter anything they touch, including confidence.',
    combine: { seawater: 'brineglaze' },
  },
  pepper: {
    id: 'pepper', name: 'spicy pepper', at: 'market', portable: true,
    examine: 'A pepper so aggressive the stall-keeper keeps it under a tiny riot shield.',
  },
  // derived items (created by combining) — not placed in the world
  seawater: { id: 'seawater', name: 'bottle of seawater', portable: true, examine: 'Genuine sea, now bottled. Sloshes judgmentally.', combine: { crackers: 'brineglaze' } },
  brineglaze: { id: 'brineglaze', name: 'brine-glazed biscuits', portable: true, examine: 'Biscuits, softened into something a tooth could love. Miles would weep.' },
  recipe: { id: 'recipe', name: 'the legendary recipe', portable: true, examine: 'The recipe for the World\'s Most Delicious Sea-Sandwich. Step one is simply "believe".' },
};

/** Fixed hotspots that aren't takeable (used by look/use). */
export const SCENERY = {
  tidepool: { id: 'tidepool', at: 'wharf', name: 'tide pool', examine: 'A tide pool, home to several crabs who are, frankly, disappointed in you.' },
  crate: { id: 'crate', at: 'wharf', name: 'cargo crate', examine: 'A crate bolted shut with a magnetized padlock. Brute force only makes it smug.' },
  megaphone: { id: 'megaphone', at: 'galleon', name: 'brass megaphone', examine: 'Captain Crumble\'s megaphone. It broadcasts only a proud, confident static.' },
  switch: { id: 'switch', at: 'lighthouse', name: 'the great switch', examine: 'The lighthouse switch. Jammed — and guarded by a man who really wants to duel about it.' },
};

/**
 * Puzzles: each is soft-lock-proof. `clue` is the dialogue hint (always
 * re-hearable), `solve` is { verb, item, target } → gives `reward`.
 */
export const PUZZLES = {
  crate: {
    id: 'crate', at: 'wharf',
    clue: "Gullbert grunts: “Rust… eats iron. Iron… fears the north.”",
    solve: { verb: 'use', item: 'compass', target: 'crate' },
    // no reward item: the prize is the note in `done` (a `reward` must
    // be an ITEMS key — the consumers give it to the player)
    done: 'You press the magnetized compass to the padlock. The magnetism cancels with a sulky *clunk* and the crate yawns open — inside, a note: "the pepper likes the market."',
  },
  megaphone: {
    id: 'megaphone', at: 'galleon',
    clue: 'Dr. Barnacle hums: “Tuning is not done by ear, child. It is done by *palate*. Give the static something with a kick.”',
    solve: { verb: 'use', item: 'pepper', target: 'megaphone' },
    done: 'You wedge the spicy pepper into the megaphone’s workings. The static coughs, sneezes once — magnificently — and resolves into glorious brass-band clarity. Crumble salutes, misty-eyed: "Now THAT is seasoning with authority. Docking rights… negotiable."',
  },
  glaze: {
    id: 'glaze', at: 'diner',
    clue: "Miles frets: “Dry sails catch no wind—and dry crackers need a sea breeze, chef, we're plating in TEN!”",
    solve: { verb: 'give', item: 'brineglaze', target: 'miles' },
    reward: 'recipe',
    done: 'Miles tastes the brine-glazed biscuit, bursts into professional tears, and presses the legendary recipe into your hands. "Table four is going to LOVE you."',
  },
};

/** Authored dialogue trees (static tier). Each option may `give` a flag/item. */
export const DIALOGUE = {
  gullbert: {
    root: 'g0',
    nodes: {
      g0: { text: 'Gullbert regards you the way a cliff regards a lemming.', options: [
        { text: '"Any advice about that crate?"', to: 'g1' },
        { text: '"Nice weather."', to: 'g2' },
        { text: '(Leave)', to: null },
      ] },
      g1: { text: 'Gullbert: “Rust… eats iron. Iron… fears the north.” He is deeply satisfied by this.', give: 'clue_crate', options: [{ text: '"...Thanks?"', to: null }] },
      g2: { text: 'Gullbert: “Dawn.” A single word, freighted with doom. The rival fleet, presumably.', options: [{ text: '(Nod gravely)', to: null }] },
    },
  },
  miles: {
    root: 'm0',
    nodes: {
      m0: { text: 'Miles wipes his hands on an apron that has seen things. "Chef! You’re on. What do you need?"', options: [
        { text: '"What’s wrong with the biscuits?"', to: 'm1' },
        { text: '"Where’s the recipe?"', to: 'm2' },
        { text: '(Leave)', to: null },
      ] },
      m1: { text: 'Miles: "Dry sails catch no wind—and dry crackers need a sea breeze, chef! Soften ’em. We’re plating in TEN." ', give: 'clue_glaze', options: [{ text: '"On it."', to: null }] },
      m2: { text: 'Miles: "The recipe? Earn it. Bring me a biscuit that doesn’t assault the palate and it’s yours." ', options: [{ text: '"Deal."', to: null }] },
    },
  },
  marina: {
    root: 'r0',
    nodes: {
      r0: { text: 'Dr. Barnacle inhales as if tasting your aura. "Ah. A base note of panic. Charming."', options: [
        { text: '"How do I fix the megaphone?"', to: 'r1' },
        { text: '"Tell me about flavor."', to: 'r2' },
        { text: '(Leave)', to: null },
      ] },
      r1: { text: 'Barnacle: "Tuning is not done by ear, child. It is done by *palate*. Give the static something with a kick." ', give: 'clue_megaphone', options: [{ text: '"...Pepper?"', to: null }] },
      r2: { text: 'Barnacle: "Flavor is merely regret, seasoned. Now run along; you’re oxidizing." ', options: [{ text: '(Leave, faintly insulted)', to: null }] },
    },
  },
  crumble: {
    root: 'c0',
    nodes: {
      c0: { text: 'Captain Crumble salutes a beat too long. "State your business, sailor. And please, no *slang*. It gives me hives."', options: [
        { text: '"I come in peace, dawg."', to: 'c1' },
        { text: '"Why the culinary war?"', to: 'c2' },
        { text: '(Leave)', to: null },
      ] },
      c1: { text: 'Crumble, sweating: "‘Dawg’? Is that… a rank? A vessel? I—I shall assume you mean well." He is not okay.', options: [{ text: '"I do."', to: null }] },
      c2: { text: 'Crumble: "A sandwich this fine cannot belong to ONE crew. I merely wish to… share the docking rights. Loudly. Hence the megaphone." ', options: [{ text: '"Let’s fix your megaphone, then."', to: null }] },
    },
  },
};

/**
 * Insult sword-fighting: the signature set-piece. You learn a comeback by
 * losing to an insult, then win by answering with its matching comeback.
 * Poise, not health — you can never die or soft-lock; a wrong answer just
 * costs poise and teaches you the line.
 */
export const INSULTS = [
  { insult: 'You fight like a tide pool full of disappointed crabs!', comeback: 'And you smell like one that gave up entirely.' },
  { insult: 'Your mother was a seagull and your father smelled of evaporated brine!', comeback: 'At least they had the sense not to raise a lighthouse.' },
  { insult: "I'd surrender to a lighthouse keeper — but even HE knows how to aim his light!", comeback: 'Funny, aiming is exactly what your insults keep missing.' },
];
export const DUEL = {
  who: 'finch', at: 'lighthouse', win: 3,   // land 3 correct comebacks
  intro: 'Finch levels his rapier and, in a voice for the back row: "You DARE approach the switch?! ...ahem. Sorry. Habit. En garde, I suppose."',
  victory: 'Finch lowers his blade, genuinely moved. "A duel of REAL wit. Take the switch, you magnificent — sorry, that was theatrical again — take the switch."',
};

/** Running gag + fourth-wall break lines, sprinkled by the engine. */
export const GAGS = {
  reginald: 'A polite skeleton named Reginald walks through the wall. "Terribly sorry — any word on the time?" He clips through a table and is gone.',
  fourthWall: "You squint at a distant, low-resolution crate. Someone off-screen mutters: “Don’t stare at the pixel bleed, kid. The developers are still drinking coffee.”",
};
