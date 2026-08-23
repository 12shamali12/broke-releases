/**
 * Tags, groups, and acting on a group.
 *
 * Bulk is the most dangerous thing in this codebase: it is the one route where
 * a typo reaches every session at once. So most of what is tested here is what
 * it refuses to do — act on more than it said, act on something unreachable
 * without saying so, or report a partial failure as a success.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_TAGS_PER_SESSION, TagStore, derivedTags, normalizeTag, selectSessions } from '../src/tags.js';

const fleet = (sessions) => ({ sessions });
const session = (over = {}) => ({
  id: 's1', title: 'Importer rewrite', lane: 'blocked', status: 'idle', reachable: true,
  repo: 'acme/importer', branch: 'main', envKind: 'bridge', modelId: 'claude-opus-5', ...over,
});

// ---------------------------------------------------------------- derived

test('a session is grouped by what it is already doing, with no configuration', () => {
  // The moment you need grouping is the moment you have too many sessions to
  // have been labelling them, so grouping that requires labels groups nothing.
  const tags = derivedTags(session());
  assert.deepEqual(tags, [
    'repo:acme/importer', 'branch:main', 'lane:blocked', 'env:bridge', 'model:opus-5',
  ]);
});

test('derived tags survive awkward repo and branch names', () => {
  const tags = derivedTags(session({ repo: 'Acme Corp/Web App', branch: 'feature/JIRA-42 spike' }));
  assert.ok(tags.includes('repo:acme-corp/web-app'));
  assert.ok(tags.includes('branch:feature/jira-42-spike'));
});

test('a session with nothing to derive from still works', () => {
  assert.deepEqual(derivedTags({ id: 'x' }), []);
});

test('derived tags are never stored, so they cannot outlive the fact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tags-'));
  const path = join(dir, 'tags.json');
  try {
    const store = await TagStore.open({ path });
    await store.update('s1', { add: ['urgent'] });

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(onDisk, { s1: ['urgent'] });

    // A session that moves branch re-tags itself; a stale `branch:old` cannot
    // linger and quietly change what a bulk action matches.
    const moved = store.tagsFor(session({ branch: 'release' }));
    assert.ok(moved.includes('branch:release'));
    assert.ok(!moved.some((t) => t === 'branch:main'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- manual

test('a manual tag cannot shadow a derived one', () => {
  // Otherwise typing `repo:acme/importer` by hand would silently change which
  // sessions a bulk action touches.
  assert.throws(() => normalizeTag('repo:anything'), /reserved prefix/);
  assert.throws(() => normalizeTag('lane:blocked'), /reserved prefix/);
});

test('tags are addresses, not prose', () => {
  assert.equal(normalizeTag('  Importer Work '), 'importer-work');
  assert.equal(normalizeTag('v2.1_final-2'), 'v2.1_final-2');
  for (const bad of ['', '   ', '-leading', 'a'.repeat(33), 'has/slash', 'emoji🎉']) {
    assert.throws(() => normalizeTag(bad), Error, `${JSON.stringify(bad)} should be refused`);
  }
});

test('adding and removing is idempotent and reports what changed', async () => {
  const store = new TagStore({});
  assert.deepEqual((await store.update('s1', { add: ['a', 'b'] })).added, ['a', 'b']);
  assert.deepEqual((await store.update('s1', { add: ['a'] })).added, [], 'already there');
  assert.deepEqual((await store.update('s1', { remove: ['b'] })).removed, ['b']);
  assert.deepEqual((await store.update('s1', { remove: ['b'] })).removed, [], 'already gone');
  assert.deepEqual(store.manualFor('s1'), ['a']);
});

test('a tag that got in before the rules tightened can still be removed', async () => {
  // Removal must not validate, or a bad tag becomes permanent.
  const store = new TagStore({});
  await store.update('s1', { add: ['ok'] });
  await assert.doesNotReject(() => store.update('s1', { remove: ['REPO:legacy', ''] }));
});

test('there is a ceiling on tags per session', async () => {
  const store = new TagStore({});
  const many = Array.from({ length: MAX_TAGS_PER_SESSION }, (_, i) => `t${i}`);
  await store.update('s1', { add: many });
  await assert.rejects(() => store.update('s1', { add: ['one-too-many'] }), /at most/);
});

test('tags for sessions that no longer exist are dropped', async () => {
  // They would otherwise accumulate forever, and worse, could reattach
  // themselves to a recycled id.
  const store = new TagStore({});
  await store.update('gone', { add: ['old'] });
  await store.update('s1', { add: ['live'] });

  await store.reconcile(fleet([session()]));
  assert.deepEqual(store.manualFor('gone'), []);
  assert.deepEqual(store.manualFor('s1'), ['live']);
});

test('the index counts what is in use and marks what was derived', () => {
  const store = new TagStore({});
  const index = store.index(fleet([
    session({ id: 'a' }),
    session({ id: 'b', branch: 'release' }),
    session({ id: 'c', repo: 'acme/web', branch: 'main', status: 'archived' }),
  ]));

  const repo = index.find((t) => t.tag === 'repo:acme/importer');
  assert.equal(repo.count, 2);
  assert.equal(repo.derived, true);
  assert.ok(!index.some((t) => t.tag === 'repo:acme/web'), 'archived sessions are not a group');
});

test('decorate returns sessions carrying every tag', () => {
  const store = new TagStore({});
  const decorated = store.decorate(fleet([session()]));
  assert.ok(decorated.sessions[0].tags.includes('repo:acme/importer'));
});

// ---------------------------------------------------------------- selection

test('a selection can be previewed exactly, before anything happens', () => {
  // A bulk action whose blast radius you cannot see is one people are right to
  // be afraid of, and will therefore not use.
  const store = new TagStore({});
  const f = fleet([
    session({ id: 'a', lane: 'blocked' }),
    session({ id: 'b', lane: 'working' }),
    session({ id: 'c', repo: 'acme/web', lane: 'blocked' }),
  ]);

  const { sessions } = selectSessions(f, store, { tag: 'repo:acme/importer', lane: 'blocked' });
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
});

test('unreachable sessions are excluded and named, never silently included', () => {
  const store = new TagStore({});
  const f = fleet([
    session({ id: 'a' }),
    session({ id: 'b', title: 'Asleep', reachable: false }),
  ]);

  const out = selectSessions(f, store, {});
  assert.deepEqual(out.sessions.map((s) => s.id), ['a']);
  assert.deepEqual(out.skippedUnreachable, [{ id: 'b', title: 'Asleep', reason: 'unreachable' }]);

  const forced = selectSessions(f, store, { includeUnreachable: true });
  assert.equal(forced.sessions.length, 2);
  assert.deepEqual(forced.skippedUnreachable, [{ id: 'b', title: 'Asleep', reason: 'unreachable' }], 'still reported, even when included');
});

test('archived sessions are never selected', () => {
  const store = new TagStore({});
  const f = fleet([session({ id: 'a' }), session({ id: 'b', status: 'archived' })]);
  assert.deepEqual(selectSessions(f, store, {}).sessions.map((s) => s.id), ['a']);
});

test('an explicit id list is respected, and a bad id simply matches nothing', () => {
  const store = new TagStore({});
  const f = fleet([session({ id: 'a' }), session({ id: 'b' })]);
  assert.deepEqual(selectSessions(f, store, { ids: ['b', 'nope'] }).sessions.map((s) => s.id), ['b']);
});

test('a manual tag groups sessions the derived ones would not', async () => {
  const store = new TagStore({});
  await store.update('a', { add: ['importer-work'] });
  await store.update('c', { add: ['importer-work'] });

  const f = fleet([
    session({ id: 'a', repo: 'acme/importer' }),
    session({ id: 'b', repo: 'acme/importer' }),
    session({ id: 'c', repo: 'acme/web' }),
  ]);
  assert.deepEqual(
    selectSessions(f, store, { tag: 'importer-work' }).sessions.map((s) => s.id),
    ['a', 'c'],
    'grouping across repos is the case derived tags cannot serve',
  );
});

test('tags the platform already set are groups on their own', async () => {
  // Real session records carry tags — `remote-control-auto` and whatever was
  // set at creation. Making someone retype a label that already exists would
  // be the tool's failure, not theirs.
  const store = new TagStore({});
  const tags = store.tagsFor(session({ tags: ['remote-control-auto', 'Q3 Planning'] }));
  assert.ok(tags.includes('remote-control-auto'));
  assert.ok(tags.includes('q3-planning'), 'normalised the same way a typed one is');
});

test('a manual tag matching a platform one is not shown twice', async () => {
  const store = new TagStore({});
  await store.update('s1', { add: ['shared'] });
  const tags = store.tagsFor(session({ tags: ['shared'] }));
  assert.equal(tags.filter((t) => t === 'shared').length, 1);
});

test('a session with no platform tags is unaffected', () => {
  const store = new TagStore({});
  assert.ok(!store.tagsFor(session({ tags: undefined })).includes('unknown'));
  assert.ok(!store.tagsFor(session({ tags: ['   '] })).includes('unknown'), 'a blank tag is not a group');
});

test('a skipped session says which kind of unreachable it is', () => {
  // "Watch only" and "disconnected" call for opposite responses: one will
  // never receive this command, the other will when it wakes up. A preview
  // that calls both "unreachable, skipped" hides which of your sessions you
  // have actually lost from the group action you just previewed.
  const store = new TagStore({});
  const f = fleet([
    session({ id: 'a' }),
    session({ id: 'b', title: 'On this laptop', reachable: false, reachLabel: 'watch only' }),
    session({ id: 'c', title: 'Asleep', reachable: false, reachLabel: 'disconnected' }),
  ]);

  const { skippedUnreachable } = selectSessions(f, store, {});
  assert.deepEqual(skippedUnreachable, [
    { id: 'b', title: 'On this laptop', reason: 'watch only' },
    { id: 'c', title: 'Asleep', reason: 'disconnected' },
  ]);
});

test('a session with no label still reports something usable', () => {
  const store = new TagStore({});
  const f = fleet([session({ id: 'b', reachable: false, reachLabel: undefined })]);
  assert.equal(selectSessions(f, store, {}).skippedUnreachable[0].reason, 'unreachable');
});


test('twenty writers at once do not lose an update or corrupt the file', async () => {
  // Two browsers, a CLI and an agent over MCP can all write at the same
  // moment, and every store here is a whole-file rewrite. Run against a live
  // fleetd with sixty concurrent writes across notes, tags and snooze: no
  // corruption, no lost update, every state file still valid JSON. This is
  // the pin.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tags-race-'));
  const path = join(dir, 'tags.json');
  try {
    const store = await TagStore.open({ path });
    // One under the ceiling, so nothing is refused for a reason unrelated to
    // the race being tested.
    const wanted = Array.from({ length: MAX_TAGS_PER_SESSION - 1 }, (_, i) => `t${i}`);
    await Promise.all(wanted.map((tag) => store.update('s1', { add: [tag] })));

    assert.deepEqual(store.manualFor('s1').sort(), [...wanted].sort(), 'every writer got its tag in');

    // And what is on disk is what is in memory, not a half-written file.
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(onDisk.s1.sort(), [...wanted].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the ceiling holds under concurrency, and says so', async () => {
  // Twenty racing writers against a twelve-tag limit is the case where a
  // check-then-write would let extras through.
  const store = new TagStore({});
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => store.update('s1', { add: [`t${i}`] })),
  );
  assert.equal(store.manualFor('s1').length, MAX_TAGS_PER_SESSION, 'not one over');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 20 - MAX_TAGS_PER_SESSION);
  for (const r of refused) assert.match(r.reason.message, /at most/);
});
