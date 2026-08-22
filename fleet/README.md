# fleetd

One console for every Claude Code session: poll, diff, notify, control.

**Phases 02 and 03 of the [design spec](https://claude.ai/code/artifact/f2ea689f-ac2e-4021-8972-2904a8f8db6b)**:
the core, and the network face over it. It holds a correct model of the fleet,
detects the transitions worth telling you about, delivers commands without
losing them, and serves all of that over authenticated HTTP with a live stream.
Both clients are built against [these designs](https://claude.ai/code/artifact/79103714-1eb3-42d4-9157-00ba40f75fd3).

```
npm test                        # 94 tests, no network, no CLI, no credentials
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
GET    /v1/stream                    SSE: snapshot, then live events
GET    /v1/events?since=<cursor>     replay, with a truncation flag
GET    /v1/search?q=
GET    /v1/commands                  the queue, with delivery state
POST   /v1/commands/:id/retry
DELETE /v1/commands/:id
GET    /v1/devices
DELETE /v1/devices/:id               revoke one phone, nothing else
POST   /mcp                          JSON-RPC 2.0 — the MCP face
```

## The MCP face

`POST /mcp` speaks JSON-RPC 2.0 with nine tools: `fleet_list`, `fleet_get`,
`fleet_send`, `fleet_stop`, `fleet_set_model`, `fleet_set_effort`,
`fleet_compact`, `fleet_rename`, `fleet_search`.

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
src/http/mcp.js         the MCP face: JSON-RPC, nine tools, same auth
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
- [x] 04 The PWA — **Web Push still needs VAPID keys and a subscription store**
- [x] 05 The cockpit — keyboard-first, command palette, appearance
- [x] 06 MCP face — nine tools over JSON-RPC
