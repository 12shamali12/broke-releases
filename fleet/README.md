# fleetd

One console for every Claude Code session: poll, diff, notify, control.

This is **phase 02 of the [design spec](https://claude.ai/code/artifact/f2ea689f-ac2e-4021-8972-2904a8f8db6b)** — the
core, with no network face yet. It holds a correct model of the fleet, detects
the transitions worth telling you about, and delivers commands without losing
them. The HTTP and MCP faces come next, and both clients are built against
[these designs](https://claude.ai/code/artifact/79103714-1eb3-42d4-9157-00ba40f75fd3).

```
npm test          # 43 tests, no network, no CLI, no credentials
npm run demo      # watch the core run against fixtures
npm run spike     # phase 01 — run this on the laptop (see below)
```

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
- [ ] 03 REST + WebSocket + tunnel + Access
- [ ] 04 The PWA
- [ ] 05 The cockpit
- [ ] 06 MCP face
