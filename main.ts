// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** An edit, plus the move it performs when it is one (sections 6 and 8). */
interface EditRec {
  fn: Edit;
  move?: { from: string; to: string };
}

/** A file's lines under section 3: its break, its lines, whether it ends with a break. */
interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { br, lines: parts, final };
}

function renderFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

/** Section 5: line equality at one tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All positions i where O matches file lines F[i..] at the given tier (overlaps allowed). */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  for (let i = 0; i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Section 5 tier-2 re-indent of one new line; other tiers write the line as it is. */
function reindent(line: string, p: string, f: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'add' | 'back';
  text: string;
}

/** A hunk/chunk split into old lines O and the replacement ops in N order. */
interface Split {
  o: string[];
  ops: Array<{ ctx: boolean; oIdx: number; text: string }>;
}

function splitBody(body: BodyLine[]): Split {
  const o: string[] = [];
  const ops: Array<{ ctx: boolean; oIdx: number; text: string }> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      ops.push({ ctx: true, oIdx: o.length, text: b.text });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      ops.push({ ctx: false, oIdx: -1, text: b.text });
    }
  }
  return { o, ops };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'back';
}

/** Apply one unified hunk (section 6) to the file's current lines. d is the drift of this section's earlier hunks. */
function applyHunk(f: FileLines, h: { a: number; body: BodyLine[] }, strict: boolean, d: number, failPath: string): FileLines {
  const { o: O, ops } = splitBody(h.body);
  const noTrail = backslashAfterLast(h.body);
  if (O.length === 0) {
    let at = h.a + d;
    if (at < 0) at = 0;
    if (at > f.lines.length) at = f.lines.length;
    const lines = [...f.lines.slice(0, at), ...ops.map((x) => x.text), ...f.lines.slice(at)];
    const final = at === f.lines.length ? !noTrail : f.final;
    return { br: f.br, lines, final };
  }
  let tier = -1;
  let occ: number[] = [];
  for (const t of tiers(strict)) {
    occ = occurrences(O, f.lines, t);
    if (occ.length > 0) {
      tier = t;
      break;
    }
  }
  if (tier < 0) throw new Fail('no-match', failPath);
  const target = h.a - 1 + d;
  let best = occ[0]!;
  for (const p of occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const p0 = leadingWS(O[0]!);
  const f0 = leadingWS(f.lines[best]!);
  const repl = ops.map((x) => (x.ctx ? f.lines[best + x.oIdx]! : reindent(x.text, p0, f0, tier)));
  const lines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + O.length)];
  const final = best + O.length === f.lines.length ? !noTrail : f.final;
  return { br: f.br, lines, final };
}

/** Apply a section's hunks in order (section 6). */
function applyHunks(before: string, hunks: Array<{ a: number; body: BodyLine[] }>, strict: boolean, failPath: string): string {
  let f = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o: O, ops } = splitBody(h.body);
    f = applyHunk(f, h, strict, d, failPath);
    d += ops.length - O.length;
  }
  return renderFile(f);
}

/** The text of a created file from a unified section's hunks (section 6). */
function creationText(hunks: Array<{ a: number; body: BodyLine[] }>): string {
  const lines: string[] = [];
  let lastPlusBack = false;
  for (const h of hunks) {
    let lastAdd = -1;
    for (let k = 0; k < h.body.length; k += 1) {
      if (h.body[k]!.kind === 'add') lastAdd = k;
    }
    for (const b of h.body) {
      if (b.kind === 'add') lines.push(b.text);
    }
    if (lastAdd >= 0) lastPlusBack = h.body[lastAdd + 1]?.kind === 'back';
  }
  return renderFile({ br: '\n', lines, final: lines.length > 0 ? !lastPlusBack : false });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditRec[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditRec[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push({ fn: e });
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push({ fn: e });
  });
  return edits;
}

/** Section 6: one section of a unified diff. */
interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  remove: boolean;
  hasPair: boolean;
  hunks: Array<{ a: number; body: BodyLine[] }>;
}

