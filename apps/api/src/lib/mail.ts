import type { Transporter } from 'nodemailer';
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

// SMTP is the only provider that needs a mail library, so nodemailer is loaded the first time a
// message is actually sent. Nothing about starting the API depends on it: a deployment using the
// development outbox or no mail at all boots with the package absent, and a missing or broken
// install can never take the whole server down (it would strand the web app on a dead proxy).
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private transport: Transporter | null = null;
  constructor(private readonly config: MailConfig) {
    // Configuration errors are still reported at startup, where they can be acted on.
    if (!config.smtp.host) throw new Error('MIB_SMTP_HOST is required for the smtp mail provider');
  }

  private async connect(): Promise<Transporter> {
    if (this.transport) return this.transport;
    let createTransport;
    try {
      ({ createTransport } = await import('nodemailer'));
    } catch (cause) {
      throw new Error(
        'the smtp mail provider needs the "nodemailer" package; run `pnpm install` or set MIB_MAIL_PROVIDER=disabled',
        { cause },
      );
    }
    this.transport = createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: this.config.smtp.user
        ? { user: this.config.smtp.user, pass: this.config.smtp.pass }
        : undefined,
    });
    return this.transport;
  }

  async send(message: MailMessage): Promise<void> {
    const transport = await this.connect();
    await transport.sendMail({ from: this.config.from, ...message });
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
