/**
 * Command-line wrapper around soundbankLevels, run by
 * `scripts/build_orchestra_sf3.py` from `frontend/`:
 *
 *   npx tsx src/lib/soundbankLevelsCli.ts jobs.json results.json
 *
 * jobs.json: `{ "banks": { "<key>": "<path to .sf2/.sf3>" },
 *               "jobs": [{ "id", "bankKey", "bank", "program", "note",
 *                          "velocity", "cc1", "seconds"? }] }`
 * results.json: `{ "<id>": LevelResult }`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadBank, measureLevel, type LevelJob, type LevelResult } from './soundbankLevels.ts';

interface CliJob extends LevelJob {
  id: string;
  bankKey: string;
}

async function main(argv: string[]): Promise<number> {
  const [jobsPath, outPath] = argv;
  if (!jobsPath || !outPath) {
    console.error('usage: soundbankLevelsCli.ts jobs.json results.json');
    return 2;
  }
  const spec = JSON.parse(readFileSync(jobsPath, 'utf-8')) as { banks: Record<string, string>; jobs: CliJob[] };
  const banks = new Map<string, ReturnType<typeof loadBank>>();
  for (const [key, path] of Object.entries(spec.banks)) {
    const buf = readFileSync(path);
    banks.set(key, loadBank(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
  }
  const out: Record<string, LevelResult> = {};
  for (const job of spec.jobs) {
    const bank = banks.get(job.bankKey);
    if (!bank) throw new Error(`job ${job.id}: no bank ${job.bankKey}`);
    out[job.id] = await measureLevel(bank, job);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
