/**
 * Strategy D — reading the laptop instead of the network.
 *
 * Every fixture here is invented. The real transcripts this parses contain
 * whole conversations, and this repository is public; nothing that has touched
 * a real session may end up in it. That constraint is also a useful test
 * discipline, because it forces the parser to be exercised through its
 * contract rather than through one machine's happy accident.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAdapter, isCloudAddressable, needsActionFrom, projectSlug, readTranscript, remoteUrl, tailLines, toRawRecord, trailingQuestion } from '../src/adapters/local.js';
import { normalizeFleet } from '../src/model.js';

const entry = (over = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-22T10:00:00.000Z',
  cwd: '/home/dev/importer',
  gitBranch: 'main',
  version: '2.1.240',
  message: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  ...over,
});

// ---------------------------------------------------------------- slug

test('a project directory is named the way the CLI names it', () => {
  assert.equal(projectSlug('/home/dev/importer'), '-home-dev-importer');
  assert.equal(projectSlug('/Users/a/My Repo'), '-Users-a-My-Repo');
  assert.equal(projectSlug(''), '');
});

// ---------------------------------------------------------------- tail

test('only the tail of a transcript is read', async () => {
  // These files reach many megabytes and are read on every poll. Reading them
  // whole would make the poll cost grow with the length of the conversation.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const path = join(dir, 'big.jsonl');
    const lines = Array.from({ length: 5000 }, (_, i) => entry({ timestamp: `2026-08-22T10:00:${String(i % 60).padStart(2, '0')}.000Z` }));
    await writeFile(path, `${lines.join('\n')}\n`);

    const tail = await tailLines(path, 4096);
    assert.ok(tail.length > 0);
    assert.ok(tail.length < 100, 'read a window, not the file');
    for (const line of tail) assert.doesNotThrow(() => JSON.parse(line), 'every returned line parses');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a partial first line is dropped rather than guessed at', async () => {
  // A tail read almost always starts mid-line. Half a JSON object is not a
  // record, and parsing it optimistically would put garbage on the board.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const path = join(dir, 'x.jsonl');
    await writeFile(path, `${entry()}\n${entry()}\n`);
    const tail = await tailLines(path, 40); // lands inside a line
    for (const line of tail) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a small file is read whole, with nothing dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const path = join(dir, 'x.jsonl');
    await writeFile(path, `${entry()}\n`);
    assert.equal((await tailLines(path, 1 << 20)).length, 1, 'the only line survived');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- parse

test('a transcript yields the facts the board needs', () => {
  const t = readTranscript([entry()]);
  assert.equal(t.branch, 'main');
  assert.equal(t.model, 'claude-opus-5');
  assert.equal(t.cwd, '/home/dev/importer');
  assert.equal(t.lastSpeaker, 'assistant');
  assert.equal(t.stopReason, 'end_turn');
  assert.equal(t.text, 'Done.');
});

test('the last assistant TEXT is kept, not merely the last assistant entry', () => {
  // The final entry is very often a bare tool call with no prose. Taking only
  // that leaves the status line empty for any session caught mid-work, which
  // is most of the ones you are actually looking at.
  const t = readTranscript([
    entry({ message: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Running the tests.' }] } }),
    entry({ message: { model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } }),
  ]);
  assert.equal(t.text, 'Running the tests.');
  assert.equal(t.stopReason, 'tool_use', 'but the state still comes from the last entry');
});

test('a malformed line does not lose the whole transcript', () => {
  const t = readTranscript(['{not json', entry(), '']);
  assert.ok(t);
  assert.equal(t.model, 'claude-opus-5');
});

test('a transcript with nothing conversational in it yields nothing', () => {
  assert.equal(readTranscript([JSON.stringify({ type: 'system' }), JSON.stringify({ type: 'mode' })]), null);
  assert.equal(readTranscript([]), null);
});

test('token usage comes from the CLI\'s own accounting', () => {
  const t = readTranscript([entry({
    message: {
      model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 20 },
    },
  })]);
  assert.equal(t.tokens, 1035);
});

test('absent usage is null, never zero', () => {
  // Zero would render as a context meter reading empty, which is a claim.
  assert.equal(readTranscript([entry()]).tokens, null);
});

// ---------------------------------------------------------------- shape

test('a local session becomes the same raw shape the API returns', () => {
  const raw = toRawRecord(
    { sessionId: 'abc', cwd: '/home/dev/importer', name: 'importer', pid: 42, kind: 'interactive', startedAt: 1000 },
    readTranscript([entry()]),
  );
  const fleet = normalizeFleet([raw]);
  const s = fleet.sessions[0];

  assert.equal(s.id, 'abc');
  assert.equal(s.title, 'importer');
  assert.equal(s.branch, 'main');
  assert.equal(s.modelId, 'claude-opus-5');
  assert.equal(s.envKind, 'bridge', 'a process on this machine is exactly what bridge means');
  // Alive, visible, and still not reachable — because `--cloud` takes a cloud
  // session id and a purely local session does not have one. Verified against
  // the CLI, which refuses with "Cloud sessions are interactive only".
  assert.equal(s.reachable, false);
  assert.match(s.reachableReason, /cloud session id/);
  assert.match(s.reachableReason, /remote-control/i, 'and says how to fix it');
});

test('a session that also exists on the cloud side IS reachable', () => {
  // Remote Control gives a local session a cloud id, which is precisely what
  // makes it addressable. This is the difference between a dashboard and a
  // control plane, so it is asserted directly.
  const raw = toRawRecord({ sessionId: 'session_01ABC', name: 'importer' }, readTranscript([entry()]));
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.reachable, true);
  assert.equal(s.reachableReason, null);
});

test('id shape is what decides addressability', () => {
  assert.equal(isCloudAddressable('session_01ABC'), true);
  assert.equal(isCloudAddressable('cse_abc'), true);
  assert.equal(isCloudAddressable('5aa3a0a7-9998-55a9-baad-e615a48d7dc5'), false);
  assert.equal(isCloudAddressable(''), false);
  assert.equal(isCloudAddressable(null), false);
});

test('a finished turn is review-ready, never blocked', () => {
  // Locally there is no signal separating "it asked you a question" from "it
  // finished". Calling every finished turn blocked would fire a notification
  // for each one and make the alert that matters worthless.
  const raw = toRawRecord({ sessionId: 'a', name: 'x' }, readTranscript([entry()]));
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.lane, 'ready');
  assert.equal(s.actionable, false, 'and so it must never raise a push');
});

test('a session mid-tool-call reads as working', () => {
  const raw = toRawRecord({ sessionId: 'a', name: 'x' }, readTranscript([
    entry({ message: { model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }),
  ]));
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.lane, 'working');
  assert.equal(s.status, 'running');
});

test('a session whose last word was yours reads as working too', () => {
  const raw = toRawRecord({ sessionId: 'a', name: 'x' }, readTranscript([
    entry({ type: 'user', message: { content: 'do the thing' } }),
  ]));
  assert.equal(normalizeFleet([raw]).sessions[0].lane, 'working');
});

test('a session with no transcript is still shown', () => {
  // The process is real. A thinner record beats pretending it is not there.
  const raw = toRawRecord({ sessionId: 'a', cwd: '/home/dev/thing', pid: 9, startedAt: 5000 }, null);
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.id, 'a');
  assert.equal(s.title, 'thing', 'named from its directory when nothing else names it');
});

test('nothing unknowable is invented', () => {
  const raw = toRawRecord({ sessionId: 'a', name: 'x' }, null);
  // These simply are not knowable from the laptop, and a plausible guess would
  // be worse than a gap because nothing downstream could tell the difference.
  assert.equal(raw.post_turn_summary.needs_action, '');
  assert.equal(raw.session_context.model, null);
  assert.equal(raw.rate_limit_info, undefined);
});

// ---------------------------------------------------------------- adapter

function fakeExec(agents, { throws = null } = {}) {
  return async () => {
    if (throws) throw throws;
    return { stdout: JSON.stringify(agents), stderr: '' };
  };
}

test('the adapter joins the process list to the transcripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const cwd = '/home/dev/importer';
    const projects = join(dir, 'projects');
    await mkdir(join(projects, projectSlug(cwd)), { recursive: true });
    await writeFile(join(projects, projectSlug(cwd), 'sess-1.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({
      exec: fakeExec([{ sessionId: 'sess-1', cwd, name: 'importer', pid: 1, kind: 'interactive', startedAt: 1 }]),
      projectsDir: projects,
    });

    const s = normalizeFleet(await adapter.list()).sessions[0];
    assert.equal(s.title, 'importer');
    assert.equal(s.branch, 'main', 'enriched from the transcript');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session whose directory moved is still found by id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-somewhere-else'), { recursive: true });
    await writeFile(join(projects, '-somewhere-else', 'sess-1.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({
      exec: fakeExec([{ sessionId: 'sess-1', cwd: '/home/dev/moved', name: 'moved', pid: 1, startedAt: 1 }]),
      projectsDir: projects,
    });
    assert.equal(normalizeFleet(await adapter.list()).sessions[0].branch, 'main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing CLI is reported as such, not as an empty fleet', async () => {
  // An empty board and a broken reader look identical to a person, so they
  // must not look identical to the code.
  const adapter = new LocalAdapter({
    exec: fakeExec(null, { throws: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }),
  });
  const probe = await adapter.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /not on PATH/);
});

test('an agent entry with no session id is skipped, not crashed on', async () => {
  const adapter = new LocalAdapter({ exec: fakeExec([{ pid: 1 }, { sessionId: 'a', name: 'ok' }]), projectsDir: '/nope' });
  const records = await adapter.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'a');
});

test('the adapter says out loud that it only sees this machine', () => {
  // A cloud session started from a phone is invisible here. That is the honest
  // limit of this strategy and callers have to be able to know it.
  assert.equal(new LocalAdapter({}).capabilities.scope, 'local');
  assert.equal(new LocalAdapter({}).capabilities.write, false);
});

// ---------------------------------------------------------------- repo

test('the repository is the remote, so a group means the same thing everywhere', async () => {
  // `repo:/home/dev/importer` groups nothing — it is one machine's path. The
  // remote is what two people, or one person on two machines, would share.
  const config = `
[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/acme/importer.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;
  const read = async (path) => {
    if (path === '/home/dev/importer/.git/config') return config;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(await remoteUrl('/home/dev/importer', { read }), 'https://github.com/acme/importer.git');
});

test('a session started in a subdirectory still finds its repository', async () => {
  const read = async (path) => {
    if (path === '/home/dev/importer/.git/config') return '[remote "origin"]\n\turl = git@github.com:acme/importer.git\n';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(await remoteUrl('/home/dev/importer/src/deep/nested', { read }), 'git@github.com:acme/importer.git');
});

test('a repository with no origin, and no repository at all, both give null', async () => {
  const noOrigin = async () => '[core]\n\tbare = false\n';
  assert.equal(await remoteUrl('/home/dev/thing', { read: noOrigin }), null);

  const nothing = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(await remoteUrl('/home/dev/thing', { read: nothing }), null);
  assert.equal(await remoteUrl(null, { read: nothing }), null);
});

test('the walk upwards is bounded', async () => {
  // A path with no repository anywhere above it must not walk to the root one
  // stat at a time on every poll.
  let reads = 0;
  const read = async () => { reads += 1; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  await remoteUrl('/a/b/c/d/e/f/g/h/i/j/k/l/m/n', { read });
  assert.ok(reads <= 8, `walked ${reads} levels`);
});

test('a remote reaches the board as owner/name', () => {
  const raw = toRawRecord(
    { sessionId: 'a', name: 'importer', cwd: '/home/dev/importer' },
    readTranscript([entry()]),
    { remote: 'https://github.com/acme/importer.git' },
  );
  assert.equal(normalizeFleet([raw]).sessions[0].repo, 'acme/importer');
});

test('no remote leaves repo empty rather than showing a local path', () => {
  const raw = toRawRecord({ sessionId: 'a', name: 'x', cwd: '/home/dev/scratch' }, null, { remote: null });
  assert.equal(normalizeFleet([raw]).sessions[0].repo, null);
});

// ---------------------------------------------------------------- not running

test('a session whose process has exited is still on the board', async () => {
  // `claude agents --json` only lists running processes, so a session you
  // closed the terminal on is invisible to it — and that is exactly the
  // session this product exists to surface, the one that sat for eleven days.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-importer'), { recursive: true });
    await writeFile(join(projects, '-home-dev-importer', 'gone.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    const s = normalizeFleet(await adapter.list()).sessions[0];

    assert.equal(s.id, 'gone');
    assert.equal(s.reachable, false, 'nothing can be delivered to it right now');
    assert.equal(s.connection, 'disconnected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dead session mid-tool-call reads as interrupted, not working', async () => {
  // Only a live process can be mid-turn. Showing it as "working" would be a
  // claim that something is happening when nothing is.
  const raw = toRawRecord(
    { sessionId: 'a', name: 'x' },
    readTranscript([entry({ message: { model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } })]),
    { live: false },
  );
  const s = normalizeFleet([raw]).sessions[0];
  assert.notEqual(s.lane, 'working');
  assert.equal(s.status, 'idle');
});

test('one session in two project directories is one session', async () => {
  // A session that changes working directory gets a transcript under each
  // slug. Without deduplication it appears twice, with two different and both
  // plausible states — and you cannot tell which is current.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-a'), { recursive: true });
    await mkdir(join(projects, '-home-dev-b'), { recursive: true });
    await writeFile(join(projects, '-home-dev-a', 'same.jsonl'), `${entry({ gitBranch: 'old' })}\n`);
    // Written second, so it is the newer file and should win.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projects, '-home-dev-b', 'same.jsonl'), `${entry({ gitBranch: 'current' })}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    const sessions = normalizeFleet(await adapter.list()).sessions;

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].branch, 'current', 'the newest transcript wins');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a running session is enriched, not duplicated, by its transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-importer'), { recursive: true });
    await writeFile(join(projects, '-home-dev-importer', 'live.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({
      exec: fakeExec([{ sessionId: 'live', cwd: '/home/dev/importer', name: 'importer', pid: 7 }]),
      projectsDir: projects,
    });
    const sessions = normalizeFleet(await adapter.list()).sessions;

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, 'importer', 'named by the process');
    assert.equal(sessions[0].branch, 'main', 'detailed by the transcript');
    // Local id, so watchable but not writable — see the addressability tests.
    assert.equal(sessions[0].reachable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('old transcripts are not read at all', async () => {
  // Bounded by mtime before any file is opened, because a laptop accumulates
  // hundreds and the poll cost must not grow with your history.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    await writeFile(join(projects, '-home-dev-x', 'ancient.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    // Ask as though it were a year from now.
    const records = await adapter.list({ now: Date.now() + 365 * 24 * 3600 * 1000 });
    assert.deepEqual(records, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no projects directory is an empty fleet, not a crash', async () => {
  const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: '/nonexistent-fleet-test' });
  assert.deepEqual(await adapter.list(), []);
});

// ---------------------------------------------------------------- needs you

const MIN = 60_000;
const ended = (text) => readTranscript([entry({
  message: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
})]);

test('a turn that ends on a question, left unanswered, needs you', () => {
  // The whole trailing line, not just the final sentence: on a lock screen
  // "I can use either endpoint. Which one should I point at?" is far more use
  // than the question alone, and it is what the session actually said last.
  assert.equal(
    needsActionFrom(ended('I can use either endpoint. Which one should I point at?'), { idleFor: 10 * MIN }),
    'I can use either endpoint. Which one should I point at?',
  );
});

test('but not until you have had a chance to answer it', () => {
  // Without the grace period every question raises an alert the instant it is
  // asked — while you are still reading it.
  assert.equal(needsActionFrom(ended('Which one?'), { idleFor: 5_000 }), null);
  assert.equal(needsActionFrom(ended('Which one?'), { idleFor: 10 * MIN }), 'Which one?');
});

test('a turn that is still running never needs you', () => {
  const midTurn = readTranscript([entry({
    message: { model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Shall I?' }] },
  })]);
  assert.equal(needsActionFrom(midTurn, { idleFor: 60 * MIN }), null);
});

test('a turn where you spoke last is your turn, not its', () => {
  const yours = readTranscript([entry({ type: 'user', message: { content: 'do it?' } })]);
  assert.equal(needsActionFrom(yours, { idleFor: 60 * MIN }), null);
});

test('a statement is not a question, however long it sits', () => {
  // This is the one that matters. `blocked` firing for every finished turn is
  // how the alert that mattered gets muted.
  for (const text of [
    'Done. All 42 tests pass.',
    'I have pushed the change.',
    'Should I have done that differently? I decided yes, and did.',
    'Here is the summary:\n- one\n- two',
  ]) {
    assert.equal(needsActionFrom(ended(text), { idleFor: 60 * MIN }), null, `"${text.slice(0, 40)}" is not a question`);
  }
});

test('a question inside code is not a question', () => {
  const text = 'Fixed it:\n```js\nconst ok = confirm("Really?");\n```';
  assert.equal(needsActionFrom(ended(text), { idleFor: 60 * MIN }), null);
});

test('markdown around the question does not hide it', () => {
  assert.equal(trailingQuestion('**Which environment should I use?**'), 'Which environment should I use?');
  assert.equal(trailingQuestion('- Should I keep going?'), 'Should I keep going?');
  assert.equal(trailingQuestion('Some notes.\n\nWhich one?\n\n'), 'Which one?');
});

test('only the trailing line counts', () => {
  // A question in the middle of an explanation is usually rhetorical or
  // answered further down; what is genuinely waiting is what was said last.
  assert.equal(trailingQuestion('Why did that fail? Because the port was busy. Fixed.'), null);
  assert.equal(trailingQuestion('Why did that fail?\nBecause the port was busy.'), null);
});

test('an empty or missing message is not a question', () => {
  assert.equal(trailingQuestion(''), null);
  assert.equal(trailingQuestion(null), null);
  assert.equal(needsActionFrom(null, { idleFor: 60 * MIN }), null);
});

test('a very long question is trimmed for a lock screen', () => {
  const long = `${'Should I '.repeat(60)}?`;
  const out = needsActionFrom(ended(long), { idleFor: 60 * MIN });
  assert.ok(out.length <= 180);
});

test('needing you makes the session blocked and actionable, end to end', () => {
  // `actionable` is what drives every notification, so the wiring from a
  // question in a transcript through to an alert is worth asserting whole.
  const raw = toRawRecord(
    { sessionId: 'a', name: 'importer' },
    ended('I need the staging endpoint. What should I use?'),
    { now: Date.parse('2026-08-22T10:30:00.000Z') },
  );
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.lane, 'blocked');
  assert.equal(s.actionable, true);
  assert.equal(s.summary.needsAction, 'I need the staging endpoint. What should I use?');
});

test('a finished turn with no question stays ready, never blocked', () => {
  const raw = toRawRecord(
    { sessionId: 'a', name: 'importer' },
    ended('All done, tests pass.'),
    { now: Date.parse('2026-08-22T10:30:00.000Z') },
  );
  const s = normalizeFleet([raw]).sessions[0];
  assert.equal(s.lane, 'ready');
  assert.equal(s.actionable, false, 'and so it can never raise a push');
});

// ---------------------------------------------------------------- poll cost

test('an unchanged transcript is not re-read on the next poll', async () => {
  // Measured before this cache: a laptop with 40 recent sessions read 5 MB per
  // poll — 15 MB a minute, forever — for files almost all identical to last
  // time. A transcript only ever grows, so an unchanged mtime is an unchanged
  // answer.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    const file = join(projects, '-home-dev-x', 'sess.jsonl');
    await writeFile(file, `${entry()}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    await adapter.list();
    await adapter.list();
    await adapter.list();

    const { cached, hits } = adapter.cacheStats;
    assert.equal(cached, 1);
    assert.equal(hits, 2, 'read once, reused twice');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transcript that changed IS re-read', async () => {
  // The cache must never be the reason the board is stale — that would be a
  // far worse bug than the reads it saves.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    const file = join(projects, '-home-dev-x', 'sess.jsonl');
    await writeFile(file, `${entry({ gitBranch: 'first' })}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    assert.equal(normalizeFleet(await adapter.list()).sessions[0].branch, 'first');

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, `${entry({ gitBranch: 'second' })}\n`);
    assert.equal(normalizeFleet(await adapter.list()).sessions[0].branch, 'second', 'the board followed the file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cache does not grow with sessions that have fallen out of the window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    await writeFile(join(projects, '-home-dev-x', 'sess.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    await adapter.list();
    assert.equal(adapter.cacheStats.cached, 1);

    // A year later, nothing is in the window any more.
    await adapter.list({ now: Date.now() + 365 * 24 * 3600 * 1000 });
    assert.equal(adapter.cacheStats.cached, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a send refused for the wrong reason is explained for the right one', async () => {
  // The CLI answers "--cloud cannot be combined with --print" for an id that
  // is not a cloud id. That reads as a flag problem and is an addressing one;
  // someone reading it goes looking for the wrong bug entirely.
  const { explainSendFailure } = await import('../src/adapters/cli.js');

  const explained = explainSendFailure(
    '--cloud cannot be combined with --print.\nCloud sessions are interactive only.',
    'abc-123',
  );
  assert.match(explained, /not a cloud session id/);
  assert.match(explained, /flags are correct/);
  assert.match(explained, /remote-control/i, 'and says what to do');

  // Everything else keeps the CLI's own wording, which is usually better.
  assert.equal(explainSendFailure('Session expired. Please run /login.', 'x'), 'Session expired. Please run /login.');
  assert.equal(explainSendFailure('', 'x'), '');
  assert.equal(explainSendFailure(null, 'x'), null);
});

test('the probe counts running and recovered separately, and says what is drivable', async () => {
  // The old wording read "4 sessions, 5 with transcript detail", which is
  // nonsense the moment a transcript outlives its process — the common case.
  // And it said nothing about the number that decides whether Fleet is a
  // control plane here: how many can actually be messaged.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-a'), { recursive: true });
    await writeFile(join(projects, '-home-dev-a', 'running.jsonl'), `${entry()}\n`);
    await writeFile(join(projects, '-home-dev-a', 'dead.jsonl'), `${entry()}\n`);
    await writeFile(join(projects, '-home-dev-a', 'session_01CLOUD.jsonl'), `${entry()}\n`);

    const adapter = new LocalAdapter({
      exec: fakeExec([{ sessionId: 'running', cwd: '/home/dev/a', name: 'r', pid: 1 }]),
      projectsDir: projects,
    });

    const { ok, detail } = await adapter.probe();
    assert.equal(ok, true);
    assert.match(detail, /3 session\(s\)/);
    assert.match(detail, /1 running, 2 from transcripts/);
    assert.match(detail, /1 can be messaged/, 'only the cloud-shaped id is drivable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- no silent caps

test('a session inside the window is never silently dropped', async () => {
  // The first version capped at 40 and sorted newest-first, which was exactly
  // backwards: measured on 300 transcripts, 76 were in the window, 36 were
  // dropped, and the dropped ones were the OLDEST — up to 13.9 days idle. That
  // is precisely the session this product exists to catch. A cap meant to
  // bound read cost had made the tool blind to its own use case.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });

    const now = Date.now();
    for (let i = 0; i < 60; i += 1) {
      const file = join(projects, '-home-dev-x', `s${String(i).padStart(3, '0')}.jsonl`);
      await writeFile(file, `${entry()}\n`);
      // Spread across the window: i=0 is newest, i=59 is nearly 13 days idle.
      const age = i * 5 * 3600 * 1000;
      await utimes(file, new Date(now - age), new Date(now - age));
    }

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    const records = await adapter.list();

    assert.equal(records.length, 60, 'every session in the window is on the board');
    assert.equal(adapter.truncated, 0);

    // And specifically the least-recently-touched one, which the old cap ate
    // first. Checked by id: `updated_at` comes from the transcript's own
    // timestamp — when the session actually last spoke — not from the file's
    // mtime, which is only used to decide the window and the read cache.
    assert.ok(records.some((r) => r.id === 's059'), 'the most neglected session survived');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('if the sanity cap ever bites, it says so rather than shortening the board quietly', async () => {
  // A board that is shorter than the truth, with nothing saying why, is worse
  // than a slow one.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    for (let i = 0; i < 260; i += 1) {
      await writeFile(join(projects, '-home-dev-x', `s${String(i).padStart(3, '0')}.jsonl`), `${entry()}\n`);
    }

    const adapter = new LocalAdapter({ exec: fakeExec([]), projectsDir: projects });
    await adapter.list();
    assert.ok(adapter.truncated > 0, 'the overflow is counted');

    const { detail } = await adapter.probe();
    assert.match(detail, /NOT shown/, 'and stated where someone will read it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a running session is shown however old its transcript is', async () => {
  // A process alive for weeks with an untouched transcript is a session
  // sitting at a prompt nobody answered. The window must not hide it.
  const dir = await mkdtemp(join(tmpdir(), 'fleet-local-'));
  try {
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-home-dev-x'), { recursive: true });
    const file = join(projects, '-home-dev-x', 'ancient.jsonl');
    await writeFile(file, `${entry()}\n`);
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await utimes(file, old, old);

    const adapter = new LocalAdapter({
      exec: fakeExec([{ sessionId: 'ancient', cwd: '/home/dev/x', name: 'Long forgotten', pid: 1 }]),
      projectsDir: projects,
    });
    const records = await adapter.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].title, 'Long forgotten');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
