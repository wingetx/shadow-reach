"""shadow-reach (Python port) — deep-DOM-traversal JS for any browser driver.

Each function returns a string of JavaScript. Feed it to whatever runs JS in
the page: CDP ``Runtime.evaluate``, Selenium ``driver.execute_script``,
Playwright(sync) ``page.evaluate``, pyppeteer, etc.

    from shadow_reach import scan_js, click_js, type_js, submit_js

    interactables = json.loads(driver.execute_script(scan_js()))
    driver.execute_script(click_js('#new-post'))
    driver.execute_script(type_js('[contenteditable]', 'hello mesh'))
    driver.execute_script(submit_js('form'))

Reaches OPEN shadow roots only — closed roots are invisible to all scripts.
"""

import json

# Prelude: deep-traversal helpers. Prepended to every builder below.
DEEP_JS = r"""
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
      if (t === want) return el;
      if (!partial && t.indexOf(want) !== -1) partial = el;
    }
    return partial;
  }
  return __srQuery(sel);
}
"""


def scan_js() -> str:
    """JS that returns a JSON string of visible interactables across shadow roots.

    Each entry: {tag,type,id,name,placeholder,text,selector}. The ``selector``
    is chosen for durability across re-renders: ``#id`` / ``tag[name=…]`` when
    available, else a ``text=Label`` selector (re-resolved by visible label at
    action time), falling back to a synthetic ``data-sr-id`` only for unlabeled
    controls. Capped at 30.
    """
    return DEEP_JS + r"""
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
})()"""


def click_js(selector: str) -> str:
    """JS that clicks the first match across shadow roots (scrolls into view)."""
    return DEEP_JS + (
        "(function(){"
        f"  var el = __srResolve({json.dumps(selector)});"
        "  if (!el) return 'element not found';"
        "  el.scrollIntoView({block:'center'});"
        "  el.click();"
        "  return 'ok';"
        "})()"
    )


def click_sequence_js(selectors, delay_ms: int = 400) -> str:
    """JS that clicks several selectors in ONE round-trip, awaiting between.

    Use for multi-step flows where a click opens a panel that then needs a
    second click: doing it all in one evaluation means the panel can't vanish
    (via re-navigation, a fresh tab, or a blur) between the clicks. The
    ``delay_ms`` beat lets a reactive panel mount its next control.

    Returns a Promise, so AWAIT it: CDP ``Runtime.evaluate`` with
    ``awaitPromise=True``; Selenium ``execute_async_script`` (or set
    ``delay_ms=0`` and use plain ``execute_script``); Playwright awaits
    automatically. Resolves to a JSON array: ["ok: sel", …] / ["not found: sel"].
    """
    return DEEP_JS + (
        "(async function(){"
        f"  var sels = {json.dumps(list(selectors))};"
        f"  var delay = {int(delay_ms)};"
        "  var out = [];"
        "  for (var i=0;i<sels.length;i++){"
        "    var el = __srResolve(sels[i]);"
        "    if (!el){ out.push('not found: '+sels[i]); break; }"
        "    el.scrollIntoView({block:'center'});"
        "    el.click();"
        "    out.push('ok: '+sels[i]);"
        "    if (i < sels.length-1) await new Promise(function(r){ setTimeout(r, delay); });"
        "  }"
        "  return JSON.stringify(out);"
        "})()"
    )


def type_js(selector: str, text: str) -> str:
    """JS that fills an input/textarea OR a contenteditable editor."""
    return DEEP_JS + (
        "(function(){"
        f"  var el = __srResolve({json.dumps(selector)});"
        "  if (!el) return 'element not found';"
        "  el.focus();"
        f"  if (el.isContentEditable) {{ el.textContent = {json.dumps(text)}; }}"
        f"  else {{ el.value = {json.dumps(text)}; }}"
        "  el.dispatchEvent(new Event('input',  {bubbles:true}));"
        "  el.dispatchEvent(new Event('change', {bubbles:true}));"
        "  return 'ok';"
        "})()"
    )


def submit_js(selector: str) -> str:
    """JS that submits via requestSubmit() so the framework's handler runs."""
    return DEEP_JS + (
        "(function(){"
        f"  var el = __srResolve({json.dumps(selector)});"
        "  if (!el) return 'element not found';"
        "  if (el.tagName === 'FORM') { el.requestSubmit ? el.requestSubmit() : el.submit(); return 'ok'; }"
        "  var form = el.closest('form');"
        "  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'ok'; }"
        "  return 'no form found';"
        "})()"
    )
