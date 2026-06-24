# shadow-reach

**Let your agent's browser actually click things on modern websites.**

A tiny, dependency-free layer that lets a headless or CDP-driven browser **see
and interact with elements inside Web Components (Shadow DOM)** — the buttons,
inputs, and editors that a plain `document.querySelector` can't reach.

It's just JavaScript you inject into the page, so it works with **any** driver
in **any** language: Chrome DevTools Protocol, Playwright, Puppeteer, Selenium,
or a raw `Runtime.evaluate`.

---

## The problem

Your agent renders a page, reads it fine, and then can't do anything:

- the element scanner returns **nothing**,
- clicks come back **"element not found"**,
- typing into the composer **silently does nothing**.

…but you can clearly see the content. That split — **readable but
un-clickable** — is the fingerprint of **Shadow DOM**.

Sites built from Web Components (custom elements like `<vb-composer>`) put their
real controls inside *shadow roots*. `document.querySelector()` and
`querySelectorAll()` **stop at every shadow boundary**, so your scanner and your
clicks find air. Page *text* still reads fine because `innerText` composes
shadow content — which is exactly why it looks like the page loaded but the
controls "aren't there."

```
document.querySelector('#new-post')   ->  null      ❌  (stops at shadow boundary)
__srQuery('#new-post')                ->  <button>  ✅  (walks into shadow roots)
```

## The fix

Walk `document` **plus every open shadow root**, recursively, and resolve
selectors against all of them. shadow-reach gives you four drop-in JS builders:

| Builder        | Replaces                         | Adds                                            |
|----------------|----------------------------------|-------------------------------------------------|
| `scan`         | your interactables scanner       | pierces shadow DOM; returns **durable** selectors |
| `click`        | `document.querySelector(s).click()` | pierces shadow DOM; scrolls into view first  |
| `clickSequence`| N separate click calls           | several clicks in **one** round-trip (multi-step panels) |
| `type` / fill  | `el.value = text`                | also handles **contenteditable** composers      |
| `submit`       | `form.submit()`                  | uses **`requestSubmit()`** so the JS handler runs |

Three refinements that matter as much as the traversal:

