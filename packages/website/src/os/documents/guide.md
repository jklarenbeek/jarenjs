# Radiant OS field guide

Radiant OS is a studio where you and a crew make small apps together, turn by turn, like a board game. You are the employer: you bring the ideas and you decide what ships. The crew does the building. Every part of the studio is a Jaren document you can read, and every move anyone makes goes through one contract, so a language model plays by the same rules as you do.

## You are the employer

Open the Crew app and start a project. Name the people at this screen, up to four, separated by commas: you take turns at one keyboard, each with your own colour. Name the project and set the goal, the number of approved blocks it needs to ship.

A round has three parts. First the employers add ideas, two each per turn. Then the crew builds. Then the employers review what was built. Nothing ships that a human has not approved, and a veto is always yours.

## Ideas

An idea is one sentence about something the app should have: a title, a counter, a checklist, a question with an answer, a colour palette, a switch, a note or a text field. Write it plainly, for example "a counter for the cups of tea we drank" or "a quiz about the capital of France". The crew reads the words and picks the block that fits.

When you have added your ideas, press End my turn and the next employer goes. After the last one, the crew starts building.

## The crew builds

The crew is the same four figures that dance on the floor: the Architect, the Dancer, the Painter and the Critic. Each one takes an open idea, says what they will do, and builds one block through the contract operation crew.build. You can watch each builder hop for joy on the stage, and read what they said in Mail.

In the Tangle edition a language model plays the crew. It sees only the public operations of the contract, a few at a time, so even a small model can follow along.

## Your review

Every block the crew built comes back to you, and the app beside the review already has it in, so you can try it before you decide. Approve it and it stays in the app. Veto it and the crew tries that idea again next round; an idea vetoed twice is dropped. The app is live: press the buttons, tick the boxes, answer the quiz. Every app you ship is kept under Made.

## Shipping, stars and your rank

When the approved blocks reach the goal, the project ships. Finish in two rounds for three stars, in three rounds for two stars, later for one. Shipping, approving and playing all earn experience, and experience moves you up the ranks: Chalk, Sketch, Tag, Spray, Mural, Subway legend and, at the very top, Radiant.

## The board

The Board is a wall of cards for notes and to-dos. Add a card, drag it anywhere, edit its words, and tick it off when it is done. Drag from the small port on a card's edge to another card to draw a link: an arrow means "this one first". The board never lets links run in a circle, and a card that waits on an open card shows it is blocked. Cards push each other aside instead of piling up.

## Mail

Mail is where every conversation lands: between you and the crew, between the council members, between you and the docs, and what the players in the arcade say. Each thread is a letter you can open and answer. Write to the Oracle and it answers from the documentation.

## The library

The Library holds every package's documentation, cut into sections you can read, listen to and talk with. Search it with a few words. Open a document to read it a page at a time. Press Listen and the studio reads the page aloud, lighting each sentence as it goes. Ask a question and the library answers with the passages that fit, and says where each one came from.

## The arcade

The arcade has three games. Each game has a title card, pause, continue, stop and options, like any game. Escape or P pauses, and pausing also holds the council's clock, so nothing moves on without you.

Monkey Grove is an island of number puzzles. Walk the monkey with the arrow keys or a tap, and walk into a portal to one of four worlds: Tide Pools, Banana Garden, Sharing Stump and Vine Heights. Each visit asks three problems chosen for you: fetch the right stone and offer it at the altar, plant a bed of rows and columns, ring the bell where a fraction lives on the vine, or deal coconuts fairly into baskets. A wrong answer is gentle: Mimi explains that exact mistake, shows the picture and lets you try again. Every answer moves you on a ladder of twenty-one skills that aims the next problem where you win about two times in three, and the island blooms from gray to colour as you master it. Two players can play the Banana Duel, taking turns problem by problem.

Tape Dancers is a puzzle about Turing machines. A dancer stands on a strip of tape. You fill in its rule table: for each state and each ink under its feet, which ink to stamp, which way to step and which state comes next, or halt. Press Run and it dances your rules on the beat, tape after tape, until the tape shows what the level asks for. One star for solving every tape, two for using no more states than par, three for no more steps as well. The last levels are the busy beavers.

Bench Arena is benchmarking as a race. In the engine race, six real workloads of this OS run on their Jaren engines while you watch, each lane a runner whose finish line is its engine's par. In the tool-call race, each lane is a tool budget delivering the same document to a language model through calls that fail more often the longer they are; the winner is the budget to use, and Apply makes it your setting. The reflex race measures you: act the moment the sign pops up, five times.

## The director

The camera is part of the studio, not an afterthought. Pick a shot in Settings, or let the director cut on its own: it cranes up when the council convenes, moves in for a verdict and comes home afterwards. Drag the floor to look around, scroll or pinch to zoom. Leave it alone for a while and the camera drifts slowly around the stage.

## The light

The light follows the time of day. Set the hour in Settings and watch the shadows swing as the sun moves, from long morning shadows to the pools of the night spots. Each art direction has its own light: Pop Shop is bright paper, Subway Chalk is chalk on black and Neon Night glows.

## Settings

Settings has everything a game has. The art direction, the sound mix for music and effects, captions for what is said, reduced motion, the camera shot, the hour of the light and the ragdoll liveliness of the figures. It also holds the tool budget a language model gets, which the Tangle edition uses when a model plays the crew.

The tool budget decides how many tools a model sees at once and how large one call may be. Auto picks it from the model's name. Tiny and small suit a small mixture-of-experts model; medium and large suit a dense model; unlimited sends everything at once.

## The coach

The coach walks you through the studio in short quests: dance the first steps, meet the council, pin a note, start a crew, read a letter, listen to the library, play a game, move the camera and ship your first app. The coach lights up where to look next. Turn it off in Settings whenever you like.

## Language models

When your browser offers WebMCP, the studio registers its public contract operations as tools, so an agent in your browser can read the board, post a letter, search the library or play along with the crew. Operations that only a human may take, such as the veto, the review and starting a project, are never offered as tools.

## Keyboard

Escape or P pauses and continues, and M mutes or unmutes. In a game the arrow keys or W, A, S and D move, Space or Enter acts and E asks for a hint. Everywhere else Tab moves between controls and Enter presses them.
