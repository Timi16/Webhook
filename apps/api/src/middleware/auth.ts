import type { ApiKey, PrismaClient } from "@prisma/client";
import type { Request, RequestHandler, Response } from "express";
import { AppError } from "../lib/errors.js";
import { API_KEY_PREFIX, sha256Hex } from "../lib/ids.js";
import { ipAllowed, normalizeIp } from "../lib/ip.js";

export const SESSION_COOKIE = "whk_session";
const LAST_USED_INTERVAL_MS = 60_000;
export const REQUEST_LOG_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LOGGED_PATH = 300;

export interface AuthContext {
  developerId: string;
  via: "session" | "apiKey";
  apiKeyId?: string;
  /** What the API key may do. Sessions are not limited by scopes. */
  scopes?: string[];
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
  let lastPrune = 0;

  /** Records the request in the key's log once the response is sent. Never the query string. */
  function logRequest(req: Request, res: Response, apiKey: ApiKey, ip: string | null): void {
    const startedAt = Date.now();
    res.on("finish", () => {
      const now = Date.now();
      prisma.apiKeyRequest
        .create({
          data: {
            apiKeyId: apiKey.id,
            method: req.method,
            path: (req.originalUrl.split("?")[0] ?? "").slice(0, MAX_LOGGED_PATH),
            status: res.statusCode,
            durationMs: now - startedAt,
            ip,
          },
        })
        .catch(() => {}); // the key may have been deleted meanwhile
      if (now - lastPrune > PRUNE_INTERVAL_MS) {
        lastPrune = now;
        prisma.apiKeyRequest
          .deleteMany({
            where: { createdAt: { lt: new Date(now - REQUEST_LOG_DAYS * 24 * 60 * 60 * 1000) } },
          })
          .catch(() => {});
      }
    });
  }

  async function fromApiKey(req: Request, res: Response, key: string): Promise<AuthContext | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(key) } });
    const now = new Date();
    // A rolled key carries a revokedAt in the future: it works until then.
    if (!apiKey || (apiKey.revokedAt && apiKey.revokedAt <= now)) return null;
    if (apiKey.expiresAt && apiKey.expiresAt <= now) return null;

    const ip = normalizeIp(req.ip);
    logRequest(req, res, apiKey, ip);
    if (!ipAllowed(ip, apiKey.allowedIps)) {
      throw new AppError("FORBIDDEN", "This API key cannot be used from your IP address");
    }
    // lastUsedAt is updated at most once a minute.
    if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_INTERVAL_MS) {
      prisma.apiKey
        .update({ where: { id: apiKey.id }, data: { lastUsedAt: now, lastUsedIp: ip } })
        .catch(() => {});
    }
    return {
      developerId: apiKey.developerId,
      via: "apiKey",
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes,
    };
  }

  async function fromSession(req: Request): Promise<AuthContext | null> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length === 0) return null;
    const id = sha256Hex(token);
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.expiresAt <= new Date()) return null;
    return { developerId: session.developerId, via: "session", sessionId: id };
  }

  const requireAny: RequestHandler = async (req, res, next) => {
    const header = req.get("authorization");
    // A Bearer header is never ignored: a bad key is a 401 even if a session cookie is present.
    const auth =
      header && /^bearer /i.test(header)
        ? await fromApiKey(req, res, header.slice(7).trim())
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
