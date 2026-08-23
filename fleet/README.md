# fleetd

One console for every Claude Code session: poll, diff, notify, control.

**Phases 02 and 03 of the [design spec](https://claude.ai/code/artifact/f2ea689f-ac2e-4021-8972-2904a8f8db6b)**:
the core, and the network face over it. It holds a correct model of the fleet,
detects the transitions worth telling you about, delivers commands without
losing them, and serves all of that over authenticated HTTP with a live stream.
Both clients are built against [these designs](https://claude.ai/code/artifact/79103714-1eb3-42d4-9157-00ba40f75fd3).

## Start here

Four commands, on the machine that runs your sessions:

```
node bin/fleet.mjs doctor       # can this machine run Fleet, and can it see anything?
node bin/fleetd.mjs             # start it — prints a pairing code
node bin/fleet.mjs pair 123456  # redeem that code, from another terminal
node bin/fleet.mjs              # the board
```

`doctor` needs no daemon and answers the question that decides whether any of
this is worth doing: how many sessions this machine can actually see. Every
other check can pass on a laptop where Fleet shows nothing, and an empty board
under a column of green ticks is the worst diagnostic there is.

For the phone, `fleet pair` with no code prints a fresh one and the LAN address
to open it at. Only an already-paired device can invite another: the first code
comes from the terminal you are sitting at, and every one after it from
something you have already decided to trust.

```
npm test                        # 582 tests, no network, no CLI, no credentials
npm run demo                    # watch the core run against fixtures
node bin/fleetd.mjs --fixture   # the daemon + the app, on fixtures
node bin/fleet.mjs reach        # how to open it from your phone
node bin/spike.mjs              # look for a read path beyond this machine
```

With the daemon running there are two clients, both served off disk by fleetd
with no build step, no framework and no dependency:

| | | |
|---|---|---|
| **phone** | `http://127.0.0.1:8787/` | a PWA — triage, six screens, offline cache, outbox |
| **cockpit** | `http://127.0.0.1:8787/cockpit` | desktop, keyboard-first — rail, transcript, controls |
| **CLI** | `node bin/fleet.mjs` | the desk, in ten seconds — board, send, stop, watch |

The tunnel that reaches the API reaches both.

## The API

Loopback only, deliberately — this API can message every session you have, so
the default must never be that anything on the café Wi-Fi can try.

Which means the phone app cannot reach it, and that is the first thing everyone
hits. `fleetd` says so at startup rather than leaving you to discover it, and
`fleet reach` answers it without restarting anything. Two ways in:

- **Same Wi-Fi**: `--host 0.0.0.0`, then the LAN address it prints. Anything on
  your network can then reach the API; pairing still gates it, but the door
  becomes visible. `fleetd` warns on every start while bound that way.
- **Anywhere**: a tunnel (Cloudflare Tunnel, Tailscale) in front of loopback.
  The bind stays private and the tunnel adds its own authentication. The only
  option that works off your network, and the only one to use on Wi-Fi you do
  not trust.

Fleet never offers an address that will not work: loopback, IPv6, link-local
and Docker or VM bridges are all filtered out, because offering `172.17.0.1` as
"try this from your phone" is worse than offering nothing — it looks like an
answer.

Revoking a device ends the streams it already holds and forgets the push
subscriptions it registered. Both outlive the token check that let them start:
a stream is authorised when it opens and not again, and a push subscription is
held by the push service, not by fleetd. Without closing them, a revoked phone
kept receiving the whole fleet for as long as its connection survived, and kept
putting session titles and the questions they were waiting on onto its lock
screen indefinitely. Revocation that waits for a network hiccup is not
revocation.

It also invalidates every outstanding notification action token — all of them,
not that device's, because a notification goes to every subscription and its
token is therefore not one device's to lose. The cost is that an alert already
on the laptop's lock screen stops acting until the app is opened again, which
is a small price for the case revoking exists to cover.

`/v1/health` and `/v1/pair` are open; everything else needs a device token.

```
GET    /v1/health                    liveness; detail only when authenticated
POST   /v1/pair                      {code} -> {token}, once per window
POST   /v1/devices/pair              a code for another device (authenticated)
GET    /v1/fleet                     board + counts + health (staleness)
GET    /v1/fleet/:id                 one session + its queued commands
POST   /v1/fleet/:id/send            {text}
POST   /v1/fleet/:id/model           {model}
POST   /v1/fleet/:id/effort          {effort}
POST   /v1/fleet/:id/compact         {focus?}
POST   /v1/fleet/:id/rename          {title}
POST   /v1/fleet/:id/snooze          {hours} -> mutes alerts, never the board
DELETE /v1/fleet/:id/snooze
POST   /v1/stream/authorize         bearer -> cookie scoped to /v1/stream
GET    /v1/stream                    SSE: snapshot, then live events
GET    /v1/events?since=<cursor>     replay, with a truncation flag
GET    /v1/search?q=
GET    /v1/commands                  the queue, with delivery state
POST   /v1/commands/:id/retry
DELETE /v1/commands/:id
GET    /v1/devices
DELETE /v1/devices/:id               revoke one phone, nothing else
POST   /mcp                          JSON-RPC 2.0 — the MCP face
GET    /v1/push/key                  the VAPID public key
POST   /v1/push/subscribe            {endpoint, keys}
DELETE /v1/push/subscribe            {endpoint}
POST   /v1/push/test                 a real notification, end to end
GET    /v1/fleet/:id/history?limit=  what happened, and what you did about it
POST   /v1/bulk/undo                 {commandIds} — recall what has not gone yet
GET    /v1/fleet/:id/note            your own context on a session
PUT    /v1/fleet/:id/note            {text} — verbatim, never truncated
GET    /v1/notes/orphans             notes whose session is gone
GET    /v1/tags                      every group, and how many are in it
GET    /v1/fleet/:id/tags            one session's groups
POST   /v1/fleet/:id/tags            {add, remove}
GET    /v1/bulk?tag=&lane=           exactly what a group action would touch
POST   /v1/bulk                      {tag|lane|ids, verb, payload}
POST   /v1/notify/action             {token, action} — the notification's buttons
GET    /v1/notify/settings           the rules, and what is escalating
PUT    /v1/notify/settings           change them
GET    /v1/metrics?windowMs=          is this actually helping?
GET    /v1/media                     what is playing on the laptop, or why not
POST   /v1/media/:verb               play-pause | next | previous | volume-up/down
```

## The MCP face

`POST /mcp` speaks JSON-RPC 2.0 with eighteen tools — everything the clients can
do: `fleet_list`, `fleet_get`, `fleet_send`, `fleet_stop`, `fleet_set_model`,
`fleet_set_effort`, `fleet_compact`, `fleet_rename`, `fleet_snooze`,
`fleet_search`, `fleet_groups`, `fleet_tag`, `fleet_bulk_preview`,
`fleet_bulk`, `fleet_metrics`, `fleet_media`, `fleet_note`, `fleet_history`.

This is the highest-leverage endpoint in the design. A published artifact page
cannot call fleetd — a strict CSP blocks it — but it *can* call the viewer's
claude.ai connectors. Registering fleetd as one closes that gap: any Claude
conversation can answer "what's stuck?" and act on it, with no phone in the loop.

It grants no extra reach: the same device token gates it, and every write goes
through the same durable queue, so ordering and the never-silent guarantee hold
identically whether a command came from a tap or a conversation.

Every write tool's description says **QUEUED** in as many words, and every write
result repeats it. A model that reports "I changed the model" when the command
is still in a queue is the exact failure this system exists to prevent.

`fleet_bulk` is the one tool whose most important safeguard is not in the code
but in its description: it names `fleet_bulk_preview`, says to confirm with the
person first, and says it cannot be undone. There is a test asserting the
description still says all three, because that text is load-bearing.

Writes return **202, not 200** — the command is queued, and the response says
whether the session is reachable. Reporting a queued command as done is exactly
how a message ends up silently never sent.

## SSE instead of WebSocket

The spec said WebSocket. This ships Server-Sent Events, deliberately:

- The traffic is one-directional. Every client→server action is already a REST
  POST, so the socket only ever pushed.
- Reconnection is built into `EventSource`, and it resumes with `Last-Event-ID`
  — the same cursor as `GET /v1/events?since=`. One replay path serves cold
  start, reconnect and catch-up.
- It is plain HTTP, so it crosses Cloudflare Tunnel and Access with no upgrade
  handshake to configure, and needs no dependency to serve.

`x-accel-buffering: no` is set because Cloudflare and nginx both buffer by
default, which would hold every event until the response closed.

## How Fleet reads your sessions

Strategy D, on this machine: `claude agents --json` for what is running, and
the CLI's own transcripts under `~/.claude/projects/` for what each session
last said. Both are things the CLI already writes down. Nothing is inferred
from a credential and nothing is sent anywhere.

The limit is the honest one: a session Fleet can read is not necessarily a
session Fleet can write to. The documented write path takes a cloud session id,
and `claude agents --json` reports a local one for every session on this
machine — so those show as **watch only** everywhere, and a message to one is
refused rather than queued. What would give a local session a cloud id is not
settled; see [Remote Control](#remote-control-what-is-known-and-what-is-not).

Two commands, in order. Neither needs the daemon.

```
node bin/fleet.mjs doctor   # is this machine in a state where anything could work?
node bin/spike.mjs          # look for a read path beyond this machine — reads only
```

`doctor` costs nothing and answers the cheaper question first, because "you are
not signed in" and "the architecture does not work" look identical from the
outside and only one of them is about Fleet. It reports `ok`, `fail` with the
exact command that fixes it, or `unknown` — and `unknown` never blocks, because
a diagnostic that guesses is worse than none.

The spike then decides the strategy and writes `fleet.config.json`. It never
prints or stores your token.

### The four strategies

| | What | Used for | Status |
|---|---|---|---|
| **A** | Reuse the CLI's stored credential against the endpoint it calls | reads | **unofficial**, and needs an endpoint nobody has yet |
| **B** | `claude -p "…" --cloud <id> --output-format json` | writes | documented, stable, **works** |
| **C** | A headless `claude -p` turn returning the fleet as JSON | fallback reads | **does not work — see below** |
| **D** | `claude agents --json` + the CLI's own transcripts | reads | documented, free, **works** |

### Strategy C does not exist

The design leaned on C as the supported fallback: a headless turn would list
sessions using the session-management MCP tools it already had. Running it
showed it has none of them — a headless `claude -p` gets 42 tools and not one
can list a session, because those tools belong to the remote-session harness
rather than to the CLI. `claude mcp list` on the same machine reports no
servers configured at all.

That is why `AgentAdapter.probeTools()` exists and is asked *first*. Without it,
"there are no session tools" and "the tools are there but the answer was
malformed" arrive as one opaque failure — an architectural dead end and a
fixable prompt bug, indistinguishable.

### Strategy D: read the laptop, not the network

C's absence left only the unofficial path, which needs an endpoint nobody has.
But the laptop already knows, from two documented local sources costing no
tokens and no network call:

- **`claude agents --json`** — which sessions exist right now: pid, cwd, kind,
  sessionId, name. Explicitly for scripting; needs no TTY.
- **`~/.claude/projects/…/<id>.jsonl`** — the transcript the CLI writes itself:
  timestamps, model, git branch, `stop_reason`, and real token usage.

Together those give title, status, lane, model, branch, repository, idle time
and context usage — the whole board.

It also reads **sessions whose process has exited**. `claude agents --json`
lists only what is running, and a session you closed the terminal on is
invisible to it — which is precisely the session this product exists to
surface. Those appear `unreachable`, which the board already renders dimmed
with a reason and for which a command is held rather than failed. Bounded by
age and by count, both applied from `mtime` before any file is opened, so poll
cost does not grow with your history.

Three decisions in that adapter are worth stating:

- **Only the tail of a transcript is read, and only when it changed.** These
  files reach megabytes — one session here is 7 MB — and this runs every poll.
  The first line of a tail read is a fragment, so it is dropped rather than
  parsed: half a JSON object is not a record. Parses are cached by `mtime`,
  which the directory scan already knows: measured without that, a laptop with
  40 recent sessions read 5 MB per poll, 15 MB a minute, forever, for files
  almost all identical to last time.
- **"Blocked" is inferred, and deliberately hard to trigger.** The platform's
  own `needs_action` is not available locally, so it is inferred from the
  transcript — and inference here is dangerous in one specific way: Fleet's
  entire value rests on `blocked` meaning something, and an alert that fires
  for every finished turn gets muted within a day, taking the real one with it.
  So four conditions are all required, and the answer is "no" whenever there is
  doubt: the turn is over (`end_turn`, not a tool call mid-flight), the
  assistant spoke last, the last line ends in a question, **and** you have had
  five minutes to answer it. That grace period is the difference between "it
  asked" and "it asked and you have not answered".

  Only the trailing line counts — a question inside an explanation is usually
  rhetorical or answered below it. Questions inside code fences are ignored.
  What this does *not* attempt is detecting a permission prompt, which would be
  the strongest possible signal: no permission-prompt entry appears in any
  transcript I could examine, and inventing a shape for one would produce a
  detector that silently never fires.
- **The repository is the git remote**, read from `.git/config` rather than by
  shelling out, so `repo:owner/name` means the same thing on every machine. A
  local path would group nothing.
- **One session in two project directories is one session.** Changing working
  directory gives a session a transcript under each slug; without deduplicating
  on the newest, it appears twice with two plausible states and no way to tell
  which is current.

### Watching is not the same as controlling

The limit that matters most, found by running the whole stack against a
five-session synthetic laptop rather than by reading the code:

**Fleet can watch a local session but cannot message it.** The only documented
write path is `claude -p "…" --cloud <id>`, and that takes a *cloud* session
id. Given a local one the CLI refuses with `--cloud cannot be combined with
--print. Cloud sessions are interactive only` — which reads like a flag problem
and is really an addressing one, and would send anyone straight to the wrong
bug.

So a purely local session shows as **watch only**: on the board, with its
status, its question and its history, and with every control dimmed and the
reason attached.

### Remote Control: what is known, and what is not

Fleet said, in nine places, that running `/remote-control` inside a session
gives it a cloud id and makes it drivable. I wrote that without checking it,
and then checked it.

What is established:

- `claude -p … --cloud <id>` takes a **cloud** session id. It refuses anything
  else, with a message about flags that sends you to the wrong bug entirely.
- `claude agents --json` reports a **local UUID** for every session on this
  machine — `5aa3a0a7-9998-…`, never `session_01…`.
- Nothing on disk maps one to the other. `~/.claude/sessions/*.json` is the
  registry `agents --json` reads, and its `sessionId` is the local one; a
  structural search of every transcript finds no cloud id in any field.
- The session I checked this on **is itself a Remote Control session**. It has
  a cloud id — the platform knows it — and the local registry still reports a
  UUID. The cloud id lives with the service, not with the CLI.
- `--remote-control [name]` is a flag you *start* a session with, per
  `claude --help`. It is not documented as a slash command, which is how Fleet
  was telling people to use it.

What is not established: whether a session started with `claude
--remote-control` reports something different, and therefore whether any local
session can ever be driven from here. One data point is not nothing — it is a
session that definitely has a cloud id, whose registry entry does not carry it
— but it is one, and it was gathered on a cloud-hosted session rather than a
laptop.

Until that is settled with a real laptop session, Fleet says what is missing (a
cloud session id) and does not hand out an instruction nobody has verified. The
refusal is unchanged and correct either way: a write to a session with no cloud
id is refused rather than queued.

### The door nobody has opened

Looking for where a cloud id might live turned up something better. The CLI's
own session registry — `~/.claude/sessions/<pid>.json`, the files behind
`claude agents --json` — carries a field the JSON output does not:

```
messagingSocketPath: "/tmp/cc-socks/498.sock"
peerProtocol:        1
peerFeatures:        ["notify_idle"]
```

That socket exists and is a real Unix socket. One per session.

If a message can be delivered over it, Fleet drives sessions on the machine it
runs on with no cloud session id involved at all — which is the difference
between a board you watch and a board you use, and would make the whole
`--cloud` addressing problem irrelevant for a laptop.

Nothing in this repository writes to it, and `bin/spike.mjs` reports it as
unproven rather than claiming it. Two reasons, and the second is the real one:
the protocol is undocumented, and the only socket on this machine belongs to
the session doing the looking — probing it means injecting messages into your
own conversation. That experiment wants a session you can afford to lose, on a
laptop, which is not this.

`src/local-sessions.js` reads the registry and tells a live socket from a stale
entry, since the registry is written when a session starts and not necessarily
cleaned up when it exits.

`bin/spike.mjs` reports this as the number that decides what Fleet is on your
machine — *"6 sessions · 5 running, 1 from transcripts · 1 can be messaged"* —
and refuses `--send-to` for a non-cloud id before spending a call on it, since
the CLI's own refusal names the flags rather than the real problem.

A write to such a session is **refused, not queued**. Held and impossible are
different: a disconnected session may wake up, so its command waits; one that
can never be addressed would otherwise mean five retries, a failure
notification, and a message you believed was on its way.

The honest limit: **strategy D only sees this machine.** A cloud session started
from a phone is invisible to it, which is why its `capabilities.scope` says
`local` and why both the spike and fleetd say so out loud at startup.

Remote Control sessions *are* local processes — they run on your machine and are
exposed to the web — so those do appear. Only true cloud sessions are missing.

I looked for a documented way to list cloud sessions from a laptop and did not
find one: `--teleport` has an interactive picker but no non-interactive list,
there is no session-management MCP server to install, and `claude mcp list`
reports none configured. That remains the open question, and the reason
strategy A is still worth an endpoint if one ever turns up.

## Layout

```
src/model.js            raw records -> the Session shape; all derived fields
src/diff.js             two snapshots -> events, with the notification policy
src/queue.js            durable command queue: retry, backoff, never silent
src/poller.js           the loop that joins them
src/adapters/           the only code that talks to Anthropic
src/adapters/local.js   strategy D: `claude agents --json` + the CLI's transcripts
src/doctor.js           can this machine run Fleet, and what to do if not
src/reach.js            how to open it from a phone, and what each way costs
src/http/auth.js        per-device tokens, stored hashed
src/http/events.js      the event log and the SSE hub
src/http/server.js      routing, validation, auth gate
src/http/static.js      serves the app; traversal is contained, not guessed at
src/http/mcp.js         the MCP face: JSON-RPC, eighteen tools, same auth
src/snooze.js           per-session alert mute, expiring, never hiding
src/media.js            the transport: playerctl on Linux, AppleScript on macOS
src/metrics.js          time to acknowledge, in percentiles, including open episodes
src/notify/policy.js    escalation, coalescing, quiet hours, the hourly ceiling
src/notify/tokens.js    what a notification is allowed to do, and for how long
src/notify/index.js     the assembly: policy + tokens + push + queue + snooze
src/tags.js             grouping, derived and manual, and who a bulk action hits
src/notes.js            the one field that is yours, kept verbatim
src/history.js          what the session did and what you did, interleaved
src/atomic.js           write-then-rename, unique per write, shared by all four stores
src/push/crypto.js      RFC 8291 + 8188 + 8292, from the specs, no deps
src/push/index.js       subscriptions, delivery, quiet hours
src/cli-helpers.js      pure helpers the CLI shares, so they can be tested
bin/fleet.mjs           the CLI
web/                    the PWA: six screens, offline cache, outbox, push
web-cockpit/            the desktop cockpit: rail, transcript, palette, keys
fixtures/               synthetic snapshots — see "Fixtures" below
```

Nothing above `src/adapters/` knows how sessions are fetched. That is the whole
point: when the unofficial path changes, one file changes.

## Two ideas the code is built around

**`reachable` decides everything.** Most sessions are `bridge` — local CLI
sessions exposed to the web — not cloud sessions, and a disconnected one can
only be revived from the machine it runs on. Every control in both clients reads
this field, so an impossible action renders dimmed with its reason instead of
failing after you tap it. A queued command for an unreachable session is *held*,
not failed: the laptop may simply be asleep.

**A message that never sent must never be silent.** Commands are written to disk
before they are attempted, survive a restart mid-flight, retry with backoff, and
end either `sent` or `failed` — where `failed` raises a push.

## Fixtures are synthetic, deliberately

`broke-releases` is a public repository: its README publishes a
`raw.githubusercontent.com` URL that SideStore reads. Real session titles and
status lines are working context, so none appear here. The fixtures carry the
real *shape* and invented content.

For the same reason, **this directory should move to its own private repository
before it grows further.** It is here because it is the branch this work was
started on, not because it belongs next to an app manifest.

## Web Push, implemented rather than wrapped

Push is the feature the phone app exists for: a board only works if you remember
to look at it, and a push arrives whether you do or not. That is the difference
between noticing a blocked session in a minute and noticing it in eleven days.

`src/push/crypto.js` implements the three RFCs directly — 8291 (ECDH + HKDF +
aes128gcm), 8188 (the content-encoding framing) and 8292 (the ES256 VAPID JWT).
Every push library is a wrapper around those; ~120 lines of `node:crypto` keeps
fleetd dependency-free.

The test that matters decrypts what the encrypter produced, performing the
receiving half of RFC 8291. Well-shaped bytes prove nothing — a browser has to
be able to read them.

Discipline, enforced in code and covered by tests:

- **Only push-severity events are sent**: blocked, a 24-hour stall, and a
  command that could not be delivered. A tool that buzzes for `session.started`
  gets muted within a week, and then the one alert that mattered is muted too.
- **Quiet hours (23:00–08:00) mute everything except a blocked session.**
- **A 410 drops the subscription** rather than retrying forever — the push
  service is telling us the browser threw it away.
- **VAPID keys are generated once and persisted.** Rotating them silently
  invalidates every subscription: every phone goes quiet without saying why.

`POST /v1/push/test` sends a real notification so you can prove the chain works
before trusting it to wake you at 3am.

## Snooze mutes alerts, never the board

A session you snooze still appears, still shows what it is waiting on, and is
marked with when it comes back. Hiding it would be the worse product: the whole
point is that nothing sits forgotten for eleven days, and a mute you cannot see
is indistinguishable from a bug.

It **expires** rather than toggling off — 4 hours by default, 72 at most —
because an indefinite mute is how a session goes quiet forever. And
`command.failed` is never suppressed: snooze is a statement about a session's
own noise, not permission to lose a message you asked to send.

## What happened while you were away

The board answers "what is true now". After four days away that is the wrong
question — and the two situations the board renders identically are exactly the
ones you need to tell apart:

```
Blocked Tuesday · you replied Tuesday evening · blocked again Wednesday, same question
Blocked Tuesday · nobody has touched it
```

So a session's history keeps both stories interleaved: what the session did and
what you did about it, each entry marked with who acted. It is bounded **per
session**, not globally — a single ring buffer would let one chatty session
evict the entire history of a quiet one, and the quiet one is the session you
come back to.

Only events a person would recognise are kept. Poll ticks, retries and adapter
chatter belong in the daemon's logs; a history you have to scroll past noise to
read is one nobody reads.

**Undo is real, not a courtesy.** A command sits in the queue until a poll
delivers it, so within that window it can simply be removed and genuinely never
happened. `POST /v1/bulk/undo` reports what it recalled *and what had already
gone*, because a clean success would be the same lie as reporting queued as
sent. Recalling is itself recorded — erasing the send it undoes would make the
history a summary of your intentions rather than a record of what happened.

## The one field that is yours

Everything else about a session is derived: the title comes from the platform,
the status line from the model, the lane from a rule. All of it describes what
a session *is*. None of it holds why you started it, what you already tried, or
what you decided at 2am and will not remember tomorrow — and that gap hurts
most on a session you come back to after four days, which is exactly the
session this product exists to surface.

A note is stored and returned verbatim, never truncated (too long is refused,
because silently cutting someone's own words in half is worse than saying it
did not fit), and it outlives its session by a week — a session disappearing is
often the moment you most want to read what you wrote about it.

## Groups, and acting on one

Twelve sessions is where a flat list stops working. You do not think "session
7, 9 and 11" — you think "the importer work".

**Most grouping requires no configuration**, because the moment you need
grouping is the moment you have too many sessions to have been labelling them.
A session's repo, branch, lane, environment, model and whatever tags the
platform already set on it all become groups on their own. Manual tags are
additive. Derived tags are never stored — they are recomputed each snapshot, so
a session that changes branch re-tags itself and a stale `branch:old` cannot
outlive the fact it described. A manual tag cannot use a reserved prefix,
because shadowing a derived one would silently change what a bulk action hits.

**Bulk is the most dangerous route here**, so it is built to be previewed:
`GET /v1/bulk` answers exactly what the matching `POST` would touch, the
cockpit confirmation names every session before anything fires, and the
response reports per-session outcomes rather than one `ok`. Unreachable
sessions are excluded and listed rather than silently included. There is a hard
limit of 25, stated rather than silently truncated — half-doing a bulk action
is worse than refusing it, because you cannot tell from the result which half
happened.

## Notifications are a system, not a push

One push is not a notification system. The failure Fleet exists to catch
survives a single push perfectly well: it arrives at 3am, you swipe it away
half asleep, and nothing mentions it again for eleven days.

**Escalation.** A blocked session you have not acted on is mentioned again
after 15 minutes, then once more an hour later, then never. Three is where a
person has either dealt with it or decided not to; a fourth is what makes
someone mute the app — which would take the next real alert with it. Acting on
the session by *any* route stops it: a tap on the notification, a message from
the cockpit, `fleet send`, or the session unblocking on its own.

**Coalescing.** Three or more sessions blocking at once arrive as one
notification. Two arrive as themselves, together, because at that size detail
is worth more than brevity. An undeliverable command is never batched — that
is the one alert that must not be delayed.

**A ceiling.** At most 12 an hour, whatever happens. Everything above is
judgement; this is the guarantee that a bug in here cannot buzz your phone all
night. It can be lowered freely and raised only to 60, because a guarantee you
can set to a million is not one.

### Acting from the lock screen

The notification carries **Reply** (inline, where the platform supports it) and
**Snooze 4h**, and both work without opening the app. Dismissing it is treated
as "not now" — a one-hour snooze — because otherwise the escalation fires again
in fifteen minutes for something you consciously set aside.

That needs credentials in a service worker, and the obvious approach — stash
the device token where the worker can read it — is worse than it looks: that
token opens every route, sends to any session, and revokes other devices.
Instead each notification carries **its own token**: one session, a handful of
verbs, one hour, never written to disk. If it leaks, the worst it can do is
what the notification could already do, to the session it was already about.
`POST /v1/notify/action` is the only route above the device gate, and that is
why.

The session comes from the token, never from the request body — there is a test
for exactly that.

### Delivery, actually measured

The service worker reports a receipt when it *shows* a notification. Everything
else in the system can only observe that a push service accepted a message,
which is not the same as it reaching a phone — and the gap between those two is
precisely where a missed alert hides. `pushDeliveryRate` below 1 means alerts
are being sent that nobody ever saw.

## Does this actually help?

Fleet exists because a session sat blocked for eleven days and nobody noticed.
That is a measurable claim, so `/v1/metrics` measures it rather than asserting
it. `fleet stats` reads it; both clients show it.

The number is **time to acknowledgement**: from the moment a session started
needing you to the moment you did something about it. Three things make it
honest rather than flattering:

**Percentiles, never a mean.** Thirty-nine sessions answered in a minute and
one forgotten for eleven days averages to about four hours, which sounds fine.
It is not fine. p50 says what normal feels like; p90 and the worst say whether
anything is still falling through.

**An episode still open counts.** A design that only records completed episodes
omits the eleven-day session entirely — it does not complete an episode until
somebody finally looks — so the metric would read perfect for exactly as long
as the failure lasted.

**A session already blocked when fleetd starts is not invisible.** The diff
emits nothing on a cold start, so the snapshot is observed directly and the
wait is backdated from `staleFor`. Those episodes are marked `inferred`, since
the wait began before fleetd was watching.

Unblocking without you is recorded as *resolved without you*, not as answered:
that is not a failure, but it is not the tool working either.

## The transport

The designs put media controls in the cockpit's rail, and building them is the
clearest illustration of why fleetd exists. Spotify's connector is read-only
and YouTube has no playback API, so no web page can pause what you are
listening to — but the machine it is playing on is the same machine fleetd runs
on, and that machine already knows how.

So this drives the platform's own media control rather than a service API,
which has the useful side effect of working for whatever is playing.

| | | |
|---|---|---|
| **Linux** | `playerctl` (MPRIS) | every serious player on the platform |
| **macOS** | AppleScript | Spotify and Music; a browser tab is out of reach |
| **Windows** | — | absent rather than half-working; it needs a helper binary |

Two things it gets right that are easy to get wrong:

**Detecting the tool is not detecting that it works.** `playerctl --version`
succeeds on a machine with no session bus, and then every button fails with
`Cannot autolaunch D-Bus`. The probe makes a real call instead, and tells the
bus error apart from the ordinary "nothing is playing" — which must *not*
disable the controls. Found by running it on a headless box, not by reasoning
about it.

**macOS talks to the app, not to the keyboard.** Synthesising an F8 keypress
through System Events silently does nothing until the person grants
accessibility permission, and a control that quietly does nothing is worse than
one that says it cannot help.

When there is no backend, both clients render the transport dimmed with the
reason attached — the same rule the session controls follow.

## The context meter reads the CLI's own accounting

Every assistant turn a session writes carries a `usage` block, and the three
input figures in it are exactly the conversation the model just read:
`input_tokens` is what was not cached, `cache_read_input_tokens` is what was,
`cache_creation_input_tokens` is what was newly cached. Add the turn's output
and you have what the next prompt will carry.

That is the number the meter draws. It is not an estimate and Fleet does not
count anything itself — the CLI has been writing it down the whole time.

It also follows a compaction down without being told: the next turn reads a
smaller context, so the usage on that turn says so. Nothing has to notice the
`compact_boundary` entry.

A session with no assistant turn yet has no reading, and the meter says so
rather than drawing an empty bar — which would read as "plenty of room left",
the opposite of the thing you look at a context meter to learn.

Crossing 70% raises `session.contextHigh`, once, at badge level — never a
push. The threshold is measured rather than chosen: two automatic compactions
in a real transcript fired just under 79% of a 1M window, each dropping about
770,000 tokens of conversation to get back to 17,000. That is lossy, and the
CLI decides what survives. `fleet compact <ref> <focus>` lets you decide
instead, which is only useful if you know it is coming.

## Known gap: the rate-limit percentage

The designs show the five-hour window as a percentage bar. The payload does not
carry one — only `status`, `resetsAt` and `isUsingOverage`. So either the meter
becomes a time-to-reset countdown (honest, and derivable today) or fleetd
estimates usage itself by tracking its own observations over the window. The
first is a design change; the second is real work. Undecided — see
`rateLimitFrom()` in `src/model.js`.

## Status

- [x] 00 Design — spec + 18 interface artboards
- [x] 01 Spike the adapter — strategy C is dead, **strategy D works**
- [x] 02 Core — model, diff, queue, poller, adapters
- [x] 03 HTTP + SSE + device auth — **tunnel and Access still to wire up**
- [x] 04 The PWA
- [x] 05 The cockpit — keyboard-first, command palette, appearance
- [x] 06 MCP face — ten tools over JSON-RPC
- [x] 07 Snooze, media transport, accessibility pass on both clients
- [x] 08 Metrics — does this actually help?
- [x] 09 Notifications — escalation, coalescing, lock-screen actions, receipts
- [x] 10 Groups and bulk — derived tags, previewed group actions
- [x] 11 MCP parity — every client capability reachable from a conversation
- [x] 12 Notes, and a flake that was two real shutdown bugs
- [x] 13 History and undo — what happened, and taking it back
- [x] 14 A read path that works — `doctor`, and strategy D
- [x] 15 Run it, don't reason about it — twenty bugs no unit test could see

### What running it found

Every bug in phase 15 came from doing the thing rather than reading the
code: driving both clients in Chromium, pointing a real fleetd at a real
fleet, and feeding it files it did not write. In rough order of how badly
each one mattered:

| | |
|---|---|
| The live stream had never worked in a browser | `EventSource` cannot send an `Authorization` header. Every other route authenticated, so the board loaded, showed real data, and silently never updated. |
| You could pair exactly one device, ever | fleetd prints a code only when it has no devices, so pairing the CLI closed the door on the phone. |
| The app claimed a message was sent | It was queued, and failing. The history said "You sent"; the toast said "Sent"; the API returns 202. |
| Every icon rendered at 300×150 | No stylesheet ever sized them. The cockpit's search magnifier covered the session rail, which read as "the rail is empty". |
| 12.5s to first paint with Google Fonts unreachable | A render-blocking third-party stylesheet, worst in exactly the offline case the PWA exists for. |
| The context meter always read 0% | `contextUsed` is set by nothing. An empty bar says "plenty of room", which is the opposite of what you look at it to learn. |
| One bad line could crash the poll | A transcript line reading `null` is valid JSON. So is `42`. |
| Three cockpit controls had no keyboard path | Model, effort and stop — in a cockpit whose premise is that nothing needs the mouse. |

The technique that found them is not clever: build a synthetic laptop,
run the whole stack against it, open it in a browser, and look.
