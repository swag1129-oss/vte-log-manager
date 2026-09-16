// compare.cjs — deep-compare two snapshot JSON files.
//
// Usage: node compare.cjs a.json b.json
// Prints "IDENTICAL" and exits 0 if equal.
// Otherwise prints up to the first 50 differences with JSON paths and exits 1.

const fs = require('fs');

const [, , aFile, bFile] = process.argv;
if (!aFile || !bFile) {
  console.error('Usage: node compare.cjs a.json b.json');
  process.exit(2);
}

const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
const b = JSON.parse(fs.readFileSync(bFile, 'utf8'));

const MAX_DIFFS = 50;
const diffs = [];

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fmtVal(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function walk(pathStr, x, y) {
  if (diffs.length >= MAX_DIFFS) return;
  const tx = typeOf(x), ty = typeOf(y);
  if (tx !== ty) {
    diffs.push(`${pathStr}: type mismatch (${tx} vs ${ty}) — ${fmtVal(x)} vs ${fmtVal(y)}`);
    return;
  }
  if (tx === 'array') {
    if (x.length !== y.length) {
      diffs.push(`${pathStr}: array length mismatch (${x.length} vs ${y.length})`);
    }
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len && diffs.length < MAX_DIFFS; i++) {
      walk(`${pathStr}[${i}]`, x[i], y[i]);
    }
    return;
  }
  if (tx === 'object') {
    const keysX = Object.keys(x).sort();
    const keysY = Object.keys(y).sort();
    const allKeys = Array.from(new Set([...keysX, ...keysY])).sort();
    for (const k of allKeys) {
      if (diffs.length >= MAX_DIFFS) return;
      const hasX = Object.prototype.hasOwnProperty.call(x, k);
      const hasY = Object.prototype.hasOwnProperty.call(y, k);
      const childPath = `${pathStr}.${k}`;
      if (!hasX) {
        diffs.push(`${childPath}: missing in A — present in B as ${fmtVal(y[k])}`);
      } else if (!hasY) {
        diffs.push(`${childPath}: missing in B — present in A as ${fmtVal(x[k])}`);
      } else {
        walk(childPath, x[k], y[k]);
      }
    }
    return;
  }
  // primitive
  if (x !== y) {
    diffs.push(`${pathStr}: ${fmtVal(x)} !== ${fmtVal(y)}`);
  }
}

walk('$', a, b);

if (diffs.length === 0) {
  console.log('IDENTICAL');
  process.exit(0);
} else {
  console.log(`DIFFERENT (${diffs.length}${diffs.length >= MAX_DIFFS ? '+' : ''} difference(s) found, showing up to ${MAX_DIFFS}):`);
  for (const d of diffs.slice(0, MAX_DIFFS)) console.log('  ' + d);
  process.exit(1);
}
