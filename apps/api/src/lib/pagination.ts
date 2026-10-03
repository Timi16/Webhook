import { z } from "zod";
import { AppError } from "./errors.js";

export interface PageCursor {
  createdAt: Date;
  id: string;
}

const cursorSchema = z.tuple([z.iso.datetime(), z.string().min(1).max(200)]);

/** Opaque base64 of (createdAt, id), so pages stay stable while new rows arrive. */
export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

export function decodeCursor(raw: string | undefined): PageCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    const [createdAt, id] = cursorSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    if (id.includes("\u0000")) throw new Error("invalid id");
    return { createdAt: new Date(createdAt), id };
  } catch {
    throw new AppError("VALIDATION_FAILED", "cursor: invalid_cursor", {
      details: [{ path: "cursor", issue: "invalid_cursor" }],
    });
  }
}

/** Takes limit + 1 rows and turns them into a page. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => PageCursor) {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null };
}
