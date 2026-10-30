import { listAccessibleWorkspaces } from '@surfaced/core/access';
import { recordAuditLog } from '@surfaced/core/audit-log';
import { ensureDefaultPlans } from '@surfaced/core/billing';
import {
  getDummyPasswordHash,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from '@surfaced/core/crypto';
import type { User } from '@surfaced/core/db';
import { queueEmail } from '@surfaced/core/email';
import { getEnv } from '@surfaced/core/env';
import { AppError, Errors } from '@surfaced/core/errors';
import {
  DEFAULT_PLAN_KEY,
  slugify,
  type MeDto,
  type RegisterInput,
  type UserTokenType,
} from '@surfaced/shared';
import type { AppDeps } from '../types';
import { toMembershipDto, toUserDto } from './dto';

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

const VERIFICATION_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;

export class AuthService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  async createSession(
    userId: string,
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + getEnv().SESSION_TTL_DAYS * 24 * 3600 * 1000);
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        ipAddress: meta.ip.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 400),
        expiresAt,
      },
    });
    return { token, expiresAt, sessionId: session.id };
  }

  async register(input: RegisterInput, meta: RequestMeta) {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) throw Errors.conflict('An account with this email already exists. Sign in instead.');

    const passwordHash = await hashPassword(input.password);
    let freePlan = await this.prisma.subscriptionPlan.findUnique({ where: { key: DEFAULT_PLAN_KEY } });
    if (!freePlan) {
      await ensureDefaultPlans(this.prisma);
      freePlan = await this.prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: DEFAULT_PLAN_KEY } });
    }
    const workspaceName = input.workspaceName ?? `${input.name.split(' ')[0]}'s workspace`;

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash },
        });
        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            slug: `${slugify(workspaceName, 40) || 'workspace'}-${randomToken(4).toLowerCase()}`,
          },
        });
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: created.id, role: 'OWNER' },
        });
        await tx.subscription.create({
          data: { workspaceId: workspace.id, planId: freePlan.id, status: 'ACTIVE', provider: 'NONE' },
        });
        return tx.user.update({ where: { id: created.id }, data: { lastWorkspaceId: workspace.id } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw Errors.conflict('An account with this email already exists. Sign in instead.');
      }
      throw error;
    }

    const session = await this.createSession(user.id, meta);
    await this.sendVerificationEmail(user);
    await recordAuditLog(this.prisma, {
      action: 'auth.register',
      actorUserId: user.id,
      workspaceId: user.lastWorkspaceId,
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { user, session };
  }

  async login(email: string, password: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always run a hash verification so response time does not reveal whether the email exists.
    const valid = await verifyPassword(user?.passwordHash ?? (await getDummyPasswordHash()), password);
    if (!user || !valid) {
      await recordAuditLog(this.prisma, {
        action: 'auth.login_failed',
        actorUserId: user?.id ?? null,
        targetType: 'User',
        targetId: user?.id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new AppError(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
    }
    if (user.disabledAt) throw Errors.accountDisabled();

    const session = await this.createSession(user.id, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAuditLog(this.prisma, {
      action: 'auth.login',
      actorUserId: user.id,
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { user, session };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  private async issueUserToken(userId: string, type: UserTokenType, ttlMs: number): Promise<string> {
    const token = randomToken(32);
    await this.prisma.$transaction([
      // Only the newest token of each type stays valid.
      this.prisma.userToken.updateMany({
        where: { userId, type, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.userToken.create({
        data: { userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
      }),
    ]);
    return token;
  }

  /** Consumes a single-use token; returns the user id or throws a generic error. */
  private async consumeUserToken(token: string, type: UserTokenType): Promise<string> {
    const record = await this.prisma.userToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= new Date()) {
      throw Errors.badRequest('This link is invalid or has expired. Request a new one.');
    }
    const updated = await this.prisma.userToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (updated.count !== 1) throw Errors.badRequest('This link has already been used.');
    return record.userId;
  }

  async sendVerificationEmail(user: Pick<User, 'id' | 'email' | 'name' | 'emailVerifiedAt'>): Promise<void> {
    if (user.emailVerifiedAt) return;
    const token = await this.issueUserToken(user.id, 'EMAIL_VERIFICATION', VERIFICATION_TTL_MS);
    const url = `${getEnv().APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await queueEmail(this.prisma, this.deps.queues, {
      to: user.email,
      template: 'verify_email',
      data: { name: user.name, url },
      userId: user.id,
    });
  }

  async verifyEmail(token: string): Promise<User> {
    const userId = await this.consumeUserToken(token, 'EMAIL_VERIFICATION');
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    await recordAuditLog(this.prisma, {
      action: 'auth.email_verified',
      actorUserId: userId,
      targetType: 'User',
      targetId: userId,
    });
    return user;
  }

  /** Always resolves without revealing whether the account exists. */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.disabledAt) return;
    const token = await this.issueUserToken(user.id, 'PASSWORD_RESET', RESET_TTL_MS);
    const url = `${getEnv().APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await queueEmail(this.prisma, this.deps.queues, {
      to: user.email,
      template: 'password_reset',
      data: { name: user.name, url },
      userId: user.id,
    });
    await recordAuditLog(this.prisma, {
      action: 'auth.password_reset_requested',
      actorUserId: user.id,
      targetType: 'User',
      targetId: user.id,
      ipAddress: meta.ip,
    });
  }

  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
    const userId = await this.consumeUserToken(token, 'PASSWORD_RESET');
    const passwordHash = await hashPassword(password);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        // Completing a reset proves control of the mailbox, so the address counts as verified.
        data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
      }),
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);
    await recordAuditLog(this.prisma, {
      action: 'auth.password_reset',
      actorUserId: userId,
      targetType: 'User',
      targetId: userId,
      ipAddress: meta.ip,
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
    meta: RequestMeta,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw Errors.validation([
        { path: 'body.currentPassword', message: 'Your current password is incorrect.' },
      ]);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.session.deleteMany({ where: { userId, id: { not: keepSessionId } } }),
    ]);
    await recordAuditLog(this.prisma, {
      action: 'auth.password_changed',
      actorUserId: userId,
      targetType: 'User',
      targetId: userId,
      ipAddress: meta.ip,
    });
  }

  async me(userId: string): Promise<MeDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = (await listAccessibleWorkspaces(this.prisma, userId)).map(toMembershipDto);
    const current =
      memberships.find((m) => m.workspaceId === user.lastWorkspaceId)?.workspaceId ??
      memberships[0]?.workspaceId ??
      null;
    return { user: toUserDto(user), memberships, currentWorkspaceId: current };
  }
}
