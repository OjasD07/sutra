/**
 * Minimal, spec-conformant Server-Sent Events parser.
 *
 * Handles: CRLF/LF line endings, multi-line `data:` fields, comment lines
 * (DeepSeek sends `: keep-alive` while queued), blank keep-alive lines, and
 * chunk boundaries that split lines or multi-byte UTF-8 sequences.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "message";

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      return null;
    }
    const ev = { event: eventName, data: dataLines.join("\n") };
    dataLines = [];
    eventName = "message";
    return ev;
  };

  const processLine = (line: string): SseEvent | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    return null;
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
      // A lone trailing "\r" may be the first half of "\r\n"; wait for more.
      if (buffer[idx] === "\r" && idx === buffer.length - 1) break;
      const line = buffer.slice(0, idx);
      const sepLen = buffer.startsWith("\r\n", idx) ? 2 : 1;
      buffer = buffer.slice(idx + sepLen);
      const ev = processLine(line);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const ev = processLine(buffer.replace(/\r$/, ""));
    if (ev) yield ev;
  }
  const last = flush();
  if (last) yield last;
}
