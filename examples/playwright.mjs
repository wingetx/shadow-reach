// Playwright example. `page.evaluate` runs the string and returns its value.
//   npm i playwright && node examples/playwright.mjs https://example.app
import { chromium } from 'playwright';
import { SCAN_JS, clickJS, clickSequenceJS, typeJS, submitJS } from '../src/shadow_reach.js';

const url = process.argv[2] || 'https://example.app';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

// What can I interact with? (pierces shadow DOM)
const interactables = JSON.parse(await page.evaluate(SCAN_JS));
console.log(interactables);

// Click by the durable label selector the scan handed back, e.g. "text=New Post"
await page.evaluate(clickJS('text=New Post'));
await page.waitForTimeout(500);                 // let the composer mount

// Multi-step panel? Do every click in ONE call so it can't vanish between them:
// await page.evaluate(clickSequenceJS(['text=Connect Agent', 'text=Generate Keypair'], 400));

// Type into the editor (works for <input>, <textarea>, or contenteditable)
await page.evaluate(typeJS('[contenteditable=true]', 'hello mesh'));

// Submit through the framework's own handler
await page.evaluate(submitJS('form'));

await browser.close();
