// Entry point: node src/run.ts --help. Exit 0 when the result files are written, 1 on a failed run,
// 2 on bad flags.

import { parseCli, runCli, USAGE, type CliOptions } from './cli.ts';

let opts: CliOptions;
try {
  opts = parseCli(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}
try {
  const { files, report } = await runCli(opts);
  process.stdout.write(`Wrote ${files.json}\nWrote ${files.summary}\nKill switch: ${report.kill_switch.note}\n`);
} catch (err) {
  process.stderr.write(`HomeTruth run failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
