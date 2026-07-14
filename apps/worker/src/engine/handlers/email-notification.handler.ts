import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import nodemailer from "nodemailer";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";

@Injectable()
export class EmailNotificationHandler implements StepHandler {
  type = StepType.EmailNotification;

  constructor(private readonly resolver: ExpressionResolver) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      to: string;
      from?: string;
      subject: string;
      text: string;
    };
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST ?? "localhost",
      port: Number(process.env.MAIL_PORT ?? "1025"),
      secure: false
    });
    const info = await transporter.sendMail({
      to: config.to,
      from: config.from ?? "no-reply@automation.local",
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
