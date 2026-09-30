// TOKEN object vs every TOKEN.<key> reference: a deleted key would splice
// literally "undefined" into generated CSS at runtime, with no error.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const start = src.indexOf('var TOKEN = {');
if (start < 0) { console.error('FAIL: TOKEN object not found'); process.exit(1); }
const end = src.indexOf('\n    };', start);
const block = src.slice(start, end);

const defined = new Set([...block.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
const used = new Set([...src.matchAll(/TOKEN\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));

console.log('defined:', [...defined].sort().join(' '));
const missing = [...used].filter((k) => !defined.has(k));
const unused = [...defined].filter((k) => !used.has(k));

let bad = 0;
if (missing.length) { bad++; console.error('FAIL  referenced but NOT defined (would emit `undefined`):', missing.join(', ')); }
else console.log('PASS  every TOKEN.<key> used is defined');

if (unused.length) console.log('note  defined but unreferenced (harmless):', unused.join(', '));

// Every colour inside TOKEN must be a var() with a fallback, never a bare value.
const bare = [...block.matchAll(/^\s{6}([A-Za-z0-9_]+):\s*'([^']*)'/gm)]
  .filter(([, key, value]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(value) && !value.startsWith('var('));
if (bare.length) { bad++; console.error('FAIL  colour literals outside var():', bare.map((m) => m[1]).join(', ')); }
else console.log('PASS  every colour in TOKEN is theme-var based');

// And the generated browser CSS must contain no raw colour either. Comments are
// prose about the official values (they legitimately quote e.g. the shipped
// menu fill), so only real CSS string literals are judged.
const cssStart = src.indexOf('var BROWSER_CSS = [');
let cssBlock = src.slice(cssStart, src.indexOf("].join('\\n')", cssStart));
cssBlock = cssBlock.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
// Any theme token counts as themed: --dsw-alias-*, --dsw-radius/elevation/menu/
// mask/static, --ds-*. Anything still holding a colour is a genuine hardcode.
const stripped = cssBlock.replace(/\bvar\((--[A-Za-z0-9-]+)([^()]|\([^()]*\))*\)/g, 'VAR');
const cssBare = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)];
if (cssBare.length) { bad++; console.error('FAIL  raw colour left in BROWSER_CSS:', cssBare.map((m) => m[0]).join(', ')); }
else console.log('PASS  BROWSER_CSS has no colour outside a theme-var fallback');

if (bad) process.exit(1);
console.log('\ntoken-hygiene: all checks passed');
