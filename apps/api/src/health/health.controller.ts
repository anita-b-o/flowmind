import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  getHealth() {
    return this.getLive();
  }

  @Get("live")
  getLive() {
    return { status: "live", service: "api", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async getReady() {
    const result = await this.health.ready();
    if (result.status !== "ready") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
