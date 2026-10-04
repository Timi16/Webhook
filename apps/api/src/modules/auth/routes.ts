import {
  changeEmailSchema,
  changePasswordSchema,
  confirmEmailSchema,
  deleteAccountSchema,
  developerEnvelope,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  updateProfileSchema,
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
      description:
        "Creates a developer account and starts a session. Passwords need at least 10 characters and must not be a common password.",
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
      description:
        "Starts a new session and ends the one sent with the request, if any. The error is the same for an unknown email and a wrong password.",
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
      description: "Ends the current session and clears the cookie.",
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
      description: "The developer the session belongs to.",
      tag: "Auth",
      auth: "session",
    },
    ({ auth }) => service.me(auth.developerId),
  );

  api(
    router,
    {
      method: "patch",
      path: "/auth/me",
      response: developerEnvelope,
      summary: "Update your profile",
      description: "Changes your name or the workspace name shown in the dashboard.",
      tag: "Auth",
      auth: "session",
      body: updateProfileSchema,
    },
    ({ auth, body }) => service.updateProfile(auth.developerId, body),
  );

  api(
    router,
    {
      method: "delete",
      path: "/auth/me",
      summary: "Delete your account",
      description:
        "Deletes the account with its watches, endpoints, API keys and all payment and webhook history. Webhooks stop immediately. Needs the current password. This cannot be undone.",
      tag: "Auth",
      auth: "session",
      status: 204,
      body: deleteAccountSchema,
      before: [guards.authLimit],
    },
    async ({ auth, body, res }) => {
      await service.deleteAccount(auth.developerId, body.password);
      res.clearCookie(SESSION_COOKIE, cookieOptions);
    },
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/password",
      summary: "Change password",
      description: "Changes the password and signs out every other session.",
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
      path: "/auth/email",
      summary: "Request an email change",
      description:
        "Emails a confirmation link, valid for one hour, to the new address. The login email changes only when that link is opened. Needs the current password.",
      tag: "Auth",
      auth: "session",
      status: 204,
      body: changeEmailSchema,
      before: [guards.authLimit],
    },
    ({ auth, body }) => service.requestEmailChange(auth.developerId, body),
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/email/confirm",
      response: developerEnvelope,
      summary: "Confirm an email change",
      description:
        "Makes the new address the login email, using the token from the confirmation email. A token stops working once the email changes.",
      tag: "Auth",
      auth: "none",
      body: confirmEmailSchema,
      before,
    },
    ({ body }) => service.confirmEmailChange(body.token),
  );

  api(
    router,
    {
      method: "post",
      path: "/auth/forgot",
      summary: "Request a password reset email",
      description:
        "Emails a reset link valid for one hour. Always answers `204`, whether or not the email has an account.",
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
      description:
        "Sets a new password using the token from the reset email and signs out every session. A token stops working once the password changes.",
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
