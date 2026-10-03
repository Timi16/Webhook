import type { PrismaClient } from "@prisma/client";
import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";
import { API_KEY_PREFIX, sha256Hex } from "../lib/ids.js";

export const SESSION_COOKIE = "whk_session";
const LAST_USED_INTERVAL_MS = 60_000;

export interface AuthContext {
  developerId: string;
  via: "session" | "apiKey";
  apiKeyId?: string;
  sessionId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the documented way to extend Express.Request
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function unauthenticated(): AppError {
  return new AppError("UNAUTHENTICATED", "A valid session or API key is required");
}

export function createAuth(prisma: PrismaClient) {
  async function fromApiKey(key: string): Promise<AuthContext | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(key) } });
    if (!apiKey || apiKey.revokedAt) return null;
    // lastUsedAt is updated at most once a minute.
    if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_INTERVAL_MS) {
      prisma.apiKey
        .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }
    return { developerId: apiKey.developerId, via: "apiKey", apiKeyId: apiKey.id };
  }

  async function fromSession(req: Request): Promise<AuthContext | null> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length === 0) return null;
    const id = sha256Hex(token);
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.expiresAt <= new Date()) return null;
    return { developerId: session.developerId, via: "session", sessionId: id };
  }

  const requireAny: RequestHandler = async (req, _res, next) => {
    const header = req.get("authorization");
    // A Bearer header is never ignored: a bad key is a 401 even if a session cookie is present.
    const auth = header?.startsWith("Bearer ")
      ? await fromApiKey(header.slice(7).trim())
      : await fromSession(req);
    if (!auth) throw unauthenticated();
    req.auth = auth;
    next();
  };

  const requireSession: RequestHandler = async (req, _res, next) => {
    const auth = await fromSession(req);
    if (!auth) throw unauthenticated();
    req.auth = auth;
    next();
  };

  return { requireAny, requireSession };
}
