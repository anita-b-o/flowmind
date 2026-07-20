import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? "change-me-access-secret"
    });
  }

  async validate(payload: { sub: string; email: string; tokenType?: string }) {
    if (payload.tokenType !== "access") {
      throw new UnauthorizedException("Invalid access token");
    }
    const user = await this.prisma.user.findFirst({ where: { id: payload.sub, status: "ACTIVE" }, select: { id: true, email: true } });
    if (!user) throw new UnauthorizedException("Invalid access token");
    return { userId: user.id, email: user.email };
  }
}
