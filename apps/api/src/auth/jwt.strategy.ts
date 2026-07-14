import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? "change-me-access-secret"
    });
  }

  validate(payload: { sub: string; email: string; tokenType?: string }) {
    if (payload.tokenType !== "access") {
      throw new UnauthorizedException("Invalid access token");
    }
    return { userId: payload.sub, email: payload.email };
  }
}
