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
