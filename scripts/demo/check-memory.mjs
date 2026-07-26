import process from "node:process";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) {
  throw new Error("Usage: node scripts/demo/check-memory.mjs <pid>");
}
const seconds = integerEnv("FLOWMIND_MEMORY_SAMPLE_SECONDS", 1800, 10, 7200);
const peakLimitMiB = integerEnv("FLOWMIND_MEMORY_PEAK_LIMIT_MIB", 430, 128, 4096);
const samples = [];

for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
  const status = await readStatus(pid);
  samples.push(status.rssMiB);
  if (status.rssMiB > peakLimitMiB) {
    throw new Error(`RSS ${status.rssMiB} MiB exceeded ${peakLimitMiB} MiB`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.info("demo.memory.gate.passed", {
  pid,
  samples: samples.length,
  peakRssMiB: Math.max(...samples),
  averageRssMiB: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
});

async function readStatus(targetPid) {
  const text = await import("node:fs/promises").then(({ readFile }) =>
    readFile(`/proc/${targetPid}/status`, "utf8")
  );
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error(`Could not read RSS for PID ${targetPid}`);
  return { rssMiB: Math.ceil(Number(match[1]) / 1024) };
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
