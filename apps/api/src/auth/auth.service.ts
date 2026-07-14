import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { OrganizationsService } from "../organizations/organizations.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly organizationsService: OrganizationsService
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) {
      throw new ConflictException("Email already registered");
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        passwordHash
      }
    });

    const organization = await this.organizationsService.createOwnedOrganization(user.id, dto.organizationName);
    return this.issueTokens(user.id, user.email, organization.id);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" }
    });

    return this.issueTokens(user.id, user.email, membership?.organizationId);
  }

  private async issueTokens(userId: string, email: string, defaultOrganizationId?: string) {
    const accessToken = await this.jwtService.signAsync({ sub: userId, email });
    const refreshToken = await this.jwtService.signAsync(
      { sub: userId, email, tokenType: "refresh" },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? "change-me-refresh-secret",
        expiresIn: "30d"
      }
    );

    await this.prisma.refreshTokenSession.create({
      data: {
        userId,
        tokenHash: await argon2.hash(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    return {
      accessToken,
      refreshToken,
      defaultOrganizationId
    };
  }
}
