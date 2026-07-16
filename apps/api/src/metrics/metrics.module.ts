import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { HttpMetricsMiddleware } from "./http-metrics.middleware";
import { ApiMetricsService } from "./metrics.service";

@Global()
@Module({
  providers: [ApiMetricsService, HttpMetricsMiddleware],
  exports: [ApiMetricsService]
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes("*");
  }
}
