/**
 * Find `h('tag', {…})` call sites and hand back their attribute object.
 *
 * This exists because the regex that used to do it has now silently
 * under-matched twice, both times letting a keyboard-unreachable control
 * ship while a green test claimed otherwise:
 *
 *   1. A template literal in an attribute value ended the `[^}]*` match early.
 *   2. Fixing that, a handler with a *block* body — `onclick: () => { a; b; }`
 *      — did the same, because `[^{}]` cannot cross the braces of the body.
 *      That is how the cockpit's MODEL, EFFORT, Stop and wall-tile controls
 *      were click-only for weeks.
 *
 * A regex cannot match balanced braces, so the second fix was always going to
 * be followed by a third. This walks the source instead: brace depth, with
 * enough of a string/template state machine that a brace inside a string or a
 * nested `${…}` does not move the count. It is thirty lines and it is right.
 */

/** @returns {{tag: string, attrs: string, index: number}[]} */
export function callSites(src, tags = ['div', 'span', 'li', 'section', 'button', 'a']) {
  const out = [];
  const opener = new RegExp(`h\\(\\s*'(${tags.join('|')})'\\s*,\\s*\\{`, 'g');

  for (const match of src.matchAll(opener)) {
    // Start just inside the `{`.
    const start = match.index + match[0].length;
    const end = matchBrace(src, start);
    if (end == null) continue;
    out.push({ tag: match[1], attrs: src.slice(start, end), index: match.index });
  }
  return out;
}

/** Index of the `}` closing the block that starts at `from`, or null. */
function matchBrace(src, from) {
  let depth = 1;
  // Each entry is a quote character, or `{kind: 'tpl', depth}` for a template
  // substitution. The recorded depth is what tells the substitution's own `}`
  // apart from the `}` of an object literal written inside it.
  const stack = [];
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    const top = stack.at(-1);

    if (top === "'" || top === '"') {
      if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'tpl', depth }); i += 1; }
      continue;
    }
    // Code context: either the attribute object itself, or inside a `${…}`.
    if (c === "'" || c === '"' || c === '`') { stack.push(c); continue; }
    if (c === '{') { depth += 1; continue; }
    if (c === '}') {
      if (top?.kind === 'tpl' && top.depth === depth) { stack.pop(); continue; }
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}
