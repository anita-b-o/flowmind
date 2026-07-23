import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mapping = {
  api: "FLOWMIND_API_IMAGE",
  worker: "FLOWMIND_WORKER_IMAGE",
  web: "FLOWMIND_WEB_IMAGE",
  "ai-service": "FLOWMIND_AI_IMAGE",
  migrate: "FLOWMIND_MIGRATE_IMAGE"
};
for (const [service, variable] of Object.entries(mapping)) {
  const ref = manifest.images?.[service]?.ref;
  if (!ref || !/^[A-Za-z0-9./:@_-]+$/.test(ref)) {
    throw new Error(`Unsafe or missing image reference for ${service}`);
  }
  process.stdout.write(`${variable}=${ref}\n`);
}
process.stdout.write(`FLOWMIND_RELEASE_VERSION=${manifest.version}\n`);
process.stdout.write(`FLOWMIND_RELEASE_REVISION=${manifest.revision}\n`);
