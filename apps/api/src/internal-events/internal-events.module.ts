import { Global, Module } from "@nestjs/common";
import { InternalEventEmitter } from "./internal-event-emitter.service";
import { MetricsModule } from "../metrics/metrics.module";

@Global()
@Module({ imports: [MetricsModule], providers: [InternalEventEmitter], exports: [InternalEventEmitter] })
export class InternalEventsModule {}
