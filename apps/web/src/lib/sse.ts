/** One event of the home's stream: its JSON, and its id when the home can replay it. */
interface Frame {
  id?: string;
  data: string;
}

/**
 * Reads server-sent events from text as it arrives: give it each piece, it gives back the
 * frames that are whole by then. Comment lines (the home's sign of life) and frames without
 * data are left out.
 */
export function frameReader(): (chunk: string) => Frame[] {
  let buffer = "";
  // A CR at the end of a piece may be half of a CR LF: it waits for the next piece.
  let held = "";
  return (chunk) => {
    const text = held + chunk;
    held = text.endsWith("\r") ? "\r" : "";
    buffer += text.slice(0, text.length - held.length).replace(/\r\n?/g, "\n");
    const frames: Frame[] = [];
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (data.length) {
        frames.push(id ? { id, data: data.join("\n") } : { data: data.join("\n") });
      }
    }
    return frames;
  };
}
