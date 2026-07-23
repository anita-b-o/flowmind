import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [manifestPath, goRecordPath] = process.argv.slice(2);
if (!manifestPath || !goRecordPath) {
  throw new Error(
    "Usage: validate-go-record.mjs <release-manifest.json> <go-record.md>",
  );
}

const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const record = readFileSync(goRecordPath, "utf8");

const field = (name) => {
  const match = record.match(new RegExp(`^- ${name}:\\s*(\\S+)\\s*$`, "m"));
  if (!match) throw new Error(`GO record must define '- ${name}: <value>'`);
  return match[1];
};

if (field("Candidate version") !== manifest.candidateVersion) {
  throw new Error(
    "GO record candidate version does not match the release manifest",
  );
}
if (field("Git SHA") !== manifest.gitSha) {
  throw new Error("GO record Git SHA does not match the release manifest");
}
if (field("Planned annotated tag") !== `v${manifest.candidateVersion}`) {
  throw new Error("GO record planned tag does not match the release manifest");
}

const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
if (field("Release manifest SHA-256") !== manifestSha256) {
  throw new Error(
    "GO record manifest checksum does not match the release manifest",
  );
}

const decisionStart = record.indexOf("## Decision");
if (decisionStart === -1)
  throw new Error("GO record is missing the Decision section");
const gates = record.slice(0, decisionStart);
const decision = record.slice(decisionStart);

const gateCheckboxes = gates.match(/^- \[[xX ]\]/gm) ?? [];
if (gateCheckboxes.length !== 32) {
  throw new Error(
    "GO record must contain the complete 32-item gate and risk checklist",
  );
}
if (/^- \[ \]/m.test(gates)) {
  throw new Error(
    "GO record has an incomplete mandatory gate or risk acceptance",
  );
}
if (!/^- \[[xX]\] GO\s*$/m.test(decision)) {
  throw new Error("GO decision must be checked");
}
if (!/^- \[ \] NO-GO\s*$/m.test(decision)) {
  throw new Error("NO-GO decision must remain unchecked");
}

process.stdout.write(
  `${manifest.candidateVersion} ${manifest.gitSha} ${manifestSha256}\n`,
);
