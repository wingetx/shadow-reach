// shadow-reach — let a headless/CDP browser SEE and CLICK elements inside
// Web Components (open Shadow DOM). Driver-agnostic: every export is just a
// string of JavaScript you hand to whatever runs JS in the page (CDP
// Runtime.evaluate, Playwright page.evaluate, Selenium execute_script,
// Puppeteer evaluate, a raw devtools eval, …).
//
// See README.md for the why. Limitation: reaches OPEN shadow roots only;
// attachShadow({mode:'closed'}) is invisible to all page scripts.

// ── Prelude: the deep-traversal helpers. Inject before any call below. ──────
export const DEEP_JS = `
function __srRoots(root, acc){
  acc.push(root);
  var els = root.querySelectorAll('*');
  for (var i=0;i<els.length;i++){ if (els[i].shadowRoot) __srRoots(els[i].shadowRoot, acc); }
  return acc;
}
function __srQuery(sel){
  var roots = __srRoots(document, []);
  for (var i=0;i<roots.length;i++){ var m = roots[i].querySelector(sel); if (m) return m; }
  return null;
}
function __srQueryAll(sel){
  var roots = __srRoots(document, []), out = [];
  for (var i=0;i<roots.length;i++){ var m = roots[i].querySelectorAll(sel); for (var j=0;j<m.length;j++) out.push(m[j]); }
  return out;
}
function __srVisible(el){
  try { if (el.checkVisibility) return el.checkVisibility({checkVisibilityCSS:true}); } catch(e){}
  return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
}
function __srLabel(el){
  return ((el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '') + '').trim();
}
// Resolve a selector to an element, FRESH, at action time. Supports a durable
// "text=Foo" form that matches by visible label instead of a CSS/DOM path.
// This is the key to reliability on reactive sites: a selector captured during
// a scan must still resolve on a LATER call, but the framework may have
// re-rendered in between — destroying any id/attribute you injected and any
// positional path. A visible label survives that. Plain CSS still works.
function __srResolve(sel){
  if (sel && sel.slice(0,5) === 'text='){
    var want = sel.slice(5).trim();
    if (want.length>=2 && (want[0]==='"'||want[0]==="'") && want.slice(-1)===want[0]) want = want.slice(1,-1);
    want = want.toLowerCase();
    var cands = __srQueryAll('button, a, [role=button], [role=link], [role=menuitem], summary, input, textarea, [contenteditable=true]');
    var partial = null;
    for (var i=0;i<cands.length;i++){
      var el = cands[i];
      if (!__srVisible(el)) continue;
      var t = __srLabel(el).toLowerCase();
      if (!t) continue;
      if (t === want) return el;                       // prefer exact label match
      if (!partial && t.indexOf(want) !== -1) partial = el;
    }
    return partial;
  }
  return __srQuery(sel);
}
`;

// ── Scan: every visible interactable across all open shadow roots. ──────────
// Elements without an id/name get a synthetic data-sr-id so they stay
// addressable by a later click/type even when the framework gives them no
// stable selector. Returns a JSON string:
//   [{tag,type,id,name,placeholder,text,selector}, …]  (capped at 30)
export const SCAN_JS = DEEP_JS + `
(function(){
  var els = __srQueryAll('input, textarea, button, [role=button], [contenteditable=true]');
  var out = [];
  for (var i=0;i<els.length;i++){
    var el = els[i];
    if (!__srVisible(el)) continue;
    var sel;
    var label = (el.innerText||el.getAttribute('aria-label')||'').trim();
    if (el.id) { sel = '#'+CSS.escape(el.id); }
    else if (el.name) { sel = el.tagName.toLowerCase()+'[name="'+el.name+'"]'; }
    // Prefer a durable label selector over an injected attribute: an id stamped
    // now is wiped by a re-render before the next call. Only for short,
    // button-ish labels — long text is not a stable handle.
    else if (label && label.length<=40) { sel = 'text='+label; }
    else {
      if (!el.getAttribute('data-sr-id')) el.setAttribute('data-sr-id','sr-'+i);
      sel = '[data-sr-id="'+el.getAttribute('data-sr-id')+'"]';
    }
    out.push({
      tag: el.tagName.toLowerCase(), type: el.type||'', id: el.id||'', name: el.name||'',
      placeholder: el.placeholder||'', text: (el.innerText||el.value||'').trim().slice(0,100),
      selector: sel
    });
    if (out.length>=30) break;
  }
  return JSON.stringify(out);
})()`;

// ── Click: pierces shadow DOM, scrolls into view first. ─────────────────────
export function clickJS(selector){
  return DEEP_JS + `
(function(){
  var el = __srResolve(${JSON.stringify(selector)});
  if (!el) return 'element not found';
  el.scrollIntoView({block:'center'});
  el.click();
  return 'ok';
})()`;
}

// ── Click sequence: several clicks in ONE round-trip. ───────────────────────
// Why this exists: a multi-step flow (a panel opens, then needs a second click
// inside it) breaks if each click is a separate call AND your driver opens a
// fresh tab / re-navigates per action — the panel from click #1 is gone before
// click #2. It also breaks if the panel closes on blur. Doing the whole
// sequence inside a single evaluation sidesteps both: the page never settles,
// re-navigates, or blurs between the clicks. The `delayMs` beat lets a
// reactive panel mount its next control before we reach for it.
//
// Returns a Promise (it awaits between clicks), so AWAIT IT in your driver:
//   • Playwright  : await page.evaluate(clickSequenceJS([...]))       (auto)
//   • CDP         : Runtime.evaluate with { awaitPromise: true }
//   • Selenium    : driver.execute_async_script — or just raise delayMs to 0
// Resolves to a JSON string: ["ok: sel", …] or ["not found: sel"] on the miss.
export function clickSequenceJS(selectors, delayMs = 400){
  return DEEP_JS + `
(async function(){
  var sels = ${JSON.stringify(selectors)};
  var delay = ${Number(delayMs) || 0};
  var out = [];
  for (var i=0;i<sels.length;i++){
    var el = __srResolve(sels[i]);
    if (!el){ out.push('not found: '+sels[i]); break; }
    el.scrollIntoView({block:'center'});
    el.click();
    out.push('ok: '+sels[i]);
    if (i < sels.length-1) await new Promise(function(r){ setTimeout(r, delay); });
  }
  return JSON.stringify(out);
})()`;
}

// ── Type/fill: handles <input>/<textarea> AND contenteditable editors. ──────
// Many composers are contenteditable divs — setting .value is a silent no-op
// on those, so branch on isContentEditable. Native input/change events are
// dispatched so reactive frameworks (React/Vue/Svelte) notice the change.
export function typeJS(selector, text){
  return DEEP_JS + `
(function(){
  var el = __srResolve(${JSON.stringify(selector)});
  if (!el) return 'element not found';
  el.focus();
  if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
  else { el.value = ${JSON.stringify(text)}; }
  el.dispatchEvent(new Event('input',  {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  return 'ok';
})()`;
}

// ── Submit: requestSubmit() so the JS submit handler runs. ──────────────────
// On reactive sites the post is sent by a submit listener (fetch/XHR).
// form.submit() bypasses that listener and triggers a native navigation —
// wrong. form.requestSubmit() behaves like a real button press.
export function submitJS(selector){
  return DEEP_JS + `
(function(){
  var el = __srResolve(${JSON.stringify(selector)});
  if (!el) return 'element not found';
  if (el.tagName === 'FORM') { el.requestSubmit ? el.requestSubmit() : el.submit(); return 'ok'; }
  var form = el.closest('form');
  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'ok'; }
  return 'no form found';
})()`;
}
