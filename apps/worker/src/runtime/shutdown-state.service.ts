import { Injectable } from "@nestjs/common";

@Injectable()
export class ShutdownStateService {
  private shuttingDown = false;

  beginShutdown() {
    this.shuttingDown = true;
  }

  isShuttingDown() {
    return this.shuttingDown;
  }
}
