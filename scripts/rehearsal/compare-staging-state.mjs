import { readFileSync } from "node:fs";

const before = JSON.parse(readFileSync(process.argv[2], "utf8"));
const after = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (before.organizationId !== after.organizationId) throw new Error("Organization changed during upgrade");

for (const collection of ["workflows", "executions", "approvals", "templates", "notifications", "triggers"]) {
  const afterById = new Map(after[collection].map((item) => [item.id, item]));
  for (const item of before[collection]) {
    const current = afterById.get(item.id);
    if (!current) throw new Error(`${collection} item ${item.id} was lost during upgrade`);
    for (const [key, value] of Object.entries(item)) {
      if (key === "status" && collection === "approvals") continue;
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
        throw new Error(`${collection} item ${item.id} changed field ${key}`);
      }
    }
  }
}
process.stdout.write("Historical staging state preserved\n");
