/**
 * Static checks on the two web clients.
 *
 * Neither client has a DOM to test against without pulling in a browser, and a
 * dependency-free daemon is worth more than that coverage. But the failures
 * that actually happen here are not subtle behaviours — they are an icon
 * button shipped with no name, a div wired to a click and nothing else, a
 * reduced-motion rule that only names transitions while the file is full of
 * animations. Those are visible in the source, so they are checked in the
 * source.
 *
 * These are regression guards, not a substitute for using a screen reader.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { callSites } from './support/callsites.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFile(join(ROOT, p), 'utf8');

const CLIENTS = [
  { name: 'phone', js: 'web/app.js', css: 'web/styles.css' },
  { name: 'cockpit', js: 'web-cockpit/cockpit.js', css: 'web-cockpit/cockpit.css' },
];

for (const client of CLIENTS) {
  test(`${client.name}: every icon-only button has a name`, async () => {
    const src = await read(client.js);
    // A button whose only child is an icon has no text for a screen reader to
    // read; without aria-label it announces as "button" and nothing more.
    const pattern = /h\('button',\s*\{([^}]*)\}\s*,\s*(?:icon|svg)\(/g;
    const unnamed = [];
    for (const match of src.matchAll(pattern)) {
      const attrs = match[1];
      if (attrs.includes('aria-label')) continue;
      // A visible text label counts: the nav tabs pair an icon with their name,
      // which is a name a screen reader can already read.
      const after = src.slice(match.index + match[0].length, match.index + match[0].length + 200);
      if (/h\('span',\s*\{\s*\}\s*,/.test(after)) continue;
      unnamed.push(attrs.trim().slice(0, 70));
    }
    assert.deepEqual(unnamed, [], 'icon-only buttons must carry aria-label');
  });

  test(`${client.name}: nothing is click-only`, async () => {
    const src = await read(client.js);
    // A non-button element with onclick and no keyboard path is unreachable by
    // keyboard and invisible to assistive tech. `pressable()` is the fix; this
    // asserts nothing bypasses it.
    const orphans = [];
    for (const site of callSites(src, ['div', 'span', 'li', 'section'])) {
      if (!/\bonclick\s*:/.test(site.attrs)) continue;
      if (/\bonkeydown\s*:/.test(site.attrs)) continue;
      if (/role:\s*'button'/.test(site.attrs)) continue;
      // An `option` inside a listbox is reached by the listbox, not by itself:
      // either roving tabindex, or a combobox moving `aria-activedescendant`.
      // Both need the option to have an id or a tabindex, and an option with
      // neither is genuinely unreachable — so that is what is checked, rather
      // than waving through every `role: 'option'`.
      if (/role:\s*'option'/.test(site.attrs) && /\b(id|tabindex):/.test(site.attrs)) {
        assert.match(src, /aria-activedescendant|tabindex: selected/, 'an option is only reachable if something moves between options');
        continue;
      }
      // A scrim is deliberately mouse-only and marked aria-hidden: clicking the
      // backdrop is a shortcut for esc, which every overlay already handles.
      if (site.attrs.includes("'aria-hidden': 'true'")) continue;
      orphans.push(`${site.tag}: ${site.attrs.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    assert.deepEqual(orphans, [], 'use pressable() so the keyboard can reach it');
  });

  test(`${client.name}: every control that opens a menu says so`, async () => {
    // A chip that opens a listbox and does not announce it reads to a screen
    // reader as a button that does nothing — which is how it feels, because
    // the menu it opened was never announced either.
    const src = await read(client.js);
    const missing = [];
    for (const site of callSites(src, ['div', 'span', 'button'])) {
      if (!/state\.menu\s*=\s*state\.menu ===/.test(site.attrs)) continue;
      if (!site.attrs.includes('aria-expanded')) missing.push(site.attrs.trim().slice(0, 60));
    }
    assert.deepEqual(missing, [], 'a menu trigger needs aria-haspopup and aria-expanded');
  });

  test(`${client.name}: a control that does nothing is not a tab stop`, async () => {
    // Tabbing along a header of idle sessions must not land on a Stop button
    // that ignores you. aria-disabled without tabindex="-1" is exactly that.
    const src = await read(client.js);
    const stops = [];
    for (const site of callSites(src, ['div', 'span', 'button'])) {
      if (!site.attrs.includes('aria-disabled')) continue;
      // An option in a listbox is never a tab stop to begin with — the
      // listbox or its combobox owns the focus and moves between options — so
      // it has no tabindex to set to -1.
      if (/role:\s*'option'/.test(site.attrs)) continue;
      if (!/tabindex/.test(site.attrs)) stops.push(site.attrs.trim().slice(0, 60));
    }
    assert.deepEqual(stops, [], 'aria-disabled must come with tabindex -1');
  });

  test(`${client.name}: reduced motion covers animation, not just transition`, async () => {
    const css = await read(client.css);
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)$/.exec(css);
    assert.ok(block, 'a prefers-reduced-motion block must exist');

    const named = css.match(/@keyframes/g) ?? [];
    if (named.length) {
      assert.match(
        block[1], /animation-duration/,
        'the file defines keyframes, so the reduced-motion rule must neutralise animations too',
      );
      assert.match(block[1], /animation-iteration-count/, 'an infinite animation must be stopped, not shortened');
    }
    assert.match(block[1], /transition-duration/);
  });

  test(`${client.name}: a keyboard focus ring exists`, async () => {
    const css = await read(client.css);
    assert.match(css, /:focus-visible/, 'without a visible ring, keyboard support is unusable');
    assert.match(css, /outline:\s*2px solid var\(--ac\)/);
  });
}

test('cockpit: every overlay is a labelled modal', async () => {
  const src = await read('web-cockpit/cockpit.js');
  const dialogs = [...src.matchAll(/role: 'dialog'([^)]*)/g)].map(([, rest]) => rest);
  assert.ok(dialogs.length >= 3, 'palette, keys and appearance are all modals');
  for (const rest of dialogs) {
    assert.match(rest, /aria-modal/, 'a dialog without aria-modal lets a screen reader wander behind it');
    assert.match(rest, /aria-label/, 'a dialog with no name announces as "dialog"');
  }
});

test('cockpit: overlay state only changes through the focus-returning helpers', async () => {
  const src = await read('web-cockpit/cockpit.js');
  // Assigning `state.overlay` directly skips focus return, which is how a
  // keyboard user ends up back at the top of the document.
  const direct = [...src.matchAll(/state\.overlay = (?!name;|null;\n  render)/g)];
  const lines = src.split('\n').filter((l) => /state\.overlay = /.test(l));
  const outside = lines.filter((l) => !/state\.overlay = name;|state\.overlay = null;/.test(l));
  assert.deepEqual(outside, [], 'use openOverlay()/closeOverlay()');
  assert.ok(direct.length >= 0);
});

test('phone: the compose field survives a re-render', async () => {
  const src = await read('web/app.js');
  // The bug this guards: a push event arrives while you are typing a reply,
  // render() replaces the DOM, and what you wrote is gone. The draft is kept
  // in state and the field has a stable id so focus can be restored to it.
  assert.match(src, /id: 'compose'/, 'the composer needs a stable id for focus restore');
  assert.match(src, /state\.drafts\[s\.id\]/, 'the composer must read its draft from state');
  assert.match(src, /function preserveFocus/);
  assert.match(src, /setSelectionRange/, 'restoring focus without the caret still loses your place');
});

test('phone: the board entrance animation is gated, not unconditional', async () => {
  const css = await read('web/styles.css');
  const js = await read('web/app.js');
  // The board is rebuilt on every poll and every event. Animating `.card`
  // outright would replay the entrance several times a minute — motion that
  // explains nothing.
  assert.doesNotMatch(css, /^\.card \{[^}]*animation:/m, 'never animate .card unconditionally');
  assert.match(css, /\.card\.enter \{[\s\S]*?animation:/);
  assert.match(js, /state\.seen\.has\(s\.id\) \? '' : ' enter'/);
});

for (const client of CLIENTS) {
  test(`${client.name}: children are flattened all the way down`, async () => {
    // A one-level flatten turns a nested array into a text node reading
    // "[object HTMLDivElement],[object …". It renders, it does not throw, and
    // no syntax check sees it. The cockpit's entire session rail was doing
    // exactly that — rail() returns [groupHeader, rows.map(…)] per lane, and
    // the inner array survived `.flat()`. Found by opening it in a browser.
    const src = await read(client.js);
    assert.doesNotMatch(src, /\.flat\(\)/, 'use flat(Infinity)');
    assert.match(src, /\.flat\(Infinity\)/);
  });
}

test('the CSP allows the inline styles both clients actually use', async () => {
  // Both clients lay out in `style` attributes. With a strict style-src every
  // one is refused: 202 violations on a single page load, measured in a real
  // browser, and an app that renders but looks broken.
  const src = await read('src/http/static.js');
  assert.match(src, /style-src[^"]*'unsafe-inline'/);
  // And the half that matters stays strict.
  assert.match(src, /"script-src 'self'"/);
  assert.doesNotMatch(src, /script-src[^"]*unsafe-inline/);
});

for (const client of CLIENTS) {
  test(`${client.name}: nothing suppresses its focus ring without replacing it`, async () => {
    // A field with `outline: none` and no compensating :focus-within on a
    // wrapper is a target a keyboard user types into with no sign they got
    // there. The cockpit's note field was exactly that.
    const src = await read(client.js);
    const css = await read(client.css);
    const suppressors = [...src.matchAll(/outline:\s*none/g)].length
      + [...css.matchAll(/outline:\s*none(?!\s*;?\s*})/g)].length;
    if (!suppressors) return;
    // Every suppression must be answered somewhere. `:focus:not(:focus-visible)`
    // is the one legitimate blanket rule — it hides the ring for mouse clicks
    // only, which is what :focus-visible exists for.
    assert.match(css, /:focus-within/, 'a suppressed ring needs a replacement indicator');
  });

  test(`${client.name}: no inline outline:none survives in a field with no wrapper`, async () => {
    const src = await read(client.js);
    for (const site of callSites(src, ['textarea', 'input'])) {
      if (!/outline:\s*none/.test(site.attrs)) continue;
      // The composer is the exception and says so in the class it sits in.
      assert.ok(
        /composer|\.box/.test(src.slice(Math.max(0, site.index - 400), site.index)),
        `a field suppresses its own ring with nothing to replace it: ${site.attrs.slice(0, 60)}`,
      );
    }
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: the pairing screen can be finished with the keyboard`, async () => {
    // It was an input beside a button. Typing the code and pressing Enter did
    // nothing — no request, no error, no sign anything had happened — on the
    // first screen anyone ever sees. A real form is what gives a phone
    // keyboard its Go key and makes Enter mean submit.
    const src = await read(client.js);
    const pairView = /function (?:viewPair|pairView)\(\)[\s\S]*?\n\}/.exec(src);
    assert.ok(pairView, 'both clients have a pairing view');
    const body = pairView[0];
    assert.match(body, /h\('form'/, 'the pairing screen must be a form');
    assert.match(body, /onsubmit:/);
    assert.match(body, /type: 'submit'/, 'or Enter has nothing to activate');
    assert.match(body, /preventDefault/, 'or submitting reloads the page and loses the code');
    assert.match(body, /autofocus/, 'the code field is the only thing on screen to type into');
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: inline icons are given a size`, async () => {
    // An inline <svg> with no width or height falls back to its intrinsic
    // 300x150. Every icon in both clients did exactly that: the phone's header
    // button was an empty box, and the cockpit's search magnifier rendered
    // 300px square and covered the session rail underneath it — which read as
    // "the rail is empty", not as an icon bug. Nothing in the DOM said so and
    // no test could have; it took looking at a screenshot.
    const js = await read(client.js);
    const css = await read(client.css);
    if (!/<svg/.test(js)) return;

    // Every element that inlines an <svg> must carry a class the CSS can reach.
    const helpers = callSites(js, ['span', 'div']).filter((c) => c.attrs.includes('<svg'));
    assert.ok(helpers.length, 'expected at least one inline-svg helper');
    for (const helper of helpers) {
      assert.match(helper.attrs, /class: (?:'ico'|cls)/, 'an icon helper must carry the class that sizes it');
    }
    // A helper that takes its class as a parameter is only as good as its
    // callers, so check them too rather than trusting the signature.
    for (const call of js.matchAll(/\bsvg\((?:[^()]|\([^()]*\))*\)/g)) {
      assert.match(call[0], /,\s*'ico'\s*\)$/, `an icon call passes no sizing class: ${call[0].slice(0, 50)}`);
    }

    // And that class must actually be sized, in both dimensions.
    const rule = /\.ico\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, 'the stylesheet must define .ico');
    assert.match(rule[1], /width:/);
    assert.match(rule[1], /height:/);
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: the reach badge comes from the field, not from the prose`, async () => {
    // The CLI used to pick between "watch only" and "unreachable" by running
    // a regex over `reachableReason`. That works until the sentence is
    // reworded, at which point every client that copied the trick quietly
    // starts calling a live, watched session unreachable.
    const src = await read(client.js);
    assert.doesNotMatch(src, /test\(\s*s\.reachableReason/, 'do not match on the explanation — read reachLabel');
    assert.doesNotMatch(src, /reachableReason\s*\)?\s*\.(match|includes|indexOf)/);
    // And where a bare word is still used, it must be the fallback, not the
    // whole answer.
    for (const bare of src.matchAll(/: 'unreachable'/g)) {
      const before = src.slice(Math.max(0, bare.index - 60), bare.index);
      assert.match(before, /reachLabel \?\?/, 'a hard-coded "unreachable" with no reachLabel in front of it');
    }
  });
}

test('the palette never offers what the panel beside it says is impossible', async () => {
  // A write to a watch-only session is refused, not queued. The session panel
  // already dims Stop, Change model, Change effort and Compact; the command
  // palette offered all four anyway, so the two halves of one screen
  // disagreed about what was possible.
  const src = await read('web-cockpit/cockpit.js');
  const items = /function paletteItems\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(items, 'the palette builds its own list');
  const body = items[0];
  for (const verb of ['effort', 'model', 'compact']) {
    const line = new RegExp(`dispatch\\(s\\.id, '${verb}'`);
    const match = line.exec(body);
    assert.ok(match, `the palette dispatches ${verb}`);
    const before = body.slice(Math.max(0, match.index - 40), match.index);
    assert.match(before, /if \(writable\)/, `${verb} must not be dispatched to a session that cannot receive it`);
  }
  assert.match(body, /disabled: !writable/, 'and it must look unavailable, not merely do nothing');
});

for (const client of CLIENTS) {
  test(`${client.name}: the context meter does not claim a number it does not have`, async () => {
    const js = await read(client.js);
    const css = await read(client.css);
    // No client may fill in a zero for a missing reading.
    assert.doesNotMatch(js, /contextUsed \?\? 0/, 'a missing reading is not a reading of zero');
    assert.match(js, /function contextFill/, 'both clients share the same honest helper');
    assert.match(js, /known: false/);
    // And "unknown" has to look different, or the honesty is invisible.
    assert.match(css, /\.meter\.unknown/);
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: the composer never promises delivery it cannot make`, async () => {
    // "Queued until this session reconnects" is true of a disconnected bridge
    // and a lie to a watch-only session, whose message is refused outright —
    // there is no write path for it to wait on. Typing into a box that
    // promises delivery and then getting a 409 is the failure this whole
    // codebase is organised around not causing.
    const src = await read(client.js);
    assert.match(src, /function composerHint/, 'the hint must depend on why it is unreachable');
    const fn = /function composerHint\(s\)[\s\S]*?\n\}/.exec(src)[0];
    assert.match(fn, /watch only/, 'watch-only is the case that must not be promised a queue');
    const queued = /Queued until this session reconnects/.exec(fn);
    assert.ok(queued, 'a disconnected session really is queued, and should still say so');
    assert.ok(fn.indexOf("'watch only'") < queued.index, 'watch-only must be answered before the queue promise');
  });
}

test('the cockpit never leaves a write action live on a session that refuses writes', async () => {
  // Stop was gated on `status !== 'running'` alone, so a running watch-only
  // session showed a live Stop button beside four dimmed siblings — and
  // pressing it produced a refusal from the server.
  const src = await read('web-cockpit/cockpit.js');
  const list = /const actions = \[[\s\S]*?\n  \];/.exec(src);
  assert.ok(list, 'the panel builds an action list');
  for (const [label, verb] of [['Stop', 'send'], ['Change model', 'model'], ['Change effort', 'effort'], ['Compact', 'compact']]) {
    const row = new RegExp(`\\['${label.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&')}',[^\\n]*`).exec(list[0]);
    assert.ok(row, `${label} is in the list`);
    assert.match(row[0], /!s\.reachable|reachLabel/, `${label} must be gated on reachability, not only on status (${verb})`);
  }
});

for (const client of CLIENTS) {
  test(`${client.name}: the event list is seeded from the log, not only from this page load`, async () => {
    // `state.events` was filled exclusively by the live stream, and the stream
    // resumes from a stored cursor. So a device that had been here before —
    // cursor already past everything fleetd recorded — opened to an empty
    // Feed about a daemon that had been watching all night. Verified by
    // disabling the seed in a real browser: "Nothing yet".
    const src = await read(client.js);
    assert.match(src, /await api\('\/v1\/events\?since=0'\)/, 'seed from the whole log, not from the cursor');
    const boot = /if \(state\.token\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(boot, 'both clients have a boot block');
    assert.match(boot[0], /seed\w*\(\)\.finally\(connect\)/,
      'seed before connecting, or the stream resends what was just replayed');
  });

  test(`${client.name}: an event that arrives twice is shown once`, async () => {
    // Three paths deliver the same event: the boot seed, the stream's replay
    // from the cursor, and a reconnect's replay from Last-Event-ID. The feed
    // is a record of what happened, so a duplicate reads as it having
    // happened twice.
    const src = await read(client.js);
    const handler = /state\.events\.unshift\(event\)/.exec(src);
    assert.ok(handler, 'the stream handler adds to the list');
    const before = src.slice(Math.max(0, handler.index - 200), handler.index);
    assert.match(before, /some\(\(e\) => e\.id === event\.id\)/, 'dedupe by id before adding');
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: pressing send never reports the message as sent`, async () => {
    // `POST /v1/fleet/:id/send` returns 202 with a pending command; the queue
    // then retries. Nothing has arrived at the moment the button is pressed,
    // and a toast reading "Sent" is the last thing you see before locking the
    // phone. Found next to a real history entry saying "You sent: …" above a
    // command that had failed four attempts.
    const src = await read(client.js);
    const call = /toast\(result\.reachable \?[^)]*\)/.exec(src);
    assert.ok(call, 'both clients toast the outcome of a dispatch');
    assert.doesNotMatch(call[0], /'Sent'/, 'the API returned 202, not a delivery');
    assert.match(call[0], /Queued/);
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: "Open in Claude" is not offered for a session that has no page there`, async () => {
    // It opened claude.ai/code/<id> for every session, including the local
    // ones that have no cloud id — a 404, with no hint that the reason is
    // the same one that stops Fleet messaging them.
    const src = await read(client.js);
    assert.match(src, /const onClaudeAi = /, 'both clients must be able to tell');
    for (const call of src.matchAll(/window\.open\(`https:\/\/claude\.ai\/code[^)]*\)/g)) {
      const before = src.slice(Math.max(0, call.index - 200), call.index);
      assert.match(before, /onClaudeAi\(s\)/, 'guard the cloud URL on the session actually having one');
    }
    assert.match(src, /claude --resume/, 'and offer the way back that does work');
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: text a session wrote cannot push the layout sideways`, async () => {
    // A status line is whatever the model typed — a URL, a stack trace, a
    // base64 blob with no space in it. Measured in a real browser: 1250px of
    // content inside a 287px panel, running off the side of the screen. Every
    // multi-line place that renders session text has to break anywhere rather
    // than trusting it to contain spaces.
    const css = await read(client.css);
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*overflow-wrap:\s*anywhere[^}]*)\}/g)];
    assert.ok(rules.length, 'the stylesheet must break unbroken text somewhere');

    const covered = rules.map((r) => r[1]).join(' ');
    // The two shapes that carry session prose in every view.
    const needed = client.name === 'phone'
      ? ['.need .body', '.detail']
      : ['.need .txt', '.tile .body'];
    for (const selector of needed) {
      assert.ok(covered.includes(selector), `${selector} renders session text and can overflow`);
    }
  });
}


/**
 * The two clients share no module — no build step, no framework, no
 * dependency, which is a deliberate property of this project and the reason a
 * handful of small helpers exist twice. That is an accepted cost right up
 * until one copy is fixed and the other is not, which is how the phone and
 * the cockpit came to disagree about what "unreachable" meant.
 *
 * So the duplication is pinned: both clients must carry the same set, and
 * every one of them has a behavioural test above. This list is the contract.
 */
