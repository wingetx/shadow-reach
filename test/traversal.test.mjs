// Dependency-free tests. We don't have a real DOM in Node, so we install a
// tiny stub as `globalThis.document`, then eval the *actual* library JS strings
// against it. This proves the shipped traversal (a) pierces shadow DOM and
// (b) produces selectors that survive a re-render — the two failure modes this
// library exists to fix.
//
//   run:  node test/traversal.test.mjs   (or: npm test)

import { SCAN_JS, clickJS, clickSequenceJS } from '../src/shadow_reach.js';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

// ── minimal DOM stub ────────────────────────────────────────────────────────
function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(), id: opts.id || '', name: opts.name || '',
    _text: opts.text || '', value: '', placeholder: opts.placeholder || '',
    type: opts.type || '', isContentEditable: !!opts.editable,
    shadowRoot: opts.shadowRoot || null, _kids: opts.kids || [], _attrs: {},
    get innerText() { return this._text; },
    getAttribute(k) { return k === 'aria-label' ? (opts.ariaLabel || null) : (this._attrs[k] ?? null); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    checkVisibility() { return true; },
    scrollIntoView() {}, focus() {}, click() { el._clicked = true; },
    closest() { return null; },
    querySelectorAll(sel) {
      const all = []; const walk = n => { for (const k of n._kids) { all.push(k); walk(k); } }; walk(this);
      if (sel === '*') return all;
      const parts = sel.split(',').map(s => s.trim());
      return all.filter(e => parts.some(s => matchesSimple(e, s)));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  return el;
}
function matchesSimple(e, s) {
  if (s[0] === '#') return e.id === s.slice(1);
  if (s[0] === '[') {                                   // [attr] or [attr="v"]
    const m = s.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
    if (!m) return false;
    const v = e.getAttribute(m[1]) ?? e._attrs[m[1]];
    return m[2] === undefined ? v != null : v === m[2];
  }
  const tag = s.toUpperCase().split(/[.\[: ]/)[0];
  return tag === '' || tag === e.tagName;
}
function setDoc(d) { globalThis.document = d; globalThis.CSS = { escape: s => s }; }
function run(js) { return eval(js); }                   // evaluate a library string

// ── fixture: a "New Post" button with NO id, inside a shadow root ───────────
const buildDoc = () => {
  const btn = makeEl('button', { text: 'New Post' });
  const host = makeEl('vb-bar', { shadowRoot: makeEl('root', { kids: [btn] }) });
  return makeEl('html', { kids: [host] });
};

// 1) plain querySelector cannot see into the shadow root …
setDoc(buildDoc());
ok('plain querySelector does NOT pierce shadow DOM',
   document.querySelector('button') === null);

// 2) … but the library scan does, and returns a durable text= selector
const scanned = JSON.parse(run(SCAN_JS));
ok('scan finds the shadow-DOM button', scanned.length === 1);
ok('scan returns a durable text= selector', scanned[0].selector === 'text=New Post');

// 3) the selector still resolves AND clicks AFTER a full re-render
const sel = scanned[0].selector;
setDoc(buildDoc());                                      // SPA throws away old nodes
const res = run(clickJS(sel));
ok('click via text= works after a re-render', res === 'ok');
ok('the right element was actually clicked',
   document.querySelector('*') && find(document, e => e._clicked && e._text === 'New Post'));

function find(root, pred) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (pred(n)) return true;
    for (const k of n._kids) stack.push(k);
    if (n.shadowRoot) stack.push(n.shadowRoot);
  }
  return false;
}

// 4) clickSequence clicks both controls, in order, in one (awaited) call
setDoc((() => {
  const a = makeEl('button', { text: 'Connect Agent' });
  const b = makeEl('button', { text: 'Generate Keypair' });
  return makeEl('html', { kids: [makeEl('panel', { shadowRoot: makeEl('root', { kids: [a, b] }) })] });
})());
const seqOut = JSON.parse(await run(clickSequenceJS(['text=Connect Agent', 'text=Generate Keypair'], 5)));
ok('clickSequence reports both clicks ok',
   seqOut.length === 2 && seqOut.every(s => s.startsWith('ok:')));
ok('clickSequence actually clicked both buttons',
   find(document, e => e._clicked && e._text === 'Connect Agent') &&
   find(document, e => e._clicked && e._text === 'Generate Keypair'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
