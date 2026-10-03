import { ulid } from "ulid";

export function newRequestId(): string {
  return ulid();
}
