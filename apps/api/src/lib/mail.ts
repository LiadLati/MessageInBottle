import nodemailer, { type Transporter } from 'nodemailer';
import type { MailConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// Provider-neutral outbound mail. The application only ever calls `send`; which provider is
// behind it is decided by configuration (MIB_MAIL_PROVIDER), never by the calling code.
export interface Mailer {
  readonly kind: MailConfig['provider'];
  send(message: MailMessage): Promise<void>;
}

// Development only: messages are captured in memory so the full password-recovery flow can be
// exercised locally. It is never constructed outside dev mode (loadMailConfig refuses) and is
// only readable through the dev-mode routes.
export class OutboxMailer implements Mailer {
  readonly kind = 'outbox' as const;
  readonly messages: Array<MailMessage & { id: number; sentAt: number }> = [];
  private seq = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  send(message: MailMessage): Promise<void> {
    this.messages.push({ ...message, id: ++this.seq, sentAt: this.now() });
    if (this.messages.length > 50) this.messages.splice(0, this.messages.length - 50);
    return Promise.resolve();
  }
}

export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transport: Transporter;
  constructor(private readonly config: MailConfig) {
    if (!config.smtp.host) throw new Error('MIB_SMTP_HOST is required for the smtp mail provider');
    this.transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}

// No provider configured: mail is dropped with one warning. Endpoints behave identically so a
// missing provider is never observable from outside.
export class DisabledMailer implements Mailer {
  readonly kind = 'disabled' as const;
  private warned = false;
  send(): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      console.warn('mail: no provider configured (MIB_MAIL_PROVIDER); messages are not sent');
    }
    return Promise.resolve();
  }
}

export function createMailer(config: MailConfig, now?: () => number): Mailer {
  switch (config.provider) {
    case 'outbox':
      return new OutboxMailer(now);
    case 'smtp':
      return new SmtpMailer(config);
    default:
      return new DisabledMailer();
  }
}
