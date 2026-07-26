import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { ResolvedSmtpConnection } from "../connections/connection-resolver";

export type EmailSendInput = { to: string; subject: string; html: string; text: string; connection?: ResolvedSmtpConnection };
export abstract class EmailProvider {
  abstract readonly requiresConnection: boolean;
  abstract send(input: EmailSendInput): Promise<{ messageId?: string }>;
}

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  readonly requiresConnection = true;
  async send(input: EmailSendInput) {
    if (!input.connection) throw new Error("SMTP connection is required");
    const transporter = nodemailer.createTransport({ host: input.connection.host, port: input.connection.port, secure: input.connection.secure, auth: { user: input.connection.username, pass: input.connection.password }, connectionTimeout: 10_000, socketTimeout: 30_000 });
    const result = await transporter.sendMail({ to: input.to, from: formatFrom(input.connection.fromName, input.connection.fromEmail), subject: input.subject.replace(/[\r\n]/g, " "), html: input.html, text: input.text });
    return { messageId: result.messageId };
  }
}

@Injectable()
export class EmbeddedFakeEmailProvider implements EmailProvider {
  readonly requiresConnection = false;

  async send(input: EmailSendInput) {
    const digest = createHash("sha256")
      .update(`${input.to}\n${input.subject}\n${input.text}`)
      .digest("hex")
      .slice(0, 24);
    return { messageId: `flowmind-demo-${digest}` };
  }
}
function formatFrom(name: string | undefined, email: string) { return name ? `${name.replace(/[\r\n]/g, " ")} <${email}>` : email; }
