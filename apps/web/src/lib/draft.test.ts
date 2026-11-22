import type { Document } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { type Draft, type DraftEvent, draftReducer, saveDue, startDraft, unsaved } from "./draft";

const document = (version: number, content: string, updatedBy: "you" | "agent" = "agent") =>
  ({
    id: "doc_1",
    title: "Week plan",
    format: "markdown",
    version,
    updatedAt: "2026-11-21T09:12:00.000Z",
    updatedBy,
    conversationId: "cnv_1",
    content,
  }) satisfies Document;

const through = (draft: Draft, ...events: DraftEvent[]) => events.reduce(draftReducer, draft);

describe("when a document is saved", () => {
  it("is not due while the text is the home's", () => {
    const draft = startDraft(document(1, "# Plan\n"));
    expect(unsaved(draft)).toBe(false);
    expect(saveDue(draft)).toBe(false);
  });

  it("is due after a change, and no longer once the change is taken back", () => {
    const edited = through(startDraft(document(1, "# Plan\n")), {
      type: "edited",
      text: "# Plan B\n",
    });
    expect(saveDue(edited)).toBe(true);
    expect(saveDue(through(edited, { type: "edited", text: "# Plan\n" }))).toBe(false);
  });

  it("waits while a save is on its way, then saves what was typed meanwhile", () => {
    const sending = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "ab\n" },
      { type: "saving" },
      { type: "edited", text: "abc\n" },
    );
    expect(saveDue(sending)).toBe(false);
    const taken = through(sending, { type: "saved", document: document(2, "ab\n", "you") });
    expect(taken.base).toBe(2);
    expect(taken.text).toBe("abc\n");
    expect(saveDue(taken)).toBe(true);
    const done = through(
      taken,
      { type: "saving" },
      { type: "saved", document: document(3, "abc\n", "you") },
    );
    expect(unsaved(done)).toBe(false);
  });

  it("does not try again by itself after a failure, but with the next change", () => {
    const failed = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "ab\n" },
      { type: "saving" },
      { type: "failed" },
    );
    expect(failed.saving).toBe("failed");
    expect(saveDue(failed)).toBe(false);
    expect(saveDue(through(failed, { type: "edited", text: "abc\n" }))).toBe(true);
  });
});

describe("a version from the home", () => {
  it("is taken as it comes while nothing is unsaved", () => {
    const draft = through(startDraft(document(1, "a\n")), {
      type: "arrived",
      document: document(2, "a\nb\n"),
    });
    expect(draft).toMatchObject({ base: 2, saved: "a\nb\n", text: "a\nb\n", conflict: null });
  });

  it("is left alone when it is the one already here, or an older one", () => {
    const draft = through(startDraft(document(2, "a\n")), { type: "edited", text: "ab\n" });
    expect(through(draft, { type: "arrived", document: document(2, "a\n") })).toBe(draft);
    expect(through(draft, { type: "arrived", document: document(1, "old\n") })).toBe(draft);
  });

  it("is a conflict while there is unsaved text, and nothing is saved until it is settled", () => {
    const draft = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "mine\n" },
      { type: "arrived", document: document(2, "theirs\n") },
    );
    expect(draft.conflict?.version).toBe(2);
    expect(draft.text).toBe("mine\n");
    expect(saveDue(draft)).toBe(false);
    // Typing goes on; the question stays.
    expect(saveDue(through(draft, { type: "edited", text: "mine too\n" }))).toBe(false);
  });

  it("is no conflict when it is this browser's own save, told before its answer came", () => {
    const sending = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "ab\n" },
      { type: "saving" },
      { type: "edited", text: "abc\n" },
      { type: "arrived", document: document(2, "ab\n", "you") },
    );
    expect(sending).toMatchObject({ base: 2, saved: "ab\n", text: "abc\n", conflict: null });
    const answered = through(sending, { type: "saved", document: document(2, "ab\n", "you") });
    expect(answered).toMatchObject({ base: 2, saved: "ab\n", saving: "idle" });
    expect(saveDue(answered)).toBe(true);
  });

  it("is a conflict when the home refuses a save for it", () => {
    const refused = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "mine\n" },
      { type: "saving" },
      { type: "refused", document: document(2, "theirs\n") },
    );
    expect(refused).toMatchObject({ saving: "idle", sent: null, text: "mine\n" });
    expect(refused.conflict?.content).toBe("theirs\n");
    expect(saveDue(refused)).toBe(false);
  });

  it("is no conflict when it holds the very text that is here", () => {
    const draft = through(
      startDraft(document(1, "a\n")),
      { type: "edited", text: "same\n" },
      { type: "arrived", document: document(2, "same\n") },
    );
    expect(draft).toMatchObject({ base: 2, conflict: null });
    expect(unsaved(draft)).toBe(false);
  });
});

describe("what a conflict leaves", () => {
  const conflicted = through(
    startDraft(document(1, "a\n")),
    { type: "edited", text: "mine\n" },
    { type: "arrived", document: document(2, "theirs\n") },
  );

  it("keeps the person's text and saves it over the newer version", () => {
    const kept = through(conflicted, { type: "keepMine" });
    expect(kept).toMatchObject({ base: 2, text: "mine\n", conflict: null });
    expect(saveDue(kept)).toBe(true);
  });

  it("takes the newer text and has nothing left to save", () => {
    const taken = through(conflicted, { type: "takeNewer" });
    expect(taken).toMatchObject({ base: 2, text: "theirs\n", saved: "theirs\n", conflict: null });
    expect(saveDue(taken)).toBe(false);
  });
});
