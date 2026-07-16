import { Injectable, OnApplicationShutdown } from "@nestjs/common";

@Injectable()
export class ShutdownStateService implements OnApplicationShutdown {
  private shuttingDown = false;

  onApplicationShutdown() {
    this.shuttingDown = true;
  }

  isShuttingDown() {
    return this.shuttingDown;
  }
}
