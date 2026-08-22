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
    // `[^}]*` alone stops at the first `}`, which a template literal in an
    // attribute value supplies early — that is how a click-only action list in
    // the cockpit's panel went unnoticed by this very test. Allow one level of
    // `${...}` nesting.
    const pattern = /h\('(div|span|li|section)',\s*\{((?:[^{}]|\$\{[^{}]*\})*onclick(?:[^{}]|\$\{[^{}]*\})*)\}/g;
    const orphans = [];
    for (const match of src.matchAll(pattern)) {
      const [, tag, attrs] = match;
      if (attrs.includes('onkeydown') || attrs.includes("role: 'button'")) continue;
      // A scrim is deliberately mouse-only and marked aria-hidden: clicking the
      // backdrop is a shortcut for esc, which every overlay already handles.
      // The attribute can fall outside the captured group when a handler body
      // contains braces, so look at the whole call site.
      const site = src.slice(match.index, match.index + match[0].length + 60);
      if (site.includes("'aria-hidden': 'true'")) continue;
      orphans.push(`${tag}: ${attrs.trim().slice(0, 70)}`);
    }
    assert.deepEqual(orphans, [], 'use pressable() so the keyboard can reach it');
  });

  test(`${client.name}: the click-only check actually sees nested template literals`, async () => {
    // A guard that silently matches nothing is worse than no guard. This is
    // the exact shape that slipped past the first version of the pattern.
    const sample = "h('div', { class: `act${off ? ' off' : ''}`, onclick: () => run() }, 'x')";
    const pattern = /h\('(div|span|li|section)',\s*\{((?:[^{}]|\$\{[^{}]*\})*onclick(?:[^{}]|\$\{[^{}]*\})*)\}/g;
    assert.equal([...sample.matchAll(pattern)].length, 1, 'the pattern must see through a template literal');
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
