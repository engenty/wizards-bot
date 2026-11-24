---

name: google-workspace
description: Work in Google Docs, Sheets and Slides through a connected Google account.
metadata: { words: [google docs, google doc, google sheets, google sheet, google slides, google drive, google workspace, gdoc, gsheet, docs.google.com] }
---

Google Docs, Sheets and Slides are reached through a connection: the person's Google account over MCP. You have no Google tools of your own.

With a connection

- Your instructions name the connected accounts and apps. A Google one is called after what it reaches: google-drive, google-docs, google-sheets, google-slides.
- `connection_tools` with its name lists what it can do, one line per tool; with a tool's name as well it gives that tool in full, with its inputs. Read that before the first call. Do not guess a tool's name or its inputs.
- `connection_call` uses one tool. Reading runs at once. A change shows the person an approval card and ends your turn; the result arrives as the next message.
- Find the file first: search Drive by its name, or take the id from a link (the part between `/d/` and the next `/`). Read it, then change only what was asked.
- Docs and Slides are changed with a list of requests, Sheets by ranges like `Sheet1!A1:C5`. Positions move when you insert or delete: work from the end of a document towards its start, or read again between two changes.

Without a connection

- Say that no Google account is connected and offer to connect one. Connecting is the main agent's: it has `connection_add`.
- Google runs one address per app. Connect the one the task needs:
  - google-drive (find, read and create files): `https://drivemcp.googleapis.com/mcp/v1`
  - google-docs: `https://docsmcp.googleapis.com/mcp/v1`
  - google-sheets: `https://sheetsmcp.googleapis.com/mcp/v1`
  - google-slides: `https://slidesmcp.googleapis.com/mcp/v1`
- These connect without a sign-in and list their tools. Google asks for the sign-in at the first call, and takes it only from an app registered with Google. When a call answers "does not support dynamic client registration", this Bot Server cannot sign in to Google yet: say so plainly, remove the connection with `connection_remove`, and offer the way below.
- `connection_find` searches the public registry for other services that reach Google. Such a service sees the person's files: say who runs it and let the person decide before you connect it.
- What always works: make a Word, Excel or PowerPoint file with the skills word, excel or powerpoint. Google Drive opens them as Docs, Sheets and Slides.
