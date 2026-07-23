import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path)
  throw new Error("Usage: validate-manifest.mjs <release-manifest.json>");

const manifest = JSON.parse(readFileSync(path, "utf8"));
const required = ["api", "worker", "web", "ai-service", "migrate"];
if (manifest.schemaVersion !== 2 || manifest.platform !== "linux/amd64") {
  throw new Error("Manifest must use schemaVersion 2 and platform linux/amd64");
}
if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(manifest.candidateVersion ?? "")) {
  throw new Error(
    "Manifest candidateVersion must match <major>.<minor>.<patch>-rc.<number>",
  );
}
if (!/^[0-9a-f]{40}$/.test(manifest.gitSha ?? "")) {
  throw new Error("Manifest gitSha must be a full Git SHA");
}
if (Number.isNaN(Date.parse(manifest.createdAt ?? ""))) {
  throw new Error("Manifest createdAt must be an ISO timestamp");
}
for (const service of required) {
  const image = manifest.images?.[service];
  if (
    !image ||
    !/^ghcr\.io\/anita-b-o\/flowmind-[a-z-]+@sha256:[0-9a-f]{64}$/.test(
      image.ref ?? "",
    )
  ) {
    throw new Error(
      `Manifest image ${service} must be a GHCR reference pinned by digest`,
    );
  }
  if (image.ref !== `${image.repository}@${image.digest}`) {
    throw new Error(
      `Manifest image ${service} has inconsistent repository, digest, and ref fields`,
    );
  }
}
if (
  Object.keys(manifest.images).sort().join(",") !== required.sort().join(",")
) {
  throw new Error("Manifest contains an unexpected image set");
}

process.stdout.write(`${manifest.candidateVersion} ${manifest.gitSha}\n`);
