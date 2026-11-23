// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** Remove leading and trailing space characters (' ' only), not other whitespace. */
function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ' ') a++;
  while (b > a && s[b - 1] === ' ') b--;
  return s.slice(a, b);
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines, keeping its own line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** A line normalised for a matching tier (SPEC.md section 5). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O matches the file's lines at a tier; occurrences may overlap. */
function findOccurrences(file: string[], o: string[], tier: number): number[] {
  const occ: number[] = [];
  if (o.length === 0 || o.length > file.length) return occ;
  const want = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

/** The first tier at which O occurs at least once, with its occurrences; null when it never occurs. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The first tier at which O occurs at or after `from`, with its first such occurrence; null when none.
 * When `onlyEndAt` is given, only the occurrence ending at the file's last line counts (a V4A
 * end-of-file chunk).
 */
function findTierFrom(
  file: string[],
  o: string[],
  from: number,
  strict: boolean,
  onlyEndAt?: number,
): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(file, o, t).filter((p) => p >= from && (onlyEndAt === undefined || p === onlyEndAt));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** The occurrence nearest to a target position; of two equally near, the earlier. */
function nearestOcc(occ: number[], target: number): number {
  let best = occ[0]!;
  let bestD = Math.abs(best - target);
  for (const o of occ) {
    const d = Math.abs(o - target);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

/**
 * The lines that replace the k matched lines: context lines are written as the file's own matched lines,
 * and at tier 2 every other line is re-indented from O's first line to the file's first matched line.
 * `ctxN` maps an index in N to the index in O of the context line it is.
 */
function applyPiece(
  file: string[],
  at: number,
  o: string[],
  n: string[],
  ctxN: Map<number, number>,
  tier: number,
): string[] {
  const f = at < file.length ? leadingWs(file[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  for (let j = 0; j < n.length; j++) {
    const c = ctxN.get(j);
    if (c !== undefined) {
      out.push(file[at + c]!);
    } else if (tier === 2 && n[j] !== '' && !onlyWs(n[j]!) && n[j]!.startsWith(p)) {
      out.push(f + n[j]!.slice(p.length));
    } else {
      out.push(n[j]!);
    }
  }
  return out;
}

/** A body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** O, N and the context-line map for a hunk or chunk body; `\` lines are not lines of either. */
function pieceON(body: BodyLine[]): { o: string[]; n: string[]; ctxN: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctxN = new Map<number, number>();
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctxN.set(n.length, o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push(b.text);
    }
  }
  return { o, n, ctxN };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function bsAfterLastCtxOrPlus(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
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
      edits.push(e);
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
    edits.push(e);
  });
  return edits;
}

/** A unified hunk (SPEC.md section 6). */
interface UniHunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UniHunk[];
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function uniPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimSpaces(t);
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/** Apply a section's hunks in order to a file's text; throws Fail on the first hunk that fails. */
function applyUniHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctxN } = pieceON(h.body);
    if (o.length === 0 && n.length === 0) continue; // a hunk with no body lines is a no-op
    if (o.length === 0) {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...n);
      if (atEnd) f.final = !bsAfterLastCtxOrPlus(h.body);
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const at = nearestOcc(found.occ, h.a - 1 + d);
    const rep = applyPiece(f.lines, at, o, n, ctxN, found.tier);
    const toEnd = at + o.length === f.lines.length;
    f.lines.splice(at, o.length, ...rep);
    if (toEnd) f.final = !bsAfterLastCtxOrPlus(h.body);
    d += n.length - o.length;
  }
  return joinFile(f);
}

