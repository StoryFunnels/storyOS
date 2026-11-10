import { Controller, Get, HttpCode, NotFoundException, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { env } from '../config/env';
import { PreferencesService } from '../users/preferences.service';
import { verifyUnsubscribeToken } from './digest-token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ticket #1251 — the digest's one-click "Stop these emails". Deliberately NO AuthGuard (the person clicking is in their mail app, not signed
 * in): the signed token is the only credential, it names one person and this one action (see digest-token.ts), and it can only ever turn
 * that person's own digest OFF. Anything that is not a token this server signed is a plain 404 that says nothing about why.
 *
 * GET is what the footer link does (then lands on Settings › Notifications with the switch Off, so turning it back on is one click).
 * POST is RFC 8058 one-click: a mail app's own Unsubscribe button posts to the List-Unsubscribe URL without opening a page.
 */
@ApiTags('public')
@Controller('public/my-work-digest')
export class MyWorkDigestController {
  constructor(private readonly preferences: PreferencesService) {}

  private async turnOff(token: string | undefined) {
    const userId = verifyUnsubscribeToken(token);
    if (!userId) throw new NotFoundException('Not found');
    await this.preferences.update(userId, { myWorkEmail: { frequency: 'off' } });
  }

  @Get('unsubscribe')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Stop the My work email: a signed link, no sign-in. Redirects to Settings › Notifications' })
  async unsubscribe(@Query('token') token: string | undefined, @Query('ws') ws: string | undefined, @Res() reply: FastifyReply) {
    await this.turnOff(token);
    const web = env().WEB_URL.replace(/\/$/, '');
    // `ws` only picks where to land; it grants nothing, and anything but a uuid falls back to the web root.
    const target = ws && UUID_RE.test(ws) ? `${web}/w/${ws}/settings/notifications?my_work=off` : web;
    return reply.redirect(target, 302);
  }

  @Post('unsubscribe')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Stop the My work email (RFC 8058 one-click List-Unsubscribe-Post). Signed token, no sign-in' })
  async unsubscribeOneClick(@Query('token') token: string | undefined) {
    await this.turnOff(token);
    return { ok: true };
  }
}
