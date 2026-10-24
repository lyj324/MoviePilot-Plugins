/* Run every frontend (jsdom) test file in this directory.
 *
 *   npm install
 *   node tests/js/run.cjs
 *
 * Each test file is a separate process: the patch installs global XHR/fetch
 * hooks on the jsdom window, and a leaked window between suites makes failures
 * hard to attribute.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.cjs"))
  .sort();

if (!files.length) {
  console.error("no *.test.cjs files found");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: "inherit",
  });
  const ms = Date.now() - started;
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED ${file} (${ms}ms)`);
  } else {
    console.log(`PASSED ${file} (${ms}ms)`);
  }
}

if (failed) {
  console.error(`${failed}/${files.length} frontend test file(s) failed`);
  process.exit(1);
}
console.log(`all ${files.length} frontend test file(s) passed`);
