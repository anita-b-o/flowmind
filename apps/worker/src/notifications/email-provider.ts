import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import type { ResolvedSmtpConnection } from "../connections/connection-resolver";

export type EmailSendInput = { to: string; subject: string; html: string; text: string; connection: ResolvedSmtpConnection };
export abstract class EmailProvider { abstract send(input: EmailSendInput): Promise<{ messageId?: string }>; }

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  async send(input: EmailSendInput) {
    const transporter = nodemailer.createTransport({ host: input.connection.host, port: input.connection.port, secure: input.connection.secure, auth: { user: input.connection.username, pass: input.connection.password }, connectionTimeout: 10_000, socketTimeout: 30_000 });
    const result = await transporter.sendMail({ to: input.to, from: formatFrom(input.connection.fromName, input.connection.fromEmail), subject: input.subject.replace(/[\r\n]/g, " "), html: input.html, text: input.text });
    return { messageId: result.messageId };
  }
}
function formatFrom(name: string | undefined, email: string) { return name ? `${name.replace(/[\r\n]/g, " ")} <${email}>` : email; }
