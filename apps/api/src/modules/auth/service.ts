import { createHmac, timingSafeEqual } from "node:crypto";
import type { Developer } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { generateSessionToken } from "../../lib/ids.js";
import type { Mailer } from "../../lib/mailer.js";
import {
  hashPassword,
  isCommonPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "../../lib/password.js";
import type { AuthRepo } from "./repo.js";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;
const MAX_LOGIN_DELAY_MS = 4_000;

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface PublicDeveloper {
  id: string;
  email: string;
  name: string | null;
  workspace: string | null;
  createdAt: string;
}

function toPublic(developer: Developer): PublicDeveloper {
  return {
    id: developer.id,
    email: developer.email,
    name: developer.name,
    workspace: developer.workspace,
    createdAt: developer.createdAt.toISOString(),
  };
}

function assertStrongPassword(password: string, field: string): void {
  if (isCommonPassword(password)) {
    throw new AppError("VALIDATION_FAILED", `${field}: password_too_common`, {
      details: [{ path: field, issue: "password_too_common" }],
    });
  }
}

export interface AuthServiceOptions {
  /** Base of the growing per-account delay after failed logins. 0 disables it (tests). */
  loginDelayMs?: number;
  /** Told when sessions stop being valid, so anything tied to them (live streams) can end too. */
  onSessionEnded?: (sessionId: string) => void;
  onSessionsEnded?: (developerId: string, exceptSessionId?: string) => void;
}

export function createAuthService(
  repo: AuthRepo,
  env: Pick<Env, "SESSION_SECRET" | "DASHBOARD_ORIGIN">,
  mailer: Mailer,
  options: AuthServiceOptions = {},
) {
  const loginDelayMs = options.loginDelayMs ?? 250;
  const failures = new Map<string, number>();

  async function startSession(developerId: string, meta: SessionMeta): Promise<string> {
    const { token, id } = generateSessionToken();
    await repo.createSession(developerId, {
      id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 300) } : {}),
    });
    return token;
  }

  // Stateless reset token: it stops working as soon as the password (hash) changes.
  function resetSignature(developerId: string, expiresAt: number, passwordHash: string): string {
    return createHmac("sha256", env.SESSION_SECRET)
      .update(`reset.${developerId}.${expiresAt}.${passwordHash}`)
      .digest("hex");
  }

  // Stateless like the reset token: it stops working as soon as the account's email changes.
  function emailChangeSignature(
    developerId: string,
    expiresAt: number,
    newEmail: string,
    currentEmail: string,
  ): string {
    return createHmac("sha256", env.SESSION_SECRET)
      .update(`email.${developerId}.${expiresAt}.${newEmail}.${currentEmail}`)
      .digest("hex");
  }
  const emailTaken = () => new AppError("CONFLICT", "An account with this email already exists");
  const isUniqueViolation = (err: unknown) =>
    typeof err === "object" && err !== null && "code" in err && err.code === "P2002";

  return {
    async signup(
      input: { email: string; password: string; name?: string; workspace?: string },
      meta: SessionMeta,
    ) {
      assertStrongPassword(input.password, "password");
      if (await repo.findDeveloperByEmail(input.email)) {
        throw new AppError("CONFLICT", "An account with this email already exists");
      }
      const passwordHash = await hashPassword(input.password);
      const developer = await repo
        .createDeveloper({
          email: input.email,
          passwordHash,
          ...(input.name ? { name: input.name } : {}),
          ...(input.workspace ? { workspace: input.workspace } : {}),
        })
        .catch((err: unknown) => {
          // Two signups for the same email raced past the check above; the unique index decides.
          if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
            throw new AppError("CONFLICT", "An account with this email already exists");
          }
          throw err;
        });
      return { developer: toPublic(developer), token: await startSession(developer.id, meta) };
    },

    async login(
      input: { email: string; password: string },
      meta: SessionMeta,
      previousSessionId?: string,
    ) {
      const failed = failures.get(input.email) ?? 0;
      if (failed > 0 && loginDelayMs > 0) {
        const delay = Math.min(loginDelayMs * 2 ** (failed - 1), MAX_LOGIN_DELAY_MS);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const developer = await repo.findDeveloperByEmail(input.email);
      let ok = false;
      if (developer) ok = await verifyPassword(developer.passwordHash, input.password);
      else await verifyAgainstDummy(input.password);

      if (!developer || !ok) {
        if (failures.size > 10_000) failures.clear();
        failures.set(input.email, failed + 1);
        // Same error for a wrong email and a wrong password.
        throw new AppError("UNAUTHENTICATED", "Invalid email or password");
      }
      failures.delete(input.email);
      // Sessions are rotated on login; expired ones are swept at the same time.
      if (previousSessionId) {
        await repo.deleteSession(previousSessionId);
        options.onSessionEnded?.(previousSessionId);
      }
      await repo.deleteExpiredSessions();
      return { developer: toPublic(developer), token: await startSession(developer.id, meta) };
    },

    async logout(sessionId: string | undefined): Promise<void> {
      if (!sessionId) return;
      await repo.deleteSession(sessionId);
      options.onSessionEnded?.(sessionId);
    },

    async me(developerId: string) {
      const developer = await repo.findDeveloper(developerId);
      if (!developer)
        throw new AppError("UNAUTHENTICATED", "A valid session or API key is required");
      return { developer: toPublic(developer) };
    },

    async updateProfile(
      developerId: string,
      input: { name?: string | undefined; workspace?: string | null | undefined },
    ) {
      const developer = await repo.updateProfile(developerId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace || null } : {}),
      });
      return { developer: toPublic(developer) };
    },

    /**
     * Emails a confirmation link to the new address. The login email only changes once that link
     * is opened, so a typo cannot lock the developer out. Asks for the password again.
     */
    async requestEmailChange(
      developerId: string,
      input: { email: string; password: string },
    ): Promise<void> {
      const developer = await repo.findDeveloper(developerId);
      if (!developer || !(await verifyPassword(developer.passwordHash, input.password))) {
        throw new AppError("VALIDATION_FAILED", "password: incorrect_password", {
          details: [{ path: "password", issue: "incorrect_password" }],
        });
      }
      if (input.email === developer.email) {
        throw new AppError("VALIDATION_FAILED", "email: same_email", {
          details: [{ path: "email", issue: "same_email" }],
        });
      }
      if (await repo.findDeveloperByEmail(input.email)) throw emailTaken();
      const expiresAt = Date.now() + EMAIL_CHANGE_TTL_MS;
      const signature = emailChangeSignature(developer.id, expiresAt, input.email, developer.email);
      const payload = Buffer.from(
        JSON.stringify({ d: developer.id, e: expiresAt, n: input.email }),
      ).toString("base64url");
      await mailer.send({
        to: input.email,
        subject: "Confirm your new Webhook email",
        text: `Use this link within 1 hour to make this your Webhook login email:\n\n${env.DASHBOARD_ORIGIN}/confirm-email?token=${payload}.${signature}\n\nIf you didn't ask for this, ignore this email.`,
      });
    },

    async confirmEmailChange(token: string) {
      const invalid = new AppError("VALIDATION_FAILED", "token: invalid_or_expired_token", {
        details: [{ path: "token", issue: "invalid_or_expired_token" }],
      });
      const [encoded, signature] = token.split(".");
      if (!encoded || !signature) throw invalid;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch {
        throw invalid;
      }
      if (typeof parsed !== "object" || parsed === null) throw invalid;
      const { d, e, n } = parsed as { d?: unknown; e?: unknown; n?: unknown };
      if (typeof d !== "string" || typeof e !== "number" || typeof n !== "string") throw invalid;
      if (e < Date.now()) throw invalid;
      const developer = await repo.findDeveloper(d);
      if (!developer) throw invalid;
      const expected = Buffer.from(emailChangeSignature(developer.id, e, n, developer.email), "hex");
      const given = Buffer.from(signature, "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid;

      const updated = await repo.setEmail(developer.id, n).catch((err: unknown) => {
        // Someone else signed up with the address after the link was sent.
        if (isUniqueViolation(err)) throw emailTaken();
        throw err;
      });
      return { developer: toPublic(updated) };
    },

    /** Irreversible, so it asks for the password again even with a valid session. */
    async deleteAccount(developerId: string, password: string): Promise<void> {
      const developer = await repo.findDeveloper(developerId);
      if (!developer || !(await verifyPassword(developer.passwordHash, password))) {
        throw new AppError("VALIDATION_FAILED", "password: incorrect_password", {
          details: [{ path: "password", issue: "incorrect_password" }],
        });
      }
      await repo.deleteAccount(developerId);
      options.onSessionsEnded?.(developerId);
    },

    async changePassword(
      developerId: string,
      sessionId: string | undefined,
      input: { currentPassword: string; newPassword: string },
    ): Promise<void> {
      const developer = await repo.findDeveloper(developerId);
      if (!developer || !(await verifyPassword(developer.passwordHash, input.currentPassword))) {
        throw new AppError("VALIDATION_FAILED", "currentPassword: incorrect_password", {
          details: [{ path: "currentPassword", issue: "incorrect_password" }],
        });
      }
      assertStrongPassword(input.newPassword, "newPassword");
      await repo.setPassword(developerId, await hashPassword(input.newPassword));
      await repo.deleteSessions(developerId, sessionId);
      options.onSessionsEnded?.(developerId, sessionId);
    },

    /** Always succeeds from the caller's point of view (no account enumeration). */
    async forgotPassword(email: string): Promise<void> {
      const developer = await repo.findDeveloperByEmail(email);
      if (!developer) return;
      const expiresAt = Date.now() + RESET_TTL_MS;
      const signature = resetSignature(developer.id, expiresAt, developer.passwordHash);
      const token = `${Buffer.from(`${developer.id}.${expiresAt}`).toString("base64url")}.${signature}`;
      await mailer.send({
        to: developer.email,
        subject: "Reset your Webhook password",
        text: `Use this link within 1 hour to choose a new password:\n\n${env.DASHBOARD_ORIGIN}/reset-password?token=${token}\n\nIf you didn't ask for this, ignore this email.`,
      });
    },

    async resetPassword(input: { token: string; newPassword: string }): Promise<void> {
      const invalid = new AppError("VALIDATION_FAILED", "token: invalid_or_expired_token", {
        details: [{ path: "token", issue: "invalid_or_expired_token" }],
      });
      const [encoded, signature] = input.token.split(".");
      if (!encoded || !signature) throw invalid;
      const [developerId, expiresRaw] = Buffer.from(encoded, "base64url")
        .toString("utf8")
        .split(".");
      const expiresAt = /^\d{1,16}$/.test(expiresRaw ?? "") ? parseInt(expiresRaw ?? "", 10) : NaN;
      if (!developerId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) throw invalid;
      const developer = await repo.findDeveloper(developerId);
      if (!developer) throw invalid;
      const expected = Buffer.from(
        resetSignature(developer.id, expiresAt, developer.passwordHash),
        "hex",
      );
      const given = Buffer.from(signature, "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid;

      assertStrongPassword(input.newPassword, "newPassword");
      await repo.setPassword(developer.id, await hashPassword(input.newPassword));
      await repo.deleteSessions(developer.id);
      options.onSessionsEnded?.(developer.id);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
