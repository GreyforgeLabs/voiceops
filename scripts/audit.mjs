#!/usr/bin/env node
// Fails on any npm audit finding that is not listed, unexpired, in security/audit-allowlist.json.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = JSON.parse(readFileSync(join(root, "security", "audit-allowlist.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execFileSync("npm", ["audit", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (error) {
  raw = error.stdout;
}
const report = JSON.parse(raw);
const vulnerabilities = Object.values(report.vulnerabilities ?? {});

const allowed = new Map(allowlist.entries.map((entry) => [entry.package, entry]));
const blocking = [];
const expired = [];
for (const vulnerability of vulnerabilities) {
  const entry = allowed.get(vulnerability.name);
  if (!entry) {
    blocking.push(vulnerability);
    continue;
  }
  if (entry.expires < today) {
    expired.push({ vulnerability, entry });
  }
}

for (const vulnerability of vulnerabilities) {
  const entry = allowed.get(vulnerability.name);
  const state = !entry ? "BLOCKING" : entry.expires < today ? "EXPIRED" : "allowed";
  console.log(`${state.padEnd(8)} ${vulnerability.name} (${vulnerability.severity})${entry ? ` - ${entry.reason}` : ""}`);
}
console.log(`audit: ${vulnerabilities.length} findings, ${blocking.length} blocking, ${expired.length} expired allowances`);

if (blocking.length > 0 || expired.length > 0) {
  process.exit(1);
}