function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

/** A hunk's body: the lines after its header that start with ` `, `-`, `+` or `\`, or are empty. */
function hunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `--- ` line followed by a `+++ ` line (a new section starts there),
    // even though such a line also starts with a body character (`-`).
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'add', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'back', text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const lastB = body[body.length - 1]!;
    if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

function unifiedEdit(sec: USection, strict: boolean): EditRec {
  const oldP = sec.hasPair ? sec.oldPath : sec.renameFrom !== null ? sec.renameFrom : sec.oldPath;
  const newP = sec.hasPair ? sec.newPath : sec.renameTo !== null ? sec.renameTo : sec.newPath;
  const isCreate = oldP === null || sec.create;
  const isDelete = !isCreate && (newP === null || sec.remove);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  const fn: Edit = (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const np = newP ?? '';
      if (np === '') throw new Fail('unsafe', '/dev/null');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, creationText(sec.hunks));
      return;
    }
    if (isDelete) {
      const op = oldP ?? '';
      if (op === '') throw new Fail('missing', '/dev/null');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, strict, p));
  };
  const rec: EditRec = { fn };
  if (isMove) rec.move = { from: oldP!, to: newP! };
  return rec;
}

function parseUnified(lines: string[], strict: boolean): EditRec[] {
  const sections: USection[] = [];
  const newSection = (): USection => {
    const s: USection = { oldPath: null, newPath: null, renameFrom: null, renameTo: null, create: false, remove: false, hasPair: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const pairAt = (i: number): { oldP: string | null; newP: string | null } => {
    const strip = (raw: string): string | null => {
      let p = raw;
      const tab = p.indexOf('\t');
      if (tab >= 0) p = p.slice(0, tab);
      p = p.trim();
      if (p === '/dev/null') return null;
      if (p.startsWith('a/')) p = p.slice(2);
      else if (p.startsWith('b/')) p = p.slice(2);
      return p;
    };
    return { oldP: strip(lines[i]!.slice(4)), newP: strip(lines[i + 1]!.slice(4)) };
  };
  let cur: USection | null = null;
  let inHunks = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      inHunks = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inHunks && !cur.hasPair) {
        const pr = pairAt(i);
        cur.oldPath = pr.oldP;
        cur.newPath = pr.newP;
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = newSection();
      const pr = pairAt(i);
      cur.oldPath = pr.oldP;
      cur.newPath = pr.newP;
      cur.hasPair = true;
      inHunks = false;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = hunkHead(line);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = hunkBody(lines, i + 1);
        cur.hunks.push({ a, body });
        inHunks = true;
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkHead(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = hunkBody(lines, i + 1);
      cur.hunks.push({ a, body });
      i = next;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Section 7: one SEARCH/REPLACE block. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditRec {
  const fn: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderFile({ br: '\n', lines: newLines, final: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = occurrences(oldLines, f.lines, t);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const at = occ[0]!;
    const p0 = leadingWS(oldLines[0]!);
    const f0 = leadingWS(f.lines[at]!);
    const repl = newLines.map((x) => reindent(x, p0, f0, tier));
    const newLinesOut = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderFile({ br: f.br, lines: newLinesOut, final: f.final }));
  };
  return { fn };
}

function parseSearchReplace(lines: string[], strict: boolean): EditRec[] {
  const edits: EditRec[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let sep = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Section 8: one V4A chunk. */
interface VChunk {
  anchor: string | null;
  o: string[];
  ops: Array<{ ctx: boolean; oIdx: number; text: string }>;
  eof: boolean;
}

function v4aAddEdit(path: string, addLines: string[]): EditRec {
  const fn: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, renderFile({ br: '\n', lines: addLines, final: addLines.length > 0 }));
  };
  return { fn };
}

function v4aDelEdit(path: string): EditRec {
  const fn: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
  return { fn };
}

function v4aUpdEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): EditRec {
  const fn: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let j = cursor; j < f.lines.length; j += 1) {
            if (lineEq(f.lines[j]!, ch.anchor, t)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, at), ...ch.ops.map((x) => x.text), ...f.lines.slice(at)];
        f = { br: f.br, lines, final: f.final };
        cursor = at + ch.ops.length;
        continue;
      }
      let tier = -1;
      let pos = -1;
      for (const t of tiers(strict)) {
        for (let i2 = cursor; i2 + ch.o.length <= f.lines.length; i2 += 1) {
          if (ch.eof && i2 + ch.o.length !== f.lines.length) continue;
          let ok = true;
          for (let j = 0; j < ch.o.length; j += 1) {
            if (!lineEq(ch.o[j]!, f.lines[i2 + j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            pos = i2;
            break;
          }
        }
        if (pos >= 0) break;
      }
      if (pos < 0) throw new Fail('no-match', path);
      const p0 = leadingWS(ch.o[0]!);
      const f0 = leadingWS(f.lines[pos]!);
      const repl = ch.ops.map((x) => (x.ctx ? f.lines[pos + x.oIdx]! : reindent(x.text, p0, f0, tier)));
      const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + ch.o.length)];
      f = { br: f.br, lines, final: f.final };
      cursor = pos + repl.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, out);
    }
  };
  const rec: EditRec = { fn };
  if (moveTo !== null) rec.move = { from: path, to: moveTo };
  return rec;
}

