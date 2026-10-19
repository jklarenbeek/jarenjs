//@ts-check
/**
 * The OS's post office: every conversation between the people at the
 * keyboard and the language models (or their scripted stand-ins) lands
 * here as a thread — the council's sessions, the crew's work on each
 * idea, questions asked of the documentation, the coach's tips, what the
 * games' characters said. Pure functions over one plain JSON slice, so
 * the Mail app, the contract and the autosave all read the same thing.
 */

/**
 * @typedef {{ name: string, ok: boolean, chars?: number, chunks?: number }} ToolNote
 * @typedef {{ id: string, from: string, to: string[], text: string, at: number, tool?: ToolNote }} Message
 * @typedef {{ id: string, subject: string, folder: string, people: string[], updated: number, unread: number, messages: Message[] }} Thread
 * @typedef {{ threads: Thread[], seq: number }} Mail
 */

/** Where threads are filed, in the order the Mail app lists them. */
export const FOLDERS = Object.freeze(['inbox', 'council', 'crew', 'library', 'coach', 'arcade']);

/** How much the post office keeps: newest threads, newest messages per thread. */
export const MAIL_LIMITS = Object.freeze({ threads: 60, messages: 40, text: 2000 });

/** An empty post office. @returns {Mail} */
export function emptyMail() {
  return { threads: [], seq: 0 };
}

/**
 * Post a message: into `thread` when it exists, else into a new thread
 * filed under `folder` with `subject`. The thread moves to the top; a
 * message not from the human counts as unread.
 * @param {Mail} mail
 * @param {{ thread?: string | null, subject?: string, folder?: string, from: string, to?: string[], text: string, at: number, tool?: ToolNote }} post
 * @returns {{ mail: Mail, thread: string, message: string }}
 */
export function postMail(mail, post) {
  const seq = mail.seq + 1;
  const existing = post.thread ? mail.threads.find((t) => t.id === post.thread) : undefined;
  const id = existing?.id ?? post.thread ?? `t${seq}`;
  /** @type {Message} */
  const message = { id: `m${seq}`, from: post.from, to: post.to ?? [], text: post.text.slice(0, MAIL_LIMITS.text), at: post.at };
  if (post.tool) message.tool = post.tool;
  const people = [...new Set([...(existing?.people ?? []), post.from, ...(post.to ?? [])])];
  /** @type {Thread} */
  const thread = {
    id,
    subject: existing?.subject ?? (post.subject ?? post.text).slice(0, 80),
    folder: existing?.folder ?? (FOLDERS.includes(post.folder ?? '') ? /** @type {string} */ (post.folder) : 'inbox'),
    people,
    updated: post.at,
    unread: (existing?.unread ?? 0) + (post.from === 'human' ? 0 : 1),
    messages: [...(existing?.messages ?? []), message].slice(-MAIL_LIMITS.messages),
  };
  const rest = mail.threads.filter((t) => t.id !== id);
  return { mail: { threads: [thread, ...rest].slice(0, MAIL_LIMITS.threads), seq }, thread: id, message: message.id };
}

/**
 * Mark a thread read.
 * @param {Mail} mail @param {string} id @returns {Mail}
 */
export function readThread(mail, id) {
  return { ...mail, threads: mail.threads.map((t) => (t.id === id && t.unread > 0 ? { ...t, unread: 0 } : t)) };
}

/**
 * The threads of a folder (or all of them), as the list shows them.
 * @param {Mail} mail @param {string | null} [folder]
 * @returns {Array<{ id: string, subject: string, folder: string, people: string[], updated: number, unread: number, count: number, last: string }>}
 */
export function threadSummaries(mail, folder = null) {
  return mail.threads
    .filter((t) => !folder || folder === 'all' || t.folder === folder)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      return {
        id: t.id, subject: t.subject, folder: t.folder, people: t.people, updated: t.updated, unread: t.unread,
        count: t.messages.length, last: last ? `${last.from}: ${last.text}`.slice(0, 120) : '',
      };
    });
}

/** Unread messages, all threads together. @param {Mail} mail */
export function unreadCount(mail) {
  return mail.threads.reduce((n, t) => n + t.unread, 0);
}

/**
 * Whether a value is a post office this OS can restore.
 * @param {any} value @returns {value is Mail}
 */
export function isMail(value) {
  return Boolean(value) && Number.isInteger(value.seq) && value.seq >= 0 && Array.isArray(value.threads)
    && value.threads.length <= MAIL_LIMITS.threads
    && value.threads.every((/** @type {any} */ t) => t && typeof t.id === 'string' && typeof t.subject === 'string'
      && typeof t.folder === 'string' && Array.isArray(t.people) && Number.isFinite(t.updated) && Number.isInteger(t.unread)
      && Array.isArray(t.messages) && t.messages.every((/** @type {any} */ m) => m && typeof m.id === 'string'
        && typeof m.from === 'string' && typeof m.text === 'string' && Number.isFinite(m.at) && Array.isArray(m.to)));
}