/** Whether a created file ends with a line break: it does unless a `\` follows its last `+` line. */
function creationFinalBr(hunks: UniHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'new') return body[k + 1]?.kind !== 'bs';
    }
  }
  return true;
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameOld ?? sec.diffOld ?? '';
    const newP = sec.newPath ?? sec.renameNew ?? sec.diffNew ?? '';
    if (oldP === '/dev/null' || sec.newFileMode) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (creationFinalBr(sec.hunks) ? '\n' : ''));
      return;
    }
    if (newP === '/dev/null' || sec.deletedFileMode) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUniHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyUniHunks(before, sec.hunks, strict, oldP));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let sec: UniSection | null = null;
  let pairDone = false;
  let seenHunk = false;
  const flush = (): void => {
    if (sec !== null) {
      edits.push(uniEdit(sec, strict));
      sec = null;
      pairDone = false;
      seenHunk = false;
    }
  };
  const newSection = (diffOld: string | null, diffNew: string | null): void => {
    sec = {
      oldPath: null,
      newPath: null,
      renameOld: null,
      renameNew: null,
      diffOld,
      diffNew,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = l.match(DIFF_RE);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && !seenHunk && !pairDone) {
        sec.oldPath = uniPath(l);
        sec.newPath = uniPath(lines[i + 1]!);
        pairDone = true;
        i += 2;
        continue;
      }
      flush();
      newSection(null, null);
      sec!.oldPath = uniPath(l);
      sec!.newPath = uniPath(lines[i + 1]!);
      pairDone = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && sec !== null && !seenHunk) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = l.match(HUNK_RE);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: b.slice(1) });
          j++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: b.slice(1) });
          j++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: b.slice(1) });
          j++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: b.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
        else break;
      }
      sec.hunks.push({ a: parseInt(m[1]!, 10), body });
      seenHunk = true;
      i = j;
      continue;
    }
    if (sec !== null && !seenHunk) {
      if (l.startsWith('rename from ')) sec.renameOld = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) sec.renameNew = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) sec.newFileMode = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFileMode = true;
      i++;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    let eq = -1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = eq + 1;
    let rep = -1;
    while (k < n) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const repLines = applyPiece(f.lines, at, oldLines, newLines, new Map(), found.tier);
      f.lines.splice(at, oldLines.length, ...repLines);
      tree.now.set(p, joinFile(f));
    });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk (SPEC.md section 8). `at` is true when the chunk was started by an `@@` line. */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
  at: boolean;
}

function vAddEdit(path: string, contentLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, contentLines.length === 0 ? '' : contentLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTierFrom(f.lines, [ch.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      const { o, n, ctxN } = pieceON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...n);
        cursor = pos + n.length;
        continue;
      }
      const onlyEndAt = ch.eof ? f.lines.length - o.length : undefined;
      const found = findTierFrom(f.lines, o, cursor, strict, onlyEndAt);
      if (found === null) throw new Fail('no-match', path);
      const rep = applyPiece(f.lines, found.pos, o, n, ctxN, found.tier);
      f.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + n.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** V4A patches (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const sectionKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (l: string, kind: 'add' | 'delete' | 'update'): string => {
    const pre = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    return trimSpaces(l.slice(pre.length));
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = sectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = sectionPath(l, kind);
    if (kind === 'add') {
      const content: string[] = [];
      i++;
      while (i < end) {
        const c = lines[i]!;
        if (sectionKind(c) !== null) break;
        if (c === '') {
          content.push('');
          i++;
          continue;
        }
        if (c.startsWith('+')) {
          content.push(c.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(vAddEdit(path, content));
      continue;
    }
    if (kind === 'delete') {
      i++;
      let j = i;
      while (j < end && blank(lines[j]!)) j++;
      if (j < end && sectionKind(lines[j]!) === null) throw new Exit2(`error: parse ${j + 1}`);
      edits.push(vDeleteEdit(path));
      i = j;
      continue;
    }
    const updateLine = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < end && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = trimSpaces(lines[i]!.slice('*** Move to: '.length));
      i++;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    const finishChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < end) {
      const c = lines[i]!;
      if (sectionKind(c) !== null) break;
      if (c.startsWith('@@')) {
        finishChunk();
        const anchor = trimSpaces(c.slice(2));
        cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false, at: true };
        i++;
        continue;
      }
      if (c === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        finishChunk();
        i++;
        continue;
      }
      const openChunk = (): VChunk => {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, body: [], eof: false, at: false };
        }
        return cur;
      };
      if (c === '') {
        openChunk().body.push({ kind: 'ctx', text: '' });
        i++;
        continue;
      }
      const k = c[0]!;
      if (k === ' ') {
        openChunk().body.push({ kind: 'ctx', text: c.slice(1) });
        i++;
        continue;
      }
      if (k === '-') {
        openChunk().body.push({ kind: 'old', text: c.slice(1) });
        i++;
        continue;
      }
      if (k === '+') {
        openChunk().body.push({ kind: 'new', text: c.slice(1) });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    finishChunk();
    if (chunks.length > 0) {
      const lastCh = chunks[chunks.length - 1]!;
      while (lastCh.body.length > 0) {
        const b = lastCh.body[lastCh.body.length - 1]!;
        if (b.kind === 'ctx' && b.text === '') lastCh.body.pop();
        else break;
      }
      if (lastCh.anchor === null && lastCh.body.length === 0 && !lastCh.eof && !lastCh.at) chunks.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    edits.push(vUpdateEdit(path, moveTo, chunks, strict));
  }
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
