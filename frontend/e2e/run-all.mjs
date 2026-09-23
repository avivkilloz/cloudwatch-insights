/**
 * Runs the suites one after another and prints a line each.
 *
 * Sequentially on purpose: they share one backend and one admin account, and
 * each starts by clearing the workspace, so two at once would clear each
 * other's sessions out from under them.
 *
 *   node e2e/run-all.mjs          every suite
 *   node e2e/run-all.mjs 29 33    just those two
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const wanted = process.argv.slice(2);

const suites = readdirSync(here)
  .filter((f) => /^smoke\d+\.mjs$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
  .filter((f) => wanted.length === 0 || wanted.includes(f.match(/\d+/)[0]));

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${here}${file}`], { encoding: "utf-8" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let red = 0;
for (const file of suites) {
  const { code, out } = await run(file);
  const tally = out.match(/\d+ passed, \d+ failed/);
  console.log(`${file.replace(".mjs", "")}: ${tally ? tally[0] : "CRASHED"}`);
  // Only the failures, so a green run stays one line per suite.
  for (const line of out.split("\n").filter((l) => /^FAIL|^SMOKE TEST FAILED|^PAGE ERROR/.test(l))) {
    console.log(`  ${line}`);
  }
  if (code !== 0) red += 1;
}

console.log(`\n${suites.length - red} of ${suites.length} suites green`);
process.exit(red === 0 ? 0 : 1);