const SHARED_HELPERS = ['contextFill', 'composerHint', 'onClaudeAi', 'resumeCommand', 'loadWebfont', 'duration', 'freshness'];

for (const client of CLIENTS) {
  test(`${client.name}: the metric that measures success can display success`, async () => {
    // `ago` collapses everything under a minute to "now", which is correct for
    // an age and wrong for a length of time. A fleet that is working answers
    // in seconds, so the headline stat rendered with `ago` reads
    // "typical: now" — and in the cockpit it reads that at 27px. Measured
    // against a real daemon: p50 of 6s printed as "now" beside a p90 of "20h".
    const src = await read(client.js);
    const fn = /function duration\(ms\)[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, 'a duration formatter, separate from the age one');
    assert.doesNotMatch(fn[0], /'now'/, 'a duration is never "now"');
    assert.match(fn[0], /<1s/, 'and below its smallest unit it says so');

    // Every stat in the metrics view is a length of time, not an age.
    for (const site of ['(value)', '(w.waitingMs)']) {
      assert.ok(!src.includes(`ago${site}`), `ago${site} renders a duration as an age`);
      assert.ok(src.includes(`duration${site}`), `duration${site} must render the metric`);
    }
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: nothing on screen says "now ago"`, async () => {
    // Seen in a browser: the phone header read "3 active · now ago". `ago`
    // returns "now" for anything under a minute, and three call sites appended
    // " ago" to it — which is exactly why `freshness` exists in the CLI, and
    // exactly the helper neither client had.
    const src = await read(client.js);
    assert.match(src, /function freshness/, 'the CLI has had this helper the whole time');
    // Walk the call, rather than matching it: `ago(Date.now() - x)` has a
    // closing paren in the middle, which is enough to defeat `[^)]*`.
    for (const call of src.matchAll(/\bago\(/g)) {
      let depth = 1;
      let i = call.index + call[0].length;
      for (; i < src.length && depth > 0; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
      }
      const after = src.slice(i, i + 6);
      assert.doesNotMatch(after, /^\}? ago/, `an age that reads "now" cannot take an " ago" suffix: ${src.slice(call.index, i + 6)}`);
    }
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: a rate-limit window that already reset is not counted down`, async () => {
    // `resetsAt` in the past rendered "5h resets now", and then "5h resets —".
    // Both are noise: the window has rolled and there is nothing to wait for.
    const src = await read(client.js);
    const sites = [...src.matchAll(/rl\?\.resetsAt/g)];
    assert.ok(sites.length, 'the rate-limit reading is rendered somewhere');
    for (const site of sites) {
      const after = src.slice(site.index, site.index + 30);
      assert.match(after, /resetsAt > Date\.now\(\)/, 'guard on it being in the future, not on it existing');
    }
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: "offline" is a claim about the board, not about the socket`, async () => {
    // Watched in a browser: three seconds after fleetd was killed the cockpit
    // said "offline" over a board three seconds old. The phone had already
    // learned this — "That is a claim about the connection, and it was false"
    // is a comment in its own header — and the cockpit had not.
    //
    // Three states: live, reconnecting (the stream is gone, the board is still
    // current), offline (the board is genuinely old). Plus a fourth cause that
    // is neither: fleetd answering every request and reporting that IT cannot
    // read the fleet, where nothing is offline and the fix is on the laptop.
    const src = await read(client.js);
    assert.match(src, /reconnecting/, 'the middle state has to exist');
    assert.match(src, /not reading/, 'and the fleetd-cannot-read state has to be nameable');

    // The offline decision must consult the age. Pinning the expression is
    // crude, but the alternative is a browser and four minutes of waiting.
    const decision = /const unreachable = [^;]+;/.exec(src);
    assert.ok(decision, 'the two are decided in one named place');
    assert.match(decision[0], /age/, 'offline means the board is old, not that the socket dropped');
    assert.match(decision[0], /60_000|60000/, 'with a grace period a blip does not exceed');
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: a stale board never keeps a live badge`, async () => {
    // The honesty property the whole product rests on: old state must never be
    // presented as current. `health.stale` is fleetd telling you its own reads
    // are failing — the client is connected, and the board is still wrong.
    const src = await read(client.js);
    assert.match(src, /health\?\.stale/, 'the daemon says so and the client has to read it');
    const notReading = /const notReading = [^;]+;/.exec(src);
    assert.ok(notReading, 'named, so it can be told apart from an unreachable daemon');
    assert.match(notReading[0], /health\?\.stale/);
    const stale = /const stale = [^;]+;/.exec(src);
    assert.ok(stale, 'and staleness is either cause');
    assert.match(stale[0], /notReading/);
    assert.match(stale[0], /unreachable/);

    // And when fleetd is the stale thing, the age shown must be fleetd's own
    // read age. This client fetched its board seconds ago, so its own number
    // says "just now" over data forty minutes old — the exact false
    // reassurance the banner exists to refuse. Seen in a browser: "Showing the
    // board from just now" above "it cannot read the fleet".
    const readAge = /const readAge = [^;]+;/.exec(src);
    assert.ok(readAge, 'the daemon reports how long since its last good read');
    assert.match(readAge[0], /health\?\.ageMs/);
  });
}

test('both clients carry the same shared helpers', async () => {
  const missing = [];
  for (const client of CLIENTS) {
    const src = await read(client.js);
    for (const helper of SHARED_HELPERS) {
      if (!new RegExp(`(function|const) ${helper}\\b`).test(src)) missing.push(`${client.name}: ${helper}`);
    }
  }
  assert.deepEqual(missing, [], 'a helper fixed in one client and not the other is how they drift apart');
});

for (const client of CLIENTS) {
  test(`${client.name}: the webfont is not render-blocking`, async () => {
    // Measured: 12459ms to DOMContentLoaded with fonts.googleapis.com hanging,
    // 54ms when it fails fast. A captive portal, a firewall, a plane or simply
    // being offline all produce the first number — and it is worst in exactly
    // the case the offline cache exists for.
    const html = await read(client.js.replace(/[^/]+$/, 'index.html'));
    assert.doesNotMatch(
      html, /<link[^>]+rel="stylesheet"[^>]+fonts\.googleapis\.com/,
      'a font stylesheet in the head blocks the first paint on a third party',
    );
    const js = await read(client.js);
    assert.match(js, /loadWebfont\('https:\/\/fonts\.googleapis\.com/, 'load it after first paint instead');
    // And not via an inline handler, which the CSP refuses anyway.
    assert.doesNotMatch(html, /onload=/);
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: the feed does not date an old wait to the last restart`, async () => {
    // A cold start reports every session already waiting. Describing those as
    // "is blocked" would say a three-day wait began when fleetd came up.
    const src = await read(client.js);
    const line = /'session\.blocked':[^\n]*/.exec(src);
    assert.ok(line, 'both clients describe a blocked event');
    assert.match(line[0], /sinceStart/, 'a session found already waiting reads differently');
    assert.match(line[0], /has been waiting/);
  });
}

test('the wall shows context pressure, since that is what a wall is for', async () => {
  // The wall is the view you read from across the room. "Which of these is
  // about to run out of context" belongs there rather than three clicks away
  // — and it only became showable once the meter had a real number behind it.
  const src = await read('web-cockpit/cockpit.js');
  const wall = /function wall\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(wall, 'the cockpit has a wall view');
  assert.match(wall[0], /contextFill\(s\)/, 'from the same honest helper as everywhere else');
  assert.match(wall[0], /ctx\.known\s*\n?\s*\?/, 'and shown only when there is a reading');
  assert.match(wall[0], /ctx\.hot \? 'ac' : 'ft'/, 'a full window is worth a colour');
});

for (const client of CLIENTS) {
  test(`${client.name}: a cursor from a previous daemon run is thrown away`, async () => {
    // Event ids restart at 1 on every fleetd start, and the phone's cursor
    // lives in localStorage. Without noticing the restart it asks for
    // everything after id 6, gets nothing, and would discard the new ids 1-6
    // as duplicates of the ones it already holds — which is the exact set of
    // "these sessions are waiting for you" alerts a restart now produces.
    const src = await read(client.js);
    assert.match(src, /function checkEpoch/, 'both clients must notice the numbering restarting');
    const fn = /function checkEpoch\(fleet\)[\s\S]*?\n\}/.exec(src)[0];
    assert.match(fn, /state\.events = \[\]/, 'the cached events are numbered against the old run');
    // Called from the one place every fleet payload arrives — snapshot and poll alike.
    const setFleet = /function setFleet\(fleet\)[\s\S]*?\n\}/.exec(src)[0];
    assert.match(setFleet, /checkEpoch\(fleet\)/);
  });
}

for (const client of CLIENTS) {
  test(`${client.name}: a dropped stream asks whether this device is still allowed in`, async () => {
    // EventSource reconnects on its own and never says why it failed, so a
    // revoked device and a sleeping laptop look identical from the client.
    // Without asking, a revoked phone retried forever behind a board that
    // still said "live".
    const src = await read(client.js);
    assert.match(src, /function verifyStillPaired/, 'the client has to ask');
    const at = src.indexOf("addEventListener('error'");
    assert.ok(at > 0, 'the stream has an error handler');
    assert.match(
      src.slice(at, at + 600), /verifyStillPaired\(\)/,
      'and it asks from there, not from somewhere unrelated',
    );

    // Debounced: EventSource retries every three seconds, and "was I revoked"
    // is not a question whose answer changes that often.
    const fn = /function verifyStillPaired\(\)[\s\S]*?\n\}/.exec(src)[0];
    assert.match(fn, /if \(verifying/, 'or a flapping connection becomes a request loop');
  });
}