function parseV4a(lines: string[], strict: boolean): EditRec[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;
  const edits: EditRec[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = sectionStart.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    let j = i + 1;
    while (j < last) {
      if (sectionStart.test(lines[j]!)) break;
      j += 1;
    }
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const body = lines.slice(i + 1, end);
    const bodyNo = (k: number): number => i + 2 + k;
    if (kind === 'Add File') {
      const addLines: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const l = body[k]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${bodyNo(k)}`);
      }
      edits.push(v4aAddEdit(path, addLines));
    } else if (kind === 'Delete File') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyNo(0)}`);
      edits.push(v4aDelEdit(path));
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; o: string[]; ops: Array<{ ctx: boolean; oIdx: number; text: string }>; eof: boolean } | null = null;
      let seenBody = false;
      let afterEof = false;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (let k = 0; k < body.length; k += 1) {
        const l = body[k]!;
        const ln = bodyNo(k);
        if (k === 0 && l.startsWith('*** Move to:')) {
          moveTo = l.slice('*** Move to:'.length).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          pushCur();
          cur = { anchor: l.slice(2).trim() || null, o: [], ops: [], eof: false };
          seenBody = true;
          afterEof = false;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          pushCur();
          afterEof = true;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (!seenBody && !afterEof) {
              cur = { anchor: null, o: [], ops: [], eof: false };
              seenBody = true;
            } else {
              throw new Exit2(`error: parse ${ln}`);
            }
          }
          if (l === '') {
            cur.ops.push({ ctx: true, oIdx: cur.o.length, text: '' });
            cur.o.push('');
          } else if (l[0] === ' ') {
            cur.ops.push({ ctx: true, oIdx: cur.o.length, text: l.slice(1) });
            cur.o.push(l.slice(1));
          } else if (l[0] === '-') {
            cur.o.push(l.slice(1));
          } else {
            cur.ops.push({ ctx: false, oIdx: -1, text: l.slice(1) });
          }
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditRec[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.fn(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const edit of edits) {
    const mv = edit.move;
    if (mv === undefined) continue;
    const wasOld = tree.original(mv.from);
    const nowOld = tree.now.has(mv.from) ? tree.now.get(mv.from)! : tree.original(mv.from);
    const wasNew = tree.original(mv.to);
    const nowNew = tree.now.has(mv.to) ? tree.now.get(mv.to)! : tree.original(mv.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      coveredOld.add(mv.from);
      coveredNew.add(mv.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const now = tree.now.get(p)!;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
