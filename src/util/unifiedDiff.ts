/**
 * A tiny dependency-free unified-diff generator (LCS line diff with 3 lines of context).
 * Used only to build the textual diff that goes into an AI prompt — the on-screen diff
 * viewer uses VS Code's native `vscode.diff`, so this never has to be pixel-perfect.
 *
 * To stay bounded, very large files are summarized instead of fully diffed (the LCS table
 * is O(n·m)); callers also cap the overall bundle size.
 */
const CONTEXT = 3;
const MAX_LINES = 6000; // combined old+new lines before we summarize instead

export function buildUnifiedDiff(oldText: string, newText: string, path: string): string {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (oldText === newText) return '';

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldText === '') return header + newLines.map((l) => `+${l}`).join('\n') + '\n';
  if (newText === '') return header + oldLines.map((l) => `-${l}`).join('\n') + '\n';

  if (oldLines.length + newLines.length > MAX_LINES) {
    return header + `@@ file too large to diff (${oldLines.length} → ${newLines.length} lines) @@\n`;
  }

  const ops = diffOps(oldLines, newLines);
  const hunks = toHunks(ops);
  if (hunks.length === 0) return '';
  return header + hunks.join('');
}

type Op = { kind: ' ' | '-' | '+'; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', line: a[i++] });
    } else {
      ops.push({ kind: '+', line: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] });
  while (j < m) ops.push({ kind: '+', line: b[j++] });
  return ops;
}

/** Group ops into hunks, keeping up to CONTEXT unchanged lines around each change. */
function toHunks(ops: Op[]): string[] {
  const changedIdx = ops.map((o, i) => (o.kind === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changedIdx.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) prev[1] = Math.max(prev[1], end);
    else ranges.push([start, end]);
  }

  let oldLine = 1;
  let newLine = 1;
  const counts: { oldNo: number; newNo: number }[] = [];
  for (const o of ops) {
    counts.push({ oldNo: oldLine, newNo: newLine });
    if (o.kind !== '+') oldLine++;
    if (o.kind !== '-') newLine++;
  }

  return ranges.map(([s, e]) => {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = s; k <= e; k++) {
      const o = ops[k];
      if (o.kind !== '+') oldCount++;
      if (o.kind !== '-') newCount++;
      body.push(`${o.kind}${o.line}`);
    }
    const oldStart = counts[s].oldNo;
    const newStart = counts[s].newNo;
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}\n`;
  });
}

function splitLines(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
