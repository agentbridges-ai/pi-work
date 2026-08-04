#!/usr/local/bin/node

const { spawnSync } = require("node:child_process");

const input = process.argv.slice(2);
const args = [];
for (let index = 0; index < input.length; index += 1) {
  if (input[index] === "--dev" && input[index + 1] === "/dev") {
    args.push("--ro-bind", "/dev", "/dev");
    index += 1;
  } else {
    args.push(input[index]);
  }
}

const result = spawnSync("/usr/bin/bwrap", args, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(127);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
  process.exit(128);
}
process.exit(result.status ?? 1);
