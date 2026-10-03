import {
  changePasswordSchema,
  developerEnvelope,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from "@webhook/shared";
import {
  Router,
  type CookieOptions,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { Env } from "../../config/env.js";
import { sha256Hex } from "../../lib/ids.js";
import { SESSION_COOKIE } from "../../middleware/auth.js";
import type { Api } from "../../openapi/registry.js";
import { SESSION_TTL_MS, type AuthService, type SessionMeta } from "./service.js";

function meta(req: Request): SessionMeta {
  const userAgent = req.get("user-agent");
  return { ...(req.ip ? { ip: req.ip } : {}), ...(userAgent ? { userAgent } : {}) };
}

export function createAuthRouter(
  api: Api,
  service: AuthService,
  env: Pick<Env, "NODE_ENV">,
  guards: { authLimit: RequestHandler; requireOrigin: RequestHandler },
): Router {
  const router = Router();
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    // Browsers only send Secure cookies over HTTPS; local development runs on plain http.
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
  const setSession = (res: Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
  const before = [guards.authLimit, guards.requireOrigin];

  api(
    router,
    {
      method: "post",
      path: "/auth/signup",
      response: developerEnvelope,
      summary: "Create an account",
      tag: "Auth",
      auth: "none",
      status: 201,
      body: signupSchema,
      before,
    },
    async ({ body, req, res }) => {
      const { developer, token } = await service.signup(body, meta(req));
      setSession(res, token);
      return { developer };
    },
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/login",
      response: developerEnvelope,
      summary: "Log in",
      tag: "Auth",
      auth: "none",
      body: loginSchema,
      before,
    },
    async ({ body, req, res }) => {
      const existing: unknown = req.cookies?.[SESSION_COOKIE];
      const previous = typeof existing === "string" && existing ? sha256Hex(existing) : undefined;
      const { developer, token } = await service.login(body, meta(req), previous);
      setSession(res, token);
      return { developer };
    },
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/logout",
      summary: "Log out",
      tag: "Auth",
      auth: "none",
      status: 204,
      before: [guards.requireOrigin],
    },
    async ({ req, res }) => {
      const existing: unknown = req.cookies?.[SESSION_COOKIE];
      await service.logout(
        typeof existing === "string" && existing ? sha256Hex(existing) : undefined,
      );
      res.clearCookie(SESSION_COOKIE, cookieOptions);
    },
  );

  api(
    router,
    {
      method: "get",
      path: "/auth/me",
      response: developerEnvelope,
      summary: "The logged-in developer",
      tag: "Auth",
      auth: "session",
    },
    ({ auth }) => service.me(auth.developerId),
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/password",
      summary: "Change password",
      tag: "Auth",
      auth: "session",
      status: 204,
      body: changePasswordSchema,
      before: [guards.authLimit],
    },
    ({ auth, body }) => service.changePassword(auth.developerId, auth.sessionId, body),
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/forgot",
      summary: "Request a password reset email",
      tag: "Auth",
      auth: "none",
      status: 204,
      body: forgotPasswordSchema,
      before,
    },
    ({ body }) => service.forgotPassword(body.email),
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/reset",
      summary: "Set a new password with a reset token",
      tag: "Auth",
      auth: "none",
      status: 204,
      body: resetPasswordSchema,
      before,
    },
    ({ body }) => service.resetPassword(body),
  );

  return router;
}
