import { describe, expect, it } from "vitest";
import { SSEParser } from "../src/sse.js";

describe("SSEParser", () => {
  it("reassembles a frame split across chunk boundaries", () => {
    const p = new SSEParser();
    const a = p.push('data: {"x":1}\n\ndata: {"y":2');
    const b = p.push("}\n\n");
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0].data).x).toBe(1);
    expect(JSON.parse(b[0].data).y).toBe(2);
  });

  it("flushes a final frame not terminated by a blank line", () => {
    const p = new SSEParser();
    expect(p.push('data: {"z":3}\n')).toHaveLength(0);
    const flushed = p.flush();
    expect(JSON.parse(flushed[0].data).z).toBe(3);
  });

  it("parses the event field", () => {
    const p = new SSEParser();
    const [m] = p.push("event: message_start\ndata: {}\n\n");
    expect(m.event).toBe("message_start");
  });
});
