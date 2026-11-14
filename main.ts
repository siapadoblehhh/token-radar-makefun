// Token Radar, model radar-2: a program that reads the sealed DefiLlama snapshot and writes the
// ranked board, the dashboard's data, the dashboard itself, its three screenshots and the dossier
// the judge reads.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// It runs in a container with no network, a read-only repository and a writable /output, on 1 CPU
// and 120 seconds. It runs twice, and both runs must write the same bytes: the model is a pure
// function of the snapshot, the sort breaks every tie on slug, and nothing reads a clock or a
// random source.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The pipeline, in order, and why each step is where it is.
//
//   1. Read the snapshot. The input is a file (--input) or a directory holding snapshot.json
//      (the sealed /input in the grader's container). A missing snapshot exits with code 2
//      and a message naming the path, because a radar with no snapshot has nothing to rank.
//   2. Score it. parseSnapshot validates the shape, buildRadar scores the board and the live
//      set, and boardIssue refuses a board the gate will not take. A bad board exits with
//      code 1 before anything is written, so a broken model never reaches the dossier.
//   3. Write the data. board.json carries the full board (every row, with its model and its
//      farm plan); data.js carries the dashboard's compact dataset as window.RADAR. Both are
//      written before the dashboard is copied, because the dashboard reads data.js and the
//      dossier is built from the finished /output.
//   4. Copy the dashboard and the screenshots. The dashboard's files and the three
//      screenshots are copied byte-for-byte from the repository. Fewer than three screenshots
//      exits with code 1, and a bad screenshot name is refused, because the gate counts the
//      images and the dossier names them.
//   5. Build the dossier last. The dossier is rebuilt from the finished /output and compared
//      byte-for-byte by the grader, so it must be written after everything it describes.
//      Writing it first would describe a directory that does not yet exist.

/** The scorer's own caps: the text cap shapes the dossier's bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossierBytes = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
writeFileSync(join(out, 'dossier.json'), dossierBytes);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: rank 1 is ${board[0]!.name} at $${board[0]!.implied_value_usd.toLocaleString('en-US')} implied, rank ${board.length} is ${board[board.length - 1]!.name} at $${board[board.length - 1]!.implied_value_usd.toLocaleString('en-US')}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')} (${dossierBytes.length.toLocaleString('en-US')} bytes)\n`,
);
