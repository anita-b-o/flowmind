import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import nodemailer from "nodemailer";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { ConnectionResolver } from "../../connections/connection-resolver";

@Injectable()
export class EmailNotificationHandler implements StepHandler {
  type = StepType.EmailNotification;

  constructor(
    private readonly resolver: ExpressionResolver,
    private readonly connections: ConnectionResolver
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      to: string;
      from?: string;
      subject: string;
      text: string;
      connectionId?: string;
    };
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, string>;
    const metadata = context.metadata as Record<string, string>;
    const organizationId = runtime.organizationId ?? metadata.organizationId;
    if (config.connectionId && !organizationId) {
      throw new Error("Email connection resolution is missing organization metadata");
    }
    const connection = config.connectionId ? await this.connections.resolveSmtp(organizationId, config.connectionId) : undefined;
    const transporter = connection
      ? nodemailer.createTransport({
          host: connection.host,
          port: connection.port,
          secure: connection.secure,
          auth: { user: connection.username, pass: connection.password }
        })
      : nodemailer.createTransport({
          host: process.env.MAIL_HOST ?? "localhost",
          port: Number(process.env.MAIL_PORT ?? "1025"),
          secure: false
        });
    const info = await transporter.sendMail({
      to: config.to,
      from: connection ? formatFrom(connection.fromName, connection.fromEmail) : config.from ?? "no-reply@automation.local",
      subject: config.subject,
      text: config.text
    });

    return {
      status: StepExecutionStatus.Completed,
      output: {
        messageId: info.messageId,
        accepted: info.accepted
      }
    };
  }
}

function formatFrom(name: string | undefined, email: string) {
  return name ? `${name} <${email}>` : email;
}
