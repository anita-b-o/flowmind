import { Injectable } from "@nestjs/common";

export interface EmbeddedWorkerReadiness {
  status: "ready" | "not_ready";
  checks: Record<string, string>;
}

@Injectable()
export class EmbeddedWorkerHealthBridge {
  private checker?: () => Promise<EmbeddedWorkerReadiness>;
  private draining = false;

  attach(checker: () => Promise<EmbeddedWorkerReadiness>) {
    this.checker = checker;
  }

  beginShutdown() {
    this.draining = true;
  }

  async ready(): Promise<EmbeddedWorkerReadiness> {
    if (this.draining) {
      return { status: "not_ready", checks: { embeddedWorker: "draining" } };
    }
    if (!this.checker) {
      return { status: "not_ready", checks: { embeddedWorker: "unattached" } };
    }
    return this.checker();
  }
}
