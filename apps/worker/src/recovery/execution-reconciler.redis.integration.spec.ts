import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "@automation/config";
import { recoveryJobId } from "./execution-reconciler.service";

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRedis("Execution reconciler recovery job IDs with retained BullMQ jobs", () => {
  it("executes a recovery job while the completed canonical job remains retained", async () => {
    const queueName = `flowmind-recovery-${process.pid}-${Date.now()}`;
    const connection = redisConnectionOptions(process.env.REDIS_URL!);
    const queue = new Queue(queueName, { connection });
    const processed: string[] = [];
    const worker = new Worker(
      queueName,
      async (job) => {
        processed.push(String(job.id));
      },
      { connection }
    );

    try {
      const executionId = "retained-canonical";
      const canonicalId = `execution-${executionId}`;
      await queue.add("run", { executionId }, {
        jobId: canonicalId,
        removeOnComplete: 1000,
        removeOnFail: false
      });
      await waitFor(() => processed.includes(canonicalId));
      expect(await queue.getJob(canonicalId)).not.toBeNull();

      const recoveryId = recoveryJobId(executionId, "queued_job_recovered", 4);
      await queue.add("run", { executionId }, {
        jobId: recoveryId,
        removeOnComplete: 1000,
        removeOnFail: false
      });
      await waitFor(() => processed.includes(recoveryId));

      expect(processed).toEqual(expect.arrayContaining([canonicalId, recoveryId]));
      expect(await queue.getJob(canonicalId)).not.toBeNull();
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for BullMQ job");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
