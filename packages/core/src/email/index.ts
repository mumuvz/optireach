// Email provider abstraction. In development the console provider writes .eml files to var/mail and
// records LOGGED_LOCALLY — it never claims an email was delivered. Production uses SMTP.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { decryptSecret, encryptSecret } from '../crypto';
import type { PrismaClient } from '../db';
import { findRepoRoot, getEnv } from '../env';
import { createJobRecord, enqueueJobRecord } from '../jobs';
import type { QueueGateway } from '../queue';
import { renderEmail, type EmailTemplate, type RenderedEmail, type TemplateData } from './templates';

export * from './templates';

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  from: string;
}

export interface SendResult {
  status: 'SENT' | 'LOGGED_LOCALLY';
  providerMessageId?: string;
  localPath?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendResult>;
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly transport: Transporter;

  constructor(private readonly outDir = path.join(findRepoRoot(), 'var', 'mail')) {
    this.transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const info = await this.transport.sendMail(message);
    await mkdir(this.outDir, { recursive: true });
    const safeTo = message.to.replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(this.outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeTo}.eml`);
    await writeFile(file, info.message as Buffer);
    return { status: 'LOGGED_LOCALLY', localPath: file, providerMessageId: info.messageId };
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor() {
    const env = getEnv();
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const info = await this.transport.sendMail(message);
    return { status: 'SENT', providerMessageId: info.messageId };
  }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  provider ??= getEnv().EMAIL_PROVIDER === 'smtp' ? new SmtpEmailProvider() : new ConsoleEmailProvider();
  return provider;
}

/** Test hook. */
export function setEmailProvider(next: EmailProvider | null): void {
  provider = next;
}

export interface QueueEmailInput<T extends EmailTemplate> {
  to: string;
  template: T;
  data: TemplateData[T];
  userId?: string | null;
  workspaceId?: string | null;
}

/**
 * Renders an email, records an EmailDelivery (recipient, template, subject, status — no body),
 * and enqueues delivery. The rendered message travels encrypted in the queue payload because it
 * may contain single-use links; it is never persisted in MySQL.
 */
export async function queueEmail<T extends EmailTemplate>(
  prisma: PrismaClient,
  gateway: QueueGateway,
  input: QueueEmailInput<T>,
): Promise<string> {
  const env = getEnv();
  const rendered = renderEmail(input.template, input.data, env.APP_NAME);
  const delivery = await prisma.emailDelivery.create({
    data: {
      userId: input.userId ?? null,
      toAddress: input.to,
      template: input.template,
      subject: rendered.subject.slice(0, 255),
      provider: env.EMAIL_PROVIDER,
      status: 'QUEUED',
    },
  });
  const job = await createJobRecord(prisma, {
    type: 'EMAIL',
    queue: 'email',
    userId: input.userId ?? null,
    workspaceId: input.workspaceId ?? null,
    payload: { deliveryId: delivery.id, template: input.template },
    entityType: 'EmailDelivery',
    entityId: delivery.id,
    maxAttempts: 5,
  });
  await enqueueJobRecord(prisma, gateway, job, 'email', {
    backgroundJobId: job.id,
    deliveryId: delivery.id,
    encryptedMessage: encryptSecret(JSON.stringify(rendered)),
  });
  return delivery.id;
}

/** Worker side: decrypts and sends a queued email, recording the outcome. */
export async function deliverQueuedEmail(
  prisma: PrismaClient,
  deliveryId: string,
  encryptedMessage: string,
  emailProvider: EmailProvider = getEmailProvider(),
): Promise<SendResult> {
  const delivery = await prisma.emailDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new Error(`Email delivery ${deliveryId} not found`);
  if (delivery.status === 'SENT' || delivery.status === 'LOGGED_LOCALLY') {
    return { status: delivery.status, providerMessageId: delivery.providerMessageId ?? undefined };
  }
  const rendered = JSON.parse(decryptSecret(encryptedMessage)) as RenderedEmail;
  try {
    const result = await emailProvider.send({
      ...rendered,
      to: delivery.toAddress,
      from: getEnv().EMAIL_FROM,
    });
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: result.status,
        provider: emailProvider.name,
        providerMessageId: result.providerMessageId?.slice(0, 255),
        localPath: result.localPath?.slice(0, 500),
        sentAt: result.status === 'SENT' ? new Date() : null,
        error: null,
      },
    });
    return result;
  } catch (error) {
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message.slice(0, 2000) : 'Send failed',
      },
    });
    throw error;
  }
}
