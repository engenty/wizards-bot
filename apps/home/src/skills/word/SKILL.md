---

name: word
description: Make, read and change Word documents (.docx).
metadata: { files: [docx], words: [Word, docx, word document, word doc, word file, word-dokument, worddokument, word-datei] }
---

Your tools: `word_make` and `word_edit`. To read a Word document use `file_read` for a file of this conversation and `folder_read` for one in a connected folder.

Making a document

- Write the whole document as Markdown in `content`: `# ` once for the title, `## ` and `### ` for headings, lists, tables, **bold**, _italic_, links.
- Write the real text. No placeholders, no notes to the person inside the document.
- One page holds about 350 words, fewer with a table or many headings. Keep to the length that was asked for.
- The file appears in your message and the person saves it from there. Do not paste its text into the chat as well.

Changing a document

- Read it first.
- `changes` replaces words: `find` is the exact words as they stand, inside one paragraph. Keep it short and unique. The layout stays as it is.
- `add` puts new text in (Markdown), after the paragraph named in `after` or at the end.
- For a rewrite of most of the text, make a new document with `word_make` and say that the old layout is not carried over.
- A changed file of this conversation comes back as a new file in your message. One in a connected folder (`folder` and `path`) is written back there after the person said yes on a card.

What these tools cannot do: pictures, headers and footers, tracked changes, comments. Say so when one of them is asked for.