- **durable selectors (the `text=` engine)** — see [below](#durability-the-text-engine). The
  short version: a selector found during a scan has to still work on a *later*
  call, but reactive sites re-render in between and destroy any DOM path or
  injected id. shadow-reach resolves elements by **visible label** instead,
  which survives the re-render.

- **contenteditable** — most post/comment composers are `contenteditable`
  `<div>`s, not `<input>`s. Setting `.value` on them is a silent no-op;
  shadow-reach sets `textContent` and dispatches `input`/`change` so reactive
  frameworks notice.
- **`requestSubmit()` vs `submit()`** — on a reactive site the post is sent by a
  JavaScript submit listener (fetch/XHR). `form.submit()` *bypasses* that
  listener and does a native navigation (wrong/refresh/404). `requestSubmit()`
  behaves like a real button press, so the app's own post handler runs.

---

## Install

No build, no dependencies. Copy one file:

- **JS / Node / Playwright / Puppeteer:** `src/shadow_reach.js`
- **Python / Selenium / CDP-over-websocket:** `python/shadow_reach.py`

Or vendor the whole repo.

## Use it

Every function returns a **string of JavaScript**. Hand that string to whatever
your driver uses to run JS in the page, and read the return value back.

### Chrome DevTools Protocol (Python, raw)

```python
from shadow_reach import scan_js, click_js, type_js, submit_js
import json

# however you already call Runtime.evaluate and get .result.value back:
def run(js): return cdp.evaluate(js)            # -> returns the JS return value

interactables = json.loads(run(scan_js()))      # [{tag,text,selector}, …]
run(click_js('#new-post'))                       # open the composer
run(type_js('[contenteditable=true]', 'hello mesh'))
run(submit_js('form'))                           # fires the app's submit handler
```

### Playwright (Node)

```js
import { SCAN_JS, clickJS, typeJS, submitJS } from './src/shadow_reach.js';

const interactables = JSON.parse(await page.evaluate(SCAN_JS));
await page.evaluate(clickJS('#new-post'));
await page.evaluate(typeJS('[contenteditable=true]', 'hello mesh'));
await page.evaluate(submitJS('form'));
```

### Selenium (Python)

```python
from shadow_reach import scan_js, click_js, type_js, submit_js
import json

interactables = json.loads(driver.execute_script("return " + scan_js()))
driver.execute_script("return " + click_js('#new-post'))
driver.execute_script("return " + type_js('[contenteditable=true]', 'hello'))
driver.execute_script("return " + submit_js('form'))
```

> Selenium's `execute_script` needs a leading `return ` to hand the value back.
> CDP `Runtime.evaluate` and Playwright `page.evaluate` do not.

See [`examples/`](./examples) for complete, runnable versions.

---

## How addressing works

`scan` returns a `selector` for every element it finds, picked for **durability**
in this order:

- has an `id` → `#the-id`
- has a `name` → `tag[name="the-name"]`
- has a short visible label → `text=New Post`  *(preferred — see below)*
- none of the above → a synthetic `[data-sr-id="sr-3"]` as a last resort

So **everything the scanner sees is clickable**, even controls the site gives no
stable handle. Pass any returned `selector` straight to `click`/`type`/`submit`;
they re-resolve it through the same deep traversal.

## Durability: the `text=` engine

The subtle failure on reactive sites isn't *finding* an element — it's that the
element you found **stops existing** between calls. A typical agent loop is two
round-trips: (1) scan/read, then (2) click. Between them a framework (React, Lit,
Vue, Svelte…) can re-render, throwing away the old DOM nodes. Anything tied to a
specific node dies with it:

- a synthetic attribute you injected (`data-sr-id`) is **gone**,
- a structural CSS path (`div > button:nth-child(2)`) may now point at the
  **wrong** element,

…so the click lands on nothing — even though the button is *right there* on
screen. This shows up as *"it worked yesterday, today the selector doesn't
survive the action call."*

shadow-reach's answer: address by **what the user sees**. Any selector of the
form `text=Label` is resolved *fresh at action time* to the first visible
interactive element whose label (innerText / `value` / `aria-label` /
`placeholder`) matches — exact match preferred, else substring. A visible label
is stable across re-renders in a way that node identity and DOM position are not.

```js
clickJS('text=New Post')     // re-found by label on THIS call, post-rerender
```

`scan` therefore hands back `text=` selectors for labeled, id-less controls by
default, and the action builders accept `text=` from you directly. Plain CSS
selectors still work (deep-pierced) whenever you have a stable one.

## Multi-step flows (panels that open, then need another click)

A click that opens a panel, followed by a click *inside* that panel, is the
classic place automation falls apart — and the failure has **two** independent
causes:

1. **Lifecycle.** If your driver opens a fresh tab (or re-navigates) per action,
   the panel from click #1 is destroyed before click #2 ever runs. Two separate
   calls can't share it.
2. **Blur.** Many panels close on `blur`/`focusout`. A headless or
   non-foreground tab counts as unfocused, so the panel dismisses itself the
   instant your click returns.

Both vanish if you do the whole sequence **in one evaluation**:

```js
import { clickSequenceJS } from './src/shadow_reach.js';
// click "Connect Agent", wait 400ms for the panel to mount, click "Generate Keypair"
await page.evaluate(clickSequenceJS(['text=Connect Agent', 'text=Generate Keypair'], 400));
```

The page never settles, re-navigates, or blurs between the clicks, and the delay
lets a reactive panel render its next control. `clickSequence` returns a
**Promise** (it awaits between steps) — so await it:

| Driver      | How to await                                             |
|-------------|----------------------------------------------------------|
| Playwright  | `await page.evaluate(...)` — automatic                   |
| Puppeteer   | `await page.evaluate(...)` — automatic                   |
| CDP         | `Runtime.evaluate` with `{ awaitPromise: true }`         |
| Selenium    | `driver.execute_async_script(...)`, or set `delay_ms=0` and use `execute_script` |

### Also worth setting: focus emulation

For panels that close on blur, tell the browser the page is *always* focused, so
they can't dismiss themselves between actions at all:

```python
# CDP, once per session:
cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
```

```js
// Playwright/Puppeteer: bring the page forward before acting
await page.bringToFront();
```

This is driver-level (not something injected JS can do), so it lives in your
glue code — but it pairs naturally with `clickSequence` for rock-solid panels.

## Limitation: closed shadow roots

shadow-reach reaches **open** shadow roots (`attachShadow({mode:'open'})`), which
is the overwhelming default. A **closed** root (`mode:'closed'`) is invisible to
*all* page scripts — no tool, including this one, can pierce it. If after
installing this the control *still* doesn't appear in `scan`, that's the signal
you're looking at a closed root, and the fix has to happen on the site side.

## Design notes

- **Stateless.** Each builder embeds the traversal prelude, so there's nothing
  to install into the page and nothing to re-inject after navigation.
- **Visibility-aware.** Uses `Element.checkVisibility()` where available, falling
  back to `offsetParent`/`getClientRects` — so hidden/`display:none` controls are
  skipped.
- **Safe interpolation.** Selectors and text are injected via JSON encoding, so
  quotes and special characters can't break out of the script.

## License

MIT — see [LICENSE](./LICENSE).
