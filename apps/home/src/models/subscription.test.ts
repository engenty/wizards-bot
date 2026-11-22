import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLIENTS } from "./subscription.ts";

describe("Claude's output", () => {
  test("a failed API call is a failure, not an answer", () => {
    const read = CLIENTS.claude.parser();
    const line = (event: unknown) => read(JSON.stringify(event));
    assert.deepEqual(
      line({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 400 You have reached your specified API usage limits.",
            },
          ],
        },
      }),
      [
        {
          kind: "failure",
          detail: "API Error: 400 You have reached your specified API usage limits.",
        },
      ],
    );
    assert.deepEqual(
      line({
        type: "assistant",
        message: { model: "claude", content: [{ type: "text", text: "Hi" }] },
      }),
      [{ kind: "text", text: "Hi" }],
    );
  });
});
