import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { OrganizationsModule } from "../organizations/organizations.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { AuthRateLimitService } from "./auth-rate-limit.service";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? "change-me-access-secret",
      signOptions: { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m" }
    }),
    OrganizationsModule,
    AuditLogsModule
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AuthRateLimitService],
  exports: [AuthService]
})
export class AuthModule {}
