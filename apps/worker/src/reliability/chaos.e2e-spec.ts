import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { ExecutionLeaseService } from "../engine/execution-lease.service";
import { ExecutionReconcilerService } from "../recovery/execution-reconciler.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";

const prisma = new PrismaClient();
const queueName = `rc1-chaos-${process.pid}`;
const connection = { host: "127.0.0.1", port: Number(new URL(process.env.REDIS_URL!).port) };

const describeChaos = process.env.CHAOS_COMPOSE_PROJECT && process.env.CHAOS_COMPOSE_FILE ? describe : describe.skip;

describeChaos("RC1 real infrastructure chaos and recovery", () => {
  beforeAll(async () => { await clean(); }, 30_000);
  afterAll(async () => { await clean(); await prisma.$disconnect(); }, 30_000);

  it("rejects duplicate BullMQ delivery and lets two workers claim each logical job once", async () => {
    const queue = new Queue(queueName, { connection }); const seen = new Map<string, number>();
    const workers = ["one", "two"].map(() => new Worker(queueName, async (job) => { seen.set(job.data.logicalId, (seen.get(job.data.logicalId) ?? 0) + 1); }, { connection }));
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    await queue.add("run", { logicalId: "same" }, { jobId: "deterministic-same" });
    await queue.add("run", { logicalId: "same" }, { jobId: "deterministic-same" });
    await poll(() => seen.get("same") === 1);
    expect(seen.get("same")).toBe(1);
    await Promise.all(workers.map((worker) => worker.close())); await queue.close();
  }, 20_000);

  it("recovers Redis after outage and processes new work", async () => {
    const queueNameForTest = `${queueName}-redis`;
    compose("stop", "redis");
    const unavailable = new Redis({ ...connection, lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    await expect(unavailable.connect().then(() => unavailable.ping())).rejects.toBeDefined(); unavailable.disconnect();
    compose("start", "redis"); await waitRedis();
    const queue = new Queue(queueNameForTest, { connection }); let processed = false; const worker = new Worker(queueNameForTest, async () => { processed = true; }, { connection }); await worker.waitUntilReady();
    await queue.add("run", { value: 2 }, { jobId: "after-recovery" }); await poll(() => processed);
    await worker.close(); await queue.close();
  }, 30_000);

  it("surfaces PostgreSQL outage and reconnects without losing durable state", async () => {
    const fixture = await seedExecution("postgres-recovery");
    compose("stop", "postgres");
    await expect(prisma.execution.findUnique({ where: { id: fixture.execution.id } })).rejects.toBeDefined();
    compose("start", "postgres"); await poll(async () => { try { await prisma.$queryRaw`SELECT 1`; return true; } catch { return false; } }, 20_000);
    expect(await prisma.execution.findUnique({ where: { id: fixture.execution.id } })).toMatchObject({ status: "QUEUED" });
  }, 30_000);

  it("allows only one execution lease, detects loss, and recovers an expired lease", async () => {
    const fixture = await seedExecution("lease");
    const first = new ExecutionLeaseService(prisma as any, { id: "worker-a" } as any);
    const second = new ExecutionLeaseService(prisma as any, { id: "worker-b" } as any);
    expect(await Promise.all([first.acquire(fixture.execution.id, fixture.organization.id), second.acquire(fixture.execution.id, fixture.organization.id)])).toContain(true);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: fixture.execution.id } })).runAttempt).toBe(1);
    await prisma.execution.update({ where: { id: fixture.execution.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await expect(first.assertOwned(fixture.execution.id)).rejects.toThrow("lease");
    const queue = new Queue(`${queueName}-reconcile`, { connection });
    await new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), queue as any).reconcile();
    await poll(async () => Boolean(await queue.getJob(`execution-${fixture.execution.id}`)));
    expect(await prisma.execution.findUnique({ where: { id: fixture.execution.id } })).toMatchObject({ status: "QUEUED", lockedBy: null, lockedUntil: null });
    await queue.close();
  }, 20_000);

  it("worker restart preserves pending jobs and SIGTERM drains active work", async () => {
    const restartQueue = new Queue(`${queueName}-restart`, { connection });
    await restartQueue.add("run", { id: "pending" }, { jobId: "pending-on-restart" });
    let processed = false; const restarted = new Worker(`${queueName}-restart`, async () => { processed = true; }, { connection });
    await restarted.waitUntilReady(); await poll(() => processed); await restarted.close(); await restartQueue.close();

    const child = signalWorker(); await waitForLine(child, "active");
    child.kill("SIGTERM"); await waitForLine(child, "draining"); expect(child.exitCode).toBeNull();
    child.stdin!.write("release\n"); await waitForExit(child, 5_000); expect(child.exitCode).toBe(0);
  }, 20_000);
});

function compose(...args: string[]) { execFileSync("docker", ["compose", "-p", process.env.CHAOS_COMPOSE_PROJECT!, "-f", process.env.CHAOS_COMPOSE_FILE!, ...args], { stdio: "ignore" }); }
async function waitRedis() { await poll(async () => { const redis = new Redis({ ...connection, lazyConnect: true, connectTimeout: 250, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null }); try { await redis.connect(); return await redis.ping() === "PONG"; } catch { return false; } finally { redis.disconnect(); } }, 20_000); }
async function poll(check: () => boolean | Promise<boolean>, timeout = 10_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await delay(25); } throw new Error(`Condition not met within ${timeout}ms`); }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signalWorker() { const source = `let draining=false;console.log('active');process.on('SIGTERM',()=>{draining=true;console.log('draining')});process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{if(draining&&value.includes('release'))process.exit(0)});`; return spawn(process.execPath, ["-e", source], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }); }
async function waitForLine(child: ChildProcess, expected: string) { const state = child as ChildProcess & { rcOutput?: string; rcListening?: boolean }; state.rcOutput ??= ""; if (!state.rcListening) { state.rcListening = true; child.stdout!.on("data", (chunk) => { state.rcOutput += chunk; }); child.stderr!.on("data", (chunk) => { state.rcOutput += chunk; }); } await poll(() => Boolean(state.rcOutput?.includes(expected)), 5_000).catch(() => { throw new Error(`Child did not emit ${expected}: ${state.rcOutput}`); }); }
async function waitForExit(child: ChildProcess, timeout: number) { if (child.exitCode !== null) return; await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Child did not exit")), timeout); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
async function seedExecution(name: string) { const suffix = `${name}-${Date.now()}-${Math.random()}`; const organization = await prisma.organization.create({ data: { name, slug: suffix } }); const user = await prisma.user.create({ data: { email: `${suffix}@example.com`, name, passwordHash: "hash" } }); const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name, createdByUserId: user.id } }); const execution = await prisma.execution.create({ data: { organizationId: organization.id, workflowId: workflow.id, status: "QUEUED", inputJson: {}, contextJson: {} } }); return { organization, execution }; }
async function clean() { await prisma.execution.deleteMany(); await prisma.workflow.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany(); }
