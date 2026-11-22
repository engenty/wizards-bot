---

name: excel
description: Make, read and change Excel workbooks (.xlsx).
metadata: { files: [xlsx], words: [excel, xlsx, spreadsheet, workbook, tabellenkalkulation] }
---

Your tools: `excel_make` and `excel_edit`. To read a workbook use `file_read` for a file of this conversation and `folder_read` for one in a connected folder: you get every sheet as rows with their numbers, the columns as letters.

Making a workbook

- `sheets`: each has a `name` and `rows`. The first row is the header. One table per sheet, from A1 on, with no title rows or empty rows above the header.
- A number is a JSON number: 1200.5, not "1,200.50". A date is text like "2026-11-21".
- A text that starts with `=` is a formula: "=SUM(B2:B9)". Use formulas for sums and for everything that depends on other cells, so the sheet stays right when the person changes a number.
- The home does not calculate. Excel works the formulas out when the file opens. Never state a formula's result as if you had read it from the file; work it out yourself when you name a number.

Changing a workbook

- Read it first.
- `cells` sets single cells by their place, like B7. `rows` adds rows under the last one. `addSheet` adds a sheet. `sheet` names the sheet for `cells` and `rows`; without it they go to the first.
- The rest of the workbook stays as it is: its formats, charts and other sheets.
- A changed file of this conversation comes back as a new file in your message. One in a connected folder (`folder` and `path`) is written back there after the person said yes on a card.

What these tools cannot do: charts, pivot tables, colours and number formats of your own, deleting rows. Say so when one of them is asked for.
