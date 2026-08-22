/**
 * Grouping, so a project reads as one thing.
 *
 * Twelve sessions is where a flat list stops working. You do not think "session
 * 7, session 9 and session 11" — you think "the importer work", which is three
 * sessions across two branches that happen to have been started separately.
 *
 * Two decisions shape this:
 *
 * **Most grouping should require no configuration.** A tool that only groups
 * what you remembered to label groups nothing, because the moment you need
 * grouping is the moment you have too many sessions to have been labelling
 * them. So the repo and branch a session is already working in become tags on
 * their own, and manual tags are additive rather than the whole mechanism.
 *
 * **Derived tags are never stored.** They are recomputed from each snapshot,
 * so a session that moves branch re-tags itself and a stale `repo:old-name`
 * cannot outlive the fact it described. Only what a person typed is persisted,
 * because only that cannot be recovered.
 */

import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic.js';

/** Manual tags: short, lowercase, no spaces — they are addresses, not prose. */
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const MAX_TAGS_PER_SESSION = 12;

/**
 * The most sessions one group action may touch.
 *
 * Lives here rather than in the server because it is a fact about selection,
 * not about HTTP — and because the MCP face needs it too, which would
 * otherwise mean mcp.js importing from server.js while server.js imports
 * mcp.js. That cycle happens to resolve today; it should not have to.
 */
export const BULK_LIMIT = 25;

export function normalizeTag(raw) {
  const tag = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');

  // Checked before the shape, not after. The pattern already refuses a colon,
  // so a reserved prefix would otherwise be reported as "not a usable tag" —
  // technically true, and useless for the single most likely mistake, which is
  // typing the derived tag you can see on the card.
  if (/^(repo|branch|lane|env|model):/.test(tag)) {
    throw new Error(`"${tag}" uses a reserved prefix — repo:, branch:, lane:, env: and model: are derived automatically, so a manual tag cannot shadow one`);
  }
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`"${raw}" is not a usable tag — use letters, digits, dot, dash or underscore, up to 32 characters`);
  }
  return tag;
}

/**
 * Tags a session already earns by existing.
 *
 * These are what make grouping work on a fleet nobody has labelled.
 */
export function derivedTags(session) {
  const tags = [];
  // Sessions already carry tags from the platform — `remote-control-auto` and
  // whatever else was set when they were created. Grouping by those without
  // being asked is the same argument as grouping by repo: the label already
  // exists, so making you retype it would be the tool's failure, not yours.
  for (const tag of session.tags ?? []) {
    const clean = slug(tag);
    if (clean && clean !== 'unknown') tags.push(clean);
  }
  if (session.repo) tags.push(`repo:${slug(session.repo)}`);
  if (session.branch) tags.push(`branch:${slug(session.branch)}`);
  if (session.lane) tags.push(`lane:${session.lane}`);
  if (session.envKind) tags.push(`env:${session.envKind}`);
  if (session.modelId) tags.push(`model:${slug(session.modelId.replace(/^claude-/, ''))}`);
  return tags;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export class TagStore {
  #path;
  #manual = new Map(); // sessionId -> string[]

  constructor({ path = null } = {}) {
    this.#path = path;
  }

  static async open(options) {
    const store = new TagStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#manual = new Map(Object.entries(raw).map(([id, tags]) => [id, [...new Set(tags)]]));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async #persist() {
    if (!this.#path) return;
    await writeAtomic(this.#path, JSON.stringify(Object.fromEntries(this.#manual), null, 2));
  }

  manualFor(sessionId) {
    return [...(this.#manual.get(sessionId) ?? [])];
  }

  /** @returns {{tags: string[], added: string[], removed: string[]}} */
  async update(sessionId, { add = [], remove = [] } = {}) {
    const current = new Set(this.#manual.get(sessionId) ?? []);
    const added = [];
    const removed = [];

    for (const raw of add) {
      const tag = normalizeTag(raw);
      if (current.has(tag)) continue;
      if (current.size >= MAX_TAGS_PER_SESSION) {
        throw new Error(`a session can carry at most ${MAX_TAGS_PER_SESSION} tags`);
      }
      current.add(tag);
      added.push(tag);
    }
    for (const raw of remove) {
      // Removal does not validate: a tag that got in before the rules
      // tightened still has to be removable.
      const tag = String(raw ?? '').trim().toLowerCase();
      if (current.delete(tag)) removed.push(tag);
    }

    if (current.size) this.#manual.set(sessionId, [...current]);
    else this.#manual.delete(sessionId);

    if (added.length || removed.length) await this.#persist();
    return { tags: [...current], added, removed };
  }

  /** Drop tags for sessions that no longer exist, so the file stays bounded. */
  async reconcile(fleet) {
    const live = new Set((fleet?.sessions ?? []).map((s) => s.id));
    let changed = false;
    for (const id of [...this.#manual.keys()]) {
      if (!live.has(id)) {
        this.#manual.delete(id);
        changed = true;
      }
    }
    if (changed) await this.#persist();
    return changed;
  }

  /** Every tag on a session: derived first, then what a person added. */
  tagsFor(session) {
    // Deduplicated: a manual tag that happens to match a platform one means
    // the same thing, and showing it twice would be noise.
    return [...new Set([...derivedTags(session), ...this.manualFor(session.id)])];
  }

  /** Annotate a normalised fleet. Returns the same object when there is nothing to add. */
  decorate(fleet) {
    if (!fleet?.sessions) return fleet;
    return {
      ...fleet,
      sessions: fleet.sessions.map((s) => ({ ...s, tags: this.tagsFor(s) })),
    };
  }

  /** Every tag in use, with how many sessions carry it, most-used first. */
  index(fleet) {
    const counts = new Map();
    for (const session of fleet?.sessions ?? []) {
      if (session.status === 'archived') continue;
      for (const tag of this.tagsFor(session)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count, derived: tag.includes(':') }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

/**
 * Which sessions a bulk action would touch.
 *
 * Exported and pure so the clients can show the exact list before anything
 * happens. A bulk action you cannot preview is one people are right to be
 * afraid of, and one they will therefore not use.
 */
export function selectSessions(fleet, tags, { tag = null, lane = null, ids = null, includeUnreachable = false } = {}) {
  let sessions = (fleet?.sessions ?? []).filter((s) => s.status !== 'archived');

  if (ids?.length) {
    const wanted = new Set(ids);
    sessions = sessions.filter((s) => wanted.has(s.id));
  }
  if (tag) {
    sessions = sessions.filter((s) => tags.tagsFor(s).includes(tag));
  }
  if (lane) {
    sessions = sessions.filter((s) => s.lane === lane);
  }
  // An unreachable session's command is held, not lost — but in a bulk action
  // that is usually not what was meant, so it is opt-in and always reported.
  const unreachable = sessions.filter((s) => !s.reachable);
  if (!includeUnreachable) sessions = sessions.filter((s) => s.reachable);

  return { sessions, skippedUnreachable: unreachable.map((s) => ({ id: s.id, title: s.title })) };
}
