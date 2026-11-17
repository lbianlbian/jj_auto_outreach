// Offline dry run: the real src/ pipeline against a fake Sheet, fake Shovels, DNS and Gmail.
// Free and safe: no network, no credits, no email. Usage (from gas/):
//   npm run dry-run                       # dailyRun
//   npm run dry-run -- sendPendingEmails  # any key of DRY_RUN_ENTRIES in src/dryrun/dry_run.js
const {loadGas} = require('../test/gas');

// The pipeline's own console.log lines, indented between the [dry run] actions (which go
// through `print`, not this console).
const pipelineConsole = {
  log: (...args) => console.log(`    log: ${args.join(' ')}`),
  warn: (...args) => console.warn(`    warn: ${args.join(' ')}`),
  error: console.error,
};

const gas = loadGas({console: pipelineConsole});
const report = gas.dryRunOnFakeSheet_(process.argv[2] || 'dailyRun', {print: text => console.log(text)});
process.exitCode = report.error ? 1 : 0;
