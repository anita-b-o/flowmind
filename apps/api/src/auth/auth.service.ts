import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { OrganizationsService } from "../organizations/organizations.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { accessTokenExpiresIn, refreshTokenExpiresIn, refreshTokenMaxAgeMs } from "./auth-config";
import { StructuredLoggerService } from "../observability/structured-logger.service";

type SessionMetadata = { userAgent?: string; ipHash?: string };

type RefreshPayload = {
  sub: string;
  sessionId: string;
  tokenFamily: string;
  tokenType: "refresh";
};

class ConcurrentRefreshError extends Error {}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly organizationsService: OrganizationsService,
    private readonly logger?: StructuredLoggerService
  ) {}

  async register(dto: RegisterDto, metadata: SessionMetadata) {
    const email = dto.email.toLowerCase();
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException("Email already registered");
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, passwordHash }
    });

    const organization = await this.organizationsService.createOwnedOrganization(user.id, dto.organizationName);
    return this.createSessionResponse(user.id, user.email, user.name, organization.id, metadata);
  }

  async login(dto: LoginDto, metadata: SessionMetadata) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" }
    });

    const response = await this.createSessionResponse(user.id, user.email, user.name, membership?.organizationId, metadata);
    this.logger?.info("api.auth.login_succeeded", { userId: user.id });
    return response;
  }

  async refresh(refreshToken: string | undefined, metadata: SessionMetadata) {
    if (!refreshToken) {
      throw new UnauthorizedException("Missing refresh token");
    }
    const payload = await this.verifyRefreshToken(refreshToken);
    const session = await this.prisma.refreshTokenSession.findUnique({ where: { id: payload.sessionId }, include: { user: true } });
    if (!session || session.userId !== payload.sub || session.tokenFamily !== payload.tokenFamily) {
      throw new UnauthorizedException("Invalid refresh session");
    }

    const tokenMatches = await argon2.verify(session.tokenHash, refreshToken);
    if (!tokenMatches) {
      throw new UnauthorizedException("Invalid refresh session");
    }

    if (session.revokedAt || session.replacedBySessionId) {
      await this.revokeFamily(session.tokenFamily);
      this.logger?.warn("api.auth.refresh_reuse_detected", { sessionId: session.id, userId: session.userId });
      throw new UnauthorizedException("Refresh token reuse detected");
    }
    if (session.expiresAt <= new Date()) {
      await this.prisma.refreshTokenSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), lastUsedAt: new Date() } });
      throw new UnauthorizedException("Refresh token expired");
    }

    const nextSessionId = randomUUID();
    const nextRefreshToken = await this.signRefreshToken(session.userId, nextSessionId, session.tokenFamily);
    const expiresAt = new Date(Date.now() + refreshTokenMaxAgeMs());
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshTokenSession.create({
          data: {
            id: nextSessionId,
            userId: session.userId,
            tokenHash: await argon2.hash(nextRefreshToken),
            tokenFamily: session.tokenFamily,
            expiresAt,
            lastUsedAt: now,
            userAgent: metadata.userAgent,
            ipHash: metadata.ipHash
          }
        });
        const update = await tx.refreshTokenSession.updateMany({
          where: { id: session.id, revokedAt: null, replacedBySessionId: null },
          data: { revokedAt: now, replacedBySessionId: nextSessionId, lastUsedAt: now }
        });
        if (update.count !== 1) {
          throw new ConcurrentRefreshError();
        }
      });
    } catch (error) {
      if (!(error instanceof ConcurrentRefreshError)) {
        throw error;
      }
      await this.revokeFamily(session.tokenFamily);
      this.logger?.warn("api.auth.refresh_reuse_detected", { sessionId: session.id, userId: session.userId, concurrent: true });
      throw new UnauthorizedException("Refresh token reuse detected");
    }

    this.logger?.info("api.auth.refresh_succeeded", { userId: session.user.id, sessionId: nextSessionId });
    return {
      refreshToken: nextRefreshToken,
      body: {
        accessToken: await this.signAccessToken(session.user.id, session.user.email),
        user: this.publicUser(session.user),
        defaultOrganizationId: await this.defaultOrganizationId(session.user.id)
      }
    };
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) {
      return;
    }
    try {
      const payload = await this.verifyRefreshToken(refreshToken);
      await this.prisma.refreshTokenSession.updateMany({
        where: { id: payload.sessionId, userId: payload.sub },
        data: { revokedAt: new Date(), lastUsedAt: new Date() }
      });
    } catch {
      return;
    }
  }

  async logoutAll(userId: string) {
    await this.prisma.refreshTokenSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
          include: { organization: true }
        }
      }
    });
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    return {
      user: this.publicUser(user),
      organizations: user.memberships.map((membership) => ({
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        role: membership.role
      }))
    };
  }

  async sessions(userId: string, refreshToken: string | undefined) {
    const currentSessionId = await this.currentSessionId(refreshToken);
    const sessions = await this.prisma.refreshTokenSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return {
      items: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        userAgent: session.userAgent,
        current: session.id === currentSessionId
      }))
    };
  }

  async revokeSession(userId: string, sessionId: string, refreshToken: string | undefined) {
    const session = await this.prisma.refreshTokenSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) {
      throw new NotFoundException("Session not found");
    }
    await this.prisma.refreshTokenSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
    return (await this.currentSessionId(refreshToken)) === sessionId;
  }

  private async createSessionResponse(userId: string, email: string, name: string, defaultOrganizationId: string | undefined, metadata: SessionMetadata) {
    const tokenFamily = randomUUID();
    const sessionId = randomUUID();
    const refreshToken = await this.signRefreshToken(userId, sessionId, tokenFamily);
    await this.prisma.refreshTokenSession.create({
      data: {
        id: sessionId,
        userId,
        tokenHash: await argon2.hash(refreshToken),
        tokenFamily,
        expiresAt: new Date(Date.now() + refreshTokenMaxAgeMs()),
        lastUsedAt: new Date(),
        userAgent: metadata.userAgent,
        ipHash: metadata.ipHash
      }
    });

    return {
      refreshToken,
      body: {
        accessToken: await this.signAccessToken(userId, email),
        user: { id: userId, email, name },
        defaultOrganizationId
      }
    };
  }

  private signAccessToken(userId: string, email: string) {
    return this.jwtService.signAsync(
      { sub: userId, email, tokenType: "access", jti: randomUUID() },
      { secret: process.env.JWT_ACCESS_SECRET ?? "change-me-access-secret", expiresIn: accessTokenExpiresIn() }
    );
  }

  private signRefreshToken(userId: string, sessionId: string, tokenFamily: string) {
    return this.jwtService.signAsync(
      { sub: userId, sessionId, tokenFamily, tokenType: "refresh" },
      { secret: process.env.JWT_REFRESH_SECRET ?? "change-me-refresh-secret", expiresIn: refreshTokenExpiresIn() }
    );
  }

  private async verifyRefreshToken(refreshToken: string): Promise<RefreshPayload> {
    const payload = await this.jwtService.verifyAsync<RefreshPayload>(refreshToken, {
      secret: process.env.JWT_REFRESH_SECRET ?? "change-me-refresh-secret"
    });
    if (payload.tokenType !== "refresh" || !payload.sub || !payload.sessionId || !payload.tokenFamily) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    return payload;
  }

  private async revokeFamily(tokenFamily: string) {
    await this.prisma.refreshTokenSession.updateMany({
      where: { tokenFamily, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() }
    });
  }

  private async defaultOrganizationId(userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" }
    });
    return membership?.organizationId;
  }

  private async currentSessionId(refreshToken: string | undefined) {
    if (!refreshToken) {
      return undefined;
    }
    try {
      const payload = await this.verifyRefreshToken(refreshToken);
      return payload.sessionId;
    } catch {
      return undefined;
    }
  }

  private publicUser(user: { id: string; email: string; name: string }) {
    return { id: user.id, email: user.email, name: user.name };
  }
}
