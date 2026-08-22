# fleetd

One console for every Claude Code session: poll, diff, notify, control.

**Phases 02 and 03 of the [design spec](https://claude.ai/code/artifact/f2ea689f-ac2e-4021-8972-2904a8f8db6b)**:
the core, and the network face over it. It holds a correct model of the fleet,
detects the transitions worth telling you about, delivers commands without
losing them, and serves all of that over authenticated HTTP with a live stream.
Both clients are built against [these designs](https://claude.ai/code/artifact/79103714-1eb3-42d4-9157-00ba40f75fd3).

```
npm test                        # 273 tests, no network, no CLI, no credentials
npm run demo                    # watch the core run against fixtures
node bin/fleetd.mjs --fixture   # the daemon + the app, on fixtures
npm run spike                   # phase 01 — run this on the laptop (see below)
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

Loopback only. `/v1/health` and `/v1/pair` are open; everything else needs a
device token.

```
GET    /v1/health                    liveness; detail only when authenticated
POST   /v1/pair                      {code} -> {token}, once per window
GET    /v1/fleet                     board + counts + health (staleness)
GET    /v1/fleet/:id                 one session + its queued commands
POST   /v1/fleet/:id/send            {text}
POST   /v1/fleet/:id/model           {model}
POST   /v1/fleet/:id/effort          {effort}
POST   /v1/fleet/:id/compact         {focus?}
POST   /v1/fleet/:id/rename          {title}
POST   /v1/fleet/:id/snooze          {hours} -> mutes alerts, never the board
DELETE /v1/fleet/:id/snooze
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

`POST /mcp` speaks JSON-RPC 2.0 with sixteen tools — everything the clients can
do: `fleet_list`, `fleet_get`, `fleet_send`, `fleet_stop`, `fleet_set_model`,
`fleet_set_effort`, `fleet_compact`, `fleet_rename`, `fleet_snooze`,
`fleet_search`, `fleet_groups`, `fleet_tag`, `fleet_bulk_preview`,
`fleet_bulk`, `fleet_metrics`, `fleet_media`.

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

## Run the spike first

Everything after this depends on one unproven question: can a program on your
laptop read your session list at all? `bin/spike.mjs` answers it, per strategy,
and writes `fleet.config.json` with what worked.

```
node bin/spike.mjs                        # reads only, changes nothing
node bin/spike.mjs --send-to session_01…  # also proves a real send lands
```

It never prints or stores your token.

## The three strategies

| | What | Used for | Risk |
|---|---|---|---|
| **A** | Reuse the CLI's stored credential against the endpoint it calls | reads | **unofficial** — can break on any release |
| **B** | `claude -p "…" --cloud <id> --output-format json` | writes | documented and stable |
| **C** | A headless `claude -p` turn that returns the fleet as JSON | fallback reads | supported, but slow and costs tokens |

`CompositeAdapter` wires A→C for reads and B for writes. When A breaks, reads
fall through to C for a cool-off period rather than failing, so a break degrades
Fleet to slow-but-working instead of dead. That fallback is covered by a test,
not just by intent.

## Layout

```
src/model.js            raw records -> the Session shape; all derived fields
src/diff.js             two snapshots -> events, with the notification policy
src/queue.js            durable command queue: retry, backoff, never silent
src/poller.js           the loop that joins them
src/adapters/           the only code that talks to Anthropic
src/http/auth.js        per-device tokens, stored hashed
src/http/events.js      the event log and the SSE hub
src/http/server.js      routing, validation, auth gate
src/http/static.js      serves the app; traversal is contained, not guessed at
src/http/mcp.js         the MCP face: JSON-RPC, sixteen tools, same auth
src/snooze.js           per-session alert mute, expiring, never hiding
src/media.js            the transport: playerctl on Linux, AppleScript on macOS
src/metrics.js          time to acknowledge, in percentiles, including open episodes
src/notify/policy.js    escalation, coalescing, quiet hours, the hourly ceiling
src/notify/tokens.js    what a notification is allowed to do, and for how long
src/notify/index.js     the assembly: policy + tokens + push + queue + snooze
src/tags.js             grouping, derived and manual, and who a bulk action hits
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

## Known gap: the rate-limit percentage

The designs show the five-hour window as a percentage bar. The payload does not
carry one — only `status`, `resetsAt` and `isUsingOverage`. So either the meter
becomes a time-to-reset countdown (honest, and derivable today) or fleetd
estimates usage itself by tracking its own observations over the window. The
first is a design change; the second is real work. Undecided — see
`rateLimitFrom()` in `src/model.js`.

## Status

- [x] 00 Design — spec + 18 interface artboards
- [ ] 01 Spike the adapter — **needs the laptop**
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
