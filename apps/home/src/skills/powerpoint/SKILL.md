---

name: powerpoint
description: Make, read and change PowerPoint decks (.pptx).
metadata: { files: [pptx], words: [powerpoint, pptx, slide deck, presentation, präsentation, folien] }
---

Your tools: `powerpoint_make` and `powerpoint_edit`. To read a deck use `file_read` for a file of this conversation and `folder_read` for one in a connected folder: you get the slides with their numbers.

Making a deck

- `content` is a Markdown outline. `# ` is the deck's title, the line under it the subtitle. Every `## ` starts a slide. Under it: `- ` points (two spaces deeper for a second level), plain lines, or a table.
- A slide makes one point: a title that says it, and at most five short points. Split what does not fit. A table gets a slide of its own, with at most six rows.
- Write what the audience reads, not what the speaker says. No "Agenda" or "Thank you" slide unless it was asked for.

Changing a deck

- Read it first.
- `changes` replaces words: `find` is the exact words of one line.
- `remove` takes slides out by their numbers. `add` puts new slides in (the same outline, from `## ` on), after slide `after` or at the end. They take the deck's own design.
- A changed file of this conversation comes back as a new file in your message. One in a connected folder (`folder` and `path`) is written back there after the person said yes on a card.

What these tools cannot do: pictures, speaker notes, animations, another design than the plain one. Say so when one of them is asked for.
