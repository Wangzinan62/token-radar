// Token Launch Radar: the program behind the token-radar-01 entry (Node 22, standard library only).
//
//   node main.ts [--input <snapshot.json|directory>] [--output <directory>]
//
// It reads the sealed snapshot (default /input/snapshot.json; locally, --input names the file or the
// directory holding it), scores every pre-token protocol with the comparables model in lib/model.ts,
// and writes into the output directory (default /output, or $MAKEFUN_OUTPUT_DIR):
//
//   board.json    the ranked board the gate reads: every watchlist protocol plus the strongest
//                 below-floor pre-token protocols, each with its farm plan
//   data.js       window.RADAR_DATA, the dashboard's whole dataset, written beside the page
//   dashboard/    this repository's static dashboard, copied
//   screenshots/  this repository's screenshots, copied
//   dossier.json  the judge's dossier, written last with the vendored buildDossier, byte for byte
//                 what the scorer rebuilds from the same output
//
// The board is checked against the gate's shape before anything is written: a board the gate would
// refuse fails the run instead of handing in an invalid entry. The program is deterministic: the
// same snapshot in gives the same bytes out, on every run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The dossier caps the scorer holds the output to; only the text cap shapes any bytes. */
const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
} as const;

/** A screenshot's name as the dossier accepts it: a letter, digit or _ first, then . _ - too. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>` in the arguments, else the fallback. */
function argument(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const glued = args.find((a) => a.startsWith(`--${name}=`));
  return glued === undefined ? fallback : glued.slice(name.length + 3);
}

/** Copy a directory's regular files into the output, skipping dot-names; returns what was copied. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = argument('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  const outDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, data } = buildBoard(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model produced a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(data));

  // Clear any earlier run's copies first: the dossier is built from whatever the output holds, so a
  // stale dashboard or screenshot file would change its bytes and break run-to-run determinism.
  rmSync(join(outDir, 'dashboard'), { recursive: true, force: true });
  rmSync(join(outDir, 'screenshots'), { recursive: true, force: true });
  const pageFiles = copyTree(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
  const shots = copyTree(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));
  if (shots.length < 3 || shots.length > 4) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3 or 4 (the board, a detail view, a filtered view)\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }

  // The dossier goes last: it is built from the finished output, exactly as the scorer rebuilds it.
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, DOSSIER_CAPS));

  process.stdout.write(
    `token radar: snapshot of ${snapshot.as_of}: ${snapshot.protocols.length} protocols, ` +
      `${data.stats.pre_token} pre-token, ${data.stats.comparables} tokenized comparables\n` +
      `token radar: board of ${board.length} rows (all ${snapshot.watchlist.length} watchlist, ${data.stats.early} early below the floor), ` +
      `global multiple ${data.global_multiple}x TVL\n` +
      `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images), dossier.json\n`,
  );
}

main();
