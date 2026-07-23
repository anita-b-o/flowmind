import { readFileSync } from "node:fs";

const source = process.argv[2];
if (!source) throw new Error("Usage: security-audit-gate.mjs <audit.json|->");
const report = JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
const counts = report.metadata?.vulnerabilities ?? {};
if ((counts.critical ?? 0) !== 0 || (counts.high ?? 0) !== 0) {
  throw new Error(`Security gate failed: critical=${counts.critical ?? 0} high=${counts.high ?? 0}`);
}
if ((counts.moderate ?? 0) > 1) {
  throw new Error(`Security gate failed: expected at most one accepted moderate, found ${counts.moderate}`);
}
if ((counts.moderate ?? 0) === 1) {
  const text = JSON.stringify(report).toLowerCase();
  if (!text.includes("@nestjs/core")) {
    throw new Error("The only accepted moderate must be the documented @nestjs/core advisory");
  }
}
process.stdout.write(`Security gate passed: critical=0 high=0 moderate=${counts.moderate ?? 0}\n`);
