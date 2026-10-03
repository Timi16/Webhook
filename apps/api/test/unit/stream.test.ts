import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../src/db/notify.js";
import { StreamHub } from "../../src/modules/stream/service.js";

class FakeResponse extends EventEmitter {
  written: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
    this.emit("close");
  }
}

const connect = (hub: StreamHub, developerId: string) => {
  const res = new FakeResponse();
  hub.add(developerId, res as unknown as Response);
  return res;
};

describe("StreamHub", () => {
  it("keeps at most 5 streams per developer, closing the oldest", () => {
    const hub = new StreamHub();
    const streams = Array.from({ length: 7 }, () => connect(hub, "dev-1"));
    const other = connect(hub, "dev-2");
    expect(streams.map((s) => s.ended)).toEqual([true, true, false, false, false, false, false]);
    expect(other.ended).toBe(false);

    hub.publish(CHANNELS.notices, { developerId: "dev-1", kind: "BUSY_WALLET" });
    expect(streams.filter((s) => s.written.length === 1)).toHaveLength(5);
    expect(other.written).toEqual([]);
    hub.closeAll();
    expect(other.ended).toBe(true);
  });

  it("ends streams with their session: one on logout, all others on a password change", () => {
    const hub = new StreamHub();
    const open = (sessionId: string) => {
      const res = new FakeResponse();
      hub.add("dev-1", res as unknown as Response, sessionId);
      return res;
    };
    const [a, b, c] = [open("s-a"), open("s-b"), open("s-c")];
    const other = connect(hub, "dev-2");

    hub.closeSession("s-a");
    expect([a.ended, b.ended, c.ended]).toEqual([true, false, false]);
    hub.closeDeveloper("dev-1", "s-b");
    expect([b.ended, c.ended, other.ended]).toEqual([false, true, false]);
    hub.closeDeveloper("dev-1");
    expect(b.ended).toBe(true);
    hub.closeAll();
  });

  it("ignores notifications without a developer or on channels that are not streamed", () => {
    const hub = new StreamHub();
    const res = connect(hub, "dev-1");
    hub.publish(CHANNELS.notices, { kind: "NO_OWNER" });
    hub.publish(CHANNELS.deliveries, { developerId: "dev-1" });
    expect(res.written).toEqual([]);
    hub.closeAll();
  });
});
