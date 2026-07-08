export interface SSEMessage {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent-Events frame parser. Feed decoded string chunks as
 * they arrive off the wire; get back complete frames. Partial lines are
 * buffered across chunks so a frame split mid-stream is reassembled correctly.
 */
export class SSEParser {
  private buffer = "";

  push(chunk: string): SSEMessage[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    const messages: SSEMessage[] = [];
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const msg = SSEParser.parseFrame(frame);
      if (msg) messages.push(msg);
      sep = this.buffer.indexOf("\n\n");
    }
    return messages;
  }

  /** Flush any buffered trailing frame not terminated by a blank line (a
   *  truncated or non-conforming stream). Call once after the stream ends. */
  flush(): SSEMessage[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const msg = SSEParser.parseFrame(rest);
    return msg ? [msg] : [];
  }

  private static parseFrame(frame: string): SSEMessage | null {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return null;
    return event === undefined
      ? { data: dataLines.join("\n") }
      : { event, data: dataLines.join("\n") };
  }
}
