// main.ts is mend, the CLI SPEC.md specifies. It implements the whole specification: the command line,
// the output and exit codes, safe paths, format detection, the three matching tiers, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) recorded by move edits that succeeded, for the `R` output lines. */
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

/** One hunk or chunk: old lines O, new lines N, and for each line of N the index in O when it is a context line, else -1. */
interface Block {
  oldLines: string[];
  newLines: string[];
  newCtx: number[];
}

/** Lines equal at a tier (SPEC.md section 5): 0 exact, 1 trailing spaces and tabs removed, 2 both ends removed. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in the file's lines at a tier. */
function occurrences(file: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(file[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict: 0 only) with an occurrence at or after `from`, and its positions. */
function findTier(file: string[], O: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const pos = occurrences(file, O, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/**
 * The lines that replace the file's lines at `pos`: a context line of N is the file's own matched line,
 * every other line is written as it is, re-indented at tier 2 (SPEC.md section 5).
 */
function buildReplacement(file: string[], pos: number, b: Block, tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWS(file[pos] ?? '') : '';
  const p = tier === 2 ? leadWS(b.oldLines[0] ?? '') : '';
  for (let k = 0; k < b.newLines.length; k++) {
    const ci = b.newCtx[k]!;
    if (ci >= 0) {
      out.push(file[pos + ci]!);
    } else {
      let line = b.newLines[k]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
      out.push(line);
    }
  }
  return out;
}

/** Raw body lines (each starting with ` `, `-`, `+`, or empty) as a block. */
function bodyToBlock(raw: string[]): Block {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const newCtx: number[] = [];
  for (const l of raw) {
    if (l.startsWith(' ')) {
      const text = l.slice(1);
      newCtx.push(oldLines.length);
      oldLines.push(text);
      newLines.push(text);
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newCtx.push(-1);
      newLines.push(l.slice(1));
    } else {
      // An empty raw line is a context line whose text is empty.
      newCtx.push(oldLines.length);
      oldLines.push('');
      newLines.push('');
    }
  }
  return { oldLines, newLines, newCtx };
}

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk extends Block {
  /** The hunk header's A (the old file's start line, 1-based). */
  a: number;
  /** A `\` line follows the hunk's last context or `+` body line. */
  noNL: boolean;
  /** How many `+` lines the hunk holds. */
  plusCount: number;
  /** A `\` line follows the hunk's last `+` body line (false when plusCount is 0). */
  plusNoNL: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, `a/` or `b/` stripped, `/dev/null` as no file. */
function parseHeaderPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  const stripped = t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
  return stripped === '/dev/null' ? null : stripped;
}

/** The path after `rename from ` or `rename to `: up to the first tab, surrounding spaces removed. */
function parseRenamePath(s: string): string {
  return s.split('\t')[0]!.trim();
}

function buildHunk(a: number, raw: string[]): Hunk {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const newCtx: number[] = [];
  let plusCount = 0;
  const backslashAfter: boolean[] = new Array<boolean>(raw.length).fill(false);
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    if (l.startsWith('\\')) {
      if (i > 0) backslashAfter[i - 1] = true;
      continue;
    }
    if (l.startsWith(' ')) {
      const text = l.slice(1);
      newCtx.push(oldLines.length);
      oldLines.push(text);
      newLines.push(text);
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      plusCount += 1;
      newCtx.push(-1);
      newLines.push(l.slice(1));
    } else {
      newCtx.push(oldLines.length);
      oldLines.push('');
      newLines.push('');
    }
  }
  let noNL = false;
  let plusNoNL = false;
  for (let i = raw.length - 1; i >= 0; i--) {
    const l = raw[i]!;
    if (l.startsWith('+')) {
      plusNoNL = backslashAfter[i]!;
      break;
    }
  }
  for (let i = raw.length - 1; i >= 0; i--) {
    const l = raw[i]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) {
      noNL = backslashAfter[i]!;
      break;
    }
  }
  return { oldLines, newLines, newCtx, a, noNL, plusCount, plusNoNL };
}

function parseUnified(lines: string[]): USection[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let body: { a: number; raw: string[] } | null = null;
  const finishBody = (): void => {
    if (body === null || cur === null) return;
    const raw = body.raw;
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    cur.hunks.push(buildHunk(body.a, raw));
    body = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (body !== null) {
      // A body ends at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line (those two start
      // the next section, and they look like `-` and `+` body lines), and at the first other line.
      const isDiffGit = line.startsWith('diff --git ');
      const isSectionHeader = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      if (isDiffGit || isSectionHeader) {
        finishBody();
      } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        body.raw.push(line);
        i++;
        continue;
      } else {
        finishBody();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deleted: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const inHeader = cur !== null && cur.hunks.length === 0;
      const next = lines[i + 1];
      if (inHeader) {
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.oldPath = parseHeaderPath(line.slice(4));
        cur!.newPath = parseHeaderPath(next.slice(4));
        i += 2;
        continue;
      }
      if (next !== undefined && next.startsWith('+++ ')) {
        cur = { oldPath: parseHeaderPath(line.slice(4)), newPath: parseHeaderPath(next.slice(4)), newFile: false, deleted: false, hunks: [] };
        sections.push(cur);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) cur.newPath = parseHeaderPath(line.slice(4));
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (cur !== null && cur.hunks.length === 0) cur.oldPath = parseRenamePath(line.slice('rename from '.length));
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (cur !== null && cur.hunks.length === 0) cur.newPath = parseRenamePath(line.slice('rename to '.length));
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (cur !== null && cur.hunks.length === 0) cur.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (cur !== null && cur.hunks.length === 0) cur.deleted = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      body = { a: parseInt(m[1]!, 10), raw: [] };
      i++;
      continue;
    }
    i++;
  }
  finishBody();
  return sections;
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const isCreate = sec.newFile || sec.oldPath === null;
    const isDelete = sec.deleted || sec.newPath === null;
    if (isCreate) {
      const p = sec.newPath;
      if (p === null) throw new Fail('unsafe', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (let k = 0; k < h.newLines.length; k++) {
          if (h.newCtx[k] === -1) plus.push(h.newLines[k]!);
        }
      }
      let noNL = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        if (sec.hunks[hi]!.plusCount > 0) {
          noNL = sec.hunks[hi]!.plusNoNL;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath;
      if (p === null) throw new Fail('unsafe', '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const split = splitText(before);
    let fileLines = split.lines;
    let final = split.final;
    const br = split.br;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.oldLines.length > 0) {
        const found = findTier(fileLines, h.oldLines, strict, 0);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.pos) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const pos = best;
        const rep = buildReplacement(fileLines, pos, h, found.tier);
        const runsToEnd = pos + h.oldLines.length === fileLines.length;
        fileLines = [...fileLines.slice(0, pos), ...rep, ...fileLines.slice(pos + h.oldLines.length)];
        if (runsToEnd) final = !h.noNL;
        d += h.newLines.length - h.oldLines.length;
      } else {
        const at = Math.min(Math.max(h.a + d, 0), fileLines.length);
        const rep = buildReplacement(fileLines, at, h, 0);
        const atEnd = at === fileLines.length;
        fileLines = [...fileLines.slice(0, at), ...rep, ...fileLines.slice(at)];
        if (atEnd) final = !h.noNL;
        d += h.newLines.length;
      }
    }
    const out = joinText(fileLines, br, final);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const split = splitText(before);
    const found = findTier(split.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const block: Block = { oldLines: b.oldLines, newLines: b.newLines, newCtx: b.newLines.map(() => -1) };
    const rep = buildReplacement(split.lines, pos, block, found.tier);
    const out = [...split.lines.slice(0, pos), ...rep, ...split.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinText(out, split.br, split.final));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk extends Block {
  anchor: string | null;
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  line: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const secLine = i + 1;
    i++;
    if (kind === 'add') {
      const rawAdd: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          rawAdd.push(l);
          i++;
          continue;
        }
        if (blank(l)) {
          rawAdd.push(l);
          i++;
          continue;
        }
        if (sectionStart(l) !== null) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (rawAdd.length > 0 && blank(rawAdd[rawAdd.length - 1]!)) rawAdd.pop();
      sections.push({ kind: 'add', path, moveTo: null, addLines: rawAdd.map((l) => (l.startsWith('+') ? l.slice(1) : '')), chunks: [], line: secLine });
      continue;
    }
    if (kind === 'delete') {
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [], line: secLine });
      continue;
    }
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: Array<{ anchor: string | null; eof: boolean; raw: string[] }> = [];
    let cur: { anchor: string | null; eof: boolean; raw: string[] } | null = null;
    const startChunk = (anchor: string | null): void => {
      cur = { anchor, eof: false, raw: [] };
      chunks.push(cur);
    };
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        startChunk(anchor === '' ? null : anchor);
        i++;
        continue;
      }
      if (sectionStart(l) !== null) break;
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l)) {
        if (cur === null) startChunk(null);
        cur!.raw.push(l);
        i++;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        cur = null;
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (chunks.length > 0) {
      const lc = chunks[chunks.length - 1]!;
      while (lc.raw.length > 0 && blank(lc.raw[lc.raw.length - 1]!)) lc.raw.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    sections.push({
      kind: 'update',
      path,
      moveTo,
      addLines: [],
      chunks: chunks.map((c) => ({ ...bodyToBlock(c.raw), anchor: c.anchor, eof: c.eof })),
      line: secLine,
    });
  }
  return sections;
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const split = splitText(before);
    let fileLines = split.lines;
    const br = split.br;
    const final = split.final;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findTier(fileLines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.oldLines.length > 0) {
        const found = findTier(fileLines, ch.oldLines, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos: number | null = null;
        for (const p of found.pos) {
          if (!ch.eof || p + ch.oldLines.length === fileLines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', sec.path);
        const rep = buildReplacement(fileLines, pos, ch, found.tier);
        fileLines = [...fileLines.slice(0, pos), ...rep, ...fileLines.slice(pos + ch.oldLines.length)];
        cursor = pos + rep.length;
      } else {
        const at = ch.eof ? fileLines.length : cursor;
        const rep = buildReplacement(fileLines, at, ch, 0);
        fileLines = [...fileLines.slice(0, at), ...rep, ...fileLines.slice(at)];
        cursor = at + rep.length;
      }
    }
    const out = joinText(fileLines, br, final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => v4aSectionEdit(sec, strict));
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; text: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.get(oldP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${c} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
