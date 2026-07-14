import { describe, expect, it } from "vitest";
import { isLoopbackAuthority, isLoopbackOrigin, isTrustedRequest } from "../src/server.js";

const PORT = 4319;

describe("collector request guard", () => {
  it("accepts a trusted Node client (loopback Host, no Origin)", () => {
    expect(isTrustedRequest({ host: "127.0.0.1:4319" }, PORT)).toBe(true);
    expect(isTrustedRequest({ host: "localhost:4319" }, PORT)).toBe(true);
    expect(isTrustedRequest({ host: "[::1]:4319" }, PORT)).toBe(true);
  });

  it("accepts the same-origin dashboard (loopback Host + Origin)", () => {
    expect(
      isTrustedRequest({ host: "127.0.0.1:4319", origin: "http://127.0.0.1:4319" }, PORT),
    ).toBe(true);
    expect(
      isTrustedRequest({ host: "localhost:4319", origin: "http://localhost:4319" }, PORT),
    ).toBe(true);
  });

  it("rejects a DNS-rebinding Host", () => {
    expect(isTrustedRequest({ host: "evil.com:4319" }, PORT)).toBe(false);
    expect(isLoopbackAuthority("evil.com:4319", PORT)).toBe(false);
  });

  it("rejects a loopback Host with a foreign Origin (exfil attempt)", () => {
    expect(isTrustedRequest({ host: "127.0.0.1:4319", origin: "http://evil.com" }, PORT)).toBe(
      false,
    );
    expect(isLoopbackOrigin("http://evil.com", PORT)).toBe(false);
  });

  it("rejects the wrong port", () => {
    expect(isLoopbackAuthority("127.0.0.1:9999", PORT)).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1:9999", PORT)).toBe(false);
  });

  it("rejects a missing Host", () => {
    expect(isTrustedRequest({}, PORT)).toBe(false);
  });
});
