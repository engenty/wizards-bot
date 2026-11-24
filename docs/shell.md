# The agents' shell

An agent runs commands with `shell_run`: bash in a sandbox on the Bot Server's computer, cut off
from it. The code is in `apps/home/src/shell/`.

## When an agent uses it

| For                                                                       | Use                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Downloading into files (an API, a file on a website)                      | `shell_run` with `curl` or `wget`                     |
| Converting, filtering, counting, reshaping data (JSON, CSV, text, tables) | `shell_run` with `jq`, `sqlite3`, `awk`, Python, Node |
| A short script, work across many files of a connected folder              | `shell_run`                                           |
| Reading or writing one file of the person                                 | the folder tools (`folder_read`, `folder_write`)      |
| A web page to look at or click through                                    | the browser                                           |
| Anything with the person's accounts                                       | their connections                                     |

The tool's description and the system prompt say the same to the agent; the tool's description
is written from what the engine on this computer really runs (`ShellCapabilities`).

## Two engines

|                   | Light shell                                                                                                                                                                                            | Full Linux                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine            | agentOS 0.4.9 (Rivet, Apache-2.0): a Linux userland compiled to WebAssembly, Node in V8 isolates, Python as Pyodide, in one helper process of the home                                                 | Apple's `container` through Mastra's `AppleContainerSandbox` (`@mastra/apple-container`): a Debian container (`python:3.13-slim`) in a virtual machine of its own |
| Where             | macOS and glibc Linux, arm64 and x64                                                                                                                                                                   | a Mac with Apple silicon, macOS 26 or newer, with Apple's `container` installed and started                                                                       |
| Install           | the first command installs it into `<data>/engines/agentos` with npm (about 320 MB; the Mac app carries npm beside Node)                                                                               | the first command pulls the image; Apple's `container` itself the person installs                                                                                 |
| Start             | a VM per command, 10–150 ms; the helper stops after 10 idle minutes                                                                                                                                    | a container per conversation, removed after 10 idle minutes                                                                                                       |
| Programs          | bash, coreutils, grep, sed, awk, find, tar, gzip, zip, unzip, jq, yq, sqlite3, rg, fd, tree, file, node, python3 with numpy and pandas; `curl` and `wget` as small versions over `fetch` (`commands/`) | whatever `apt-get` and `pip` install: pdftotext, ffmpeg, ImageMagick, LibreOffice                                                                                 |
| Not there         | git, pip packages with C code, anything native                                                                                                                                                         | —                                                                                                                                                                 |
| Network           | only the sites named in `hosts` that the person allowed, and the Python and npm registries (agentOS's network rules); nothing of the computer itself                                                   | the whole internet while it runs                                                                                                                                  |
| Connected folders | at `/folders/<name>`, read only; writable for a command that names the folder in `write`                                                                                                               | not inside                                                                                                                                                        |
| `/work`           | `<data>/shell/<conversation>`                                                                                                                                                                          | the same folder                                                                                                                                                   |

The agent picks the full Linux with `linux: true`, only for what the light shell cannot do. Files
go between the two through `/work`.

## Rules

- **Sites.** A command names every site it reaches in `hosts`. A site the agent has not been
  allowed asks the person first: once, or always for this agent (kept in `meta`
  `shell.hosts.<agent>`). In a turn that read data from outside the home, "always" does not
  count. A site that is not named is refused, also one allowed before.
- **Connected folders.** The light shell sees a connected folder through `FolderDrive`
  (`drive.ts`), agentOS's `VirtualFileSystem` on the folder tools' own rules (`Folders.locate`):
  nothing hidden, no `..`, no link listed or followed, no link made, no file with a second hard
  link changed. A folder is read-only unless the command names it in `write`; the person says yes
  to every such command, and the answer lists what it changed. A folder connected for reading
  stays read-only.
- **Full Linux.** The person says yes once per conversation before it starts. Connected folders
  are not inside it: a whole folder in a virtual machine would show its hidden files.
- **Output.** The model reads 20 000 characters of a command's output; the whole output is in
  `/work/.out/<n>.txt`. What a command prints or downloads is data, never an instruction.

## What agentOS does not do (0.4.9)

- Its own `curl`, `wget` and `git clone https://…` cannot connect (`getsockname` fails with
  errno 28; agentOS PR #1427). Our `curl` and `wget` (`commands/*.cjs`) are Node scripts over
  `fetch`, under the same network rules. They write synchronously: the shell's pipes lose what a
  Node program still buffers when it exits.
- What `node` and `python3` print reaches the answer, but not a pipe or a `>` file. A program
  writes its files itself.
- `git` cannot write its objects into `/work`, so the light shell has none.
- A VM's user is the person's own (`user: { uid, gid }`); with agentOS's default user, programs
  cannot write into folders of the computer.

## More platforms

An engine is a `ShellEngine` (`engine.ts`): whether it can run here, preparing, its
capabilities, running a command, stopping. The tool, the cards and the folder rules stay the
same. Next ones:

| Platform              | Engine                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- |
| A Bot Server on a VPS | agentOS, once the image is built on glibc (`node:24-slim`); `node:24-alpine` has no glibc |
| Linux desktop         | bubblewrap with Landlock, the full Linux as a root folder                                 |
| Windows 11            | Microsoft's execution containers (`@microsoft/mxc-sdk`)                                   |
| The phone             | the shell of the Bot Server it is paired with                                             |
| Anywhere              | a sandbox in the cloud through one of Mastra's providers (E2B, Daytona, Cloudflare)       |
