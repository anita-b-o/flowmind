import { Injectable } from "@nestjs/common";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

@Injectable()
export class WorkerIdentityService {
  readonly id = `${hostname()}:${process.pid}:${randomUUID()}`;
}
