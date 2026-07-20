import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser, type CurrentUser as CurrentUserType } from "./current-user.decorator";
import { assertAllowedOrigin, clearRefreshCookieOptions, readCookie, refreshCookieName, refreshCookieOptions } from "./auth-config";
import { sessionMetadata } from "./session-metadata";
import { ApiMetricsService } from "../metrics/metrics.service";
import { AuthRateLimitService } from "./auth-rate-limit.service";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly metrics: ApiMetricsService,
    private readonly rateLimit: AuthRateLimitService
  ) {}

  @Post("register")
  async register(@Body() dto: RegisterDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const metadata = sessionMetadata(request);
    await this.rateLimit.assertAllowed("register", metadata.ipHash, dto.email);
    const result = await this.authService.register(dto, metadata);
    this.setRefreshCookie(response, result.refreshToken);
    return result.body;
  }

  @Post("login")
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const metadata = sessionMetadata(request);
    await this.rateLimit.assertAllowed("login", metadata.ipHash, dto.email);
    const result = await this.authService.login(dto, metadata);
    this.setRefreshCookie(response, result.refreshToken);
    return result.body;
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const metadata = sessionMetadata(request);
    await this.rateLimit.assertAllowed("refresh", metadata.ipHash);
    try {
      const result = await this.authService.refresh(this.getRefreshCookie(request), metadata);
      this.setRefreshCookie(response, result.refreshToken);
      return result.body;
    } catch (error) {
      this.clearRefreshCookie(response);
      throw error;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.authService.logout(this.getRefreshCookie(request));
    this.clearRefreshCookie(response);
  }

  @Post("logout-all")
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logoutAll(@CurrentUser() user: CurrentUserType, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.authService.logoutAll(user.userId);
    this.clearRefreshCookie(response);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentUser() user: CurrentUserType) {
    return this.authService.me(user.userId);
  }

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  sessions(@CurrentUser() user: CurrentUserType, @Req() request: Request) {
    return this.authService.sessions(user.userId, this.getRefreshCookie(request));
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async revokeSession(
    @CurrentUser() user: CurrentUserType,
    @Param("sessionId") sessionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const revokedCurrent = await this.authService.revokeSession(user.userId, sessionId, this.getRefreshCookie(request));
    if (revokedCurrent) {
      this.clearRefreshCookie(response);
    }
  }

  private setRefreshCookie(response: Response, refreshToken: string) {
    response.cookie(refreshCookieName(), refreshToken, refreshCookieOptions());
  }

  private clearRefreshCookie(response: Response) {
    response.clearCookie(refreshCookieName(), clearRefreshCookieOptions());
  }

  private getRefreshCookie(request: Request) {
    return readCookie(request, refreshCookieName());
  }

  private assertOrigin(request: Request) {
    if (!assertAllowedOrigin(request)) {
      if (request.path === "/auth/refresh") {
        this.metrics.recordAuthRefresh("invalid_origin");
      }
      throw new ForbiddenException("Origin is not allowed");
    }
  }
}
