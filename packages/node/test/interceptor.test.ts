import { describe, expect, it } from "vitest";
import { isStreamingResponse } from "../src/interceptor.js";

describe("isStreamingResponse", () => {
  it("treats an SSE content-type as a stream", () => {
    expect(isStreamingResponse("text/event-stream", false, true)).toBe(true);
    expect(isStreamingResponse("text/event-stream; charset=utf-8", true, true)).toBe(true);
  });

  it("routes a failed stream-intent request (non-2xx JSON) to the non-stream path", () => {
    // A 429 rate-limit error on a stream:true request comes back as JSON, not SSE.
    // It must NOT be parsed as an empty stream — it should reach the error path.
    expect(isStreamingResponse("application/json", true, false)).toBe(false);
    expect(isStreamingResponse("application/json; charset=utf-8", true, false)).toBe(false);
  });

  it("treats an ok stream-intent response with no JSON content-type as a stream", () => {
    expect(isStreamingResponse("", true, true)).toBe(true);
  });

  it("is not a stream when neither SSE nor stream intent is present", () => {
    expect(isStreamingResponse("application/json", false, true)).toBe(false);
  });
});
