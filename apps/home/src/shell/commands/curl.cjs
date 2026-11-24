#!/usr/bin/env node
// `curl` in the light shell: the common options over Node's fetch. agentOS's own curl cannot
// open a connection (its sockets lack getsockname), Node's fetch can, under the same network
// rules. Options it does not know are refused with the list it knows.
// Output is written synchronously: the shell's pipes lose what is still buffered at exit.
const fs = require("node:fs");
const path = require("node:path");

const KNOWN =
  "-o FILE, -O, -L, -s, -S, -f, -i, -I, -H 'Name: value', -d DATA, --data-raw, --data-binary @FILE, --data-urlencode, --json, -G, -X METHOD, -A AGENT, -e REFERER, -u USER:PASS, -m SECONDS, -w '%{http_code}', --compressed, --retry N, -k";

function usage(message) {
  fs.writeSync(2, `curl: ${message}\ncurl here knows: ${KNOWN}\n`);
  process.exit(2);
}

function parse(argv) {
  const o = { headers: [], data: [], urls: [], method: undefined, follow: false, silent: false };
  const takes = new Set(["-o", "-H", "-d", "-X", "-A", "-e", "-u", "-m", "-w"]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${arg} needs a value`);
      return argv[++i];
    };
    // Short options together: -sSL, -sLo file.
    if (/^-[a-zA-Z]{2,}$/.test(arg)) {
      const letters = arg.slice(1).split("");
      for (const [index, letter] of letters.entries()) {
        const flag = `-${letter}`;
        if (takes.has(flag) && index < letters.length - 1) usage(`${flag} needs a value`);
        argv.splice(i + 1 + index, 0, flag);
      }
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    let inline;
    if (eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = () => (inline !== undefined ? inline : next());
    switch (arg) {
      case "-o":
      case "--output":
        o.output = value();
        break;
      case "-O":
      case "--remote-name":
        o.remoteName = true;
        break;
      case "-L":
      case "--location":
        o.follow = true;
        break;
      case "-s":
      case "--silent":
        o.silent = true;
        break;
      case "-S":
      case "--show-error":
        o.showError = true;
        break;
      case "-f":
      case "--fail":
        o.fail = true;
        break;
      case "-i":
      case "--include":
        o.include = true;
        break;
      case "-I":
      case "--head":
        o.method = "HEAD";
        o.include = true;
        break;
      case "-H":
      case "--header":
        o.headers.push(value());
        break;
      case "-d":
      case "--data":
      case "--data-ascii":
      case "--data-raw":
      case "--data-binary":
        o.data.push({ text: value(), file: arg !== "--data-raw" });
        break;
      case "--data-urlencode":
        o.data.push({ encode: value() });
        break;
      case "--json":
        o.data.push({ text: value(), file: true });
        o.headers.push("Content-Type: application/json", "Accept: application/json");
        break;
      case "-G":
      case "--get":
        o.get = true;
        break;
      case "-X":
      case "--request":
        o.method = value();
        break;
      case "-A":
      case "--user-agent":
        o.headers.push(`User-Agent: ${value()}`);
        break;
      case "-e":
      case "--referer":
        o.headers.push(`Referer: ${value()}`);
        break;
      case "-u":
      case "--user":
        o.headers.push(`Authorization: Basic ${Buffer.from(value()).toString("base64")}`);
        break;
      case "-m":
      case "--max-time":
        o.maxTime = Number(value());
        break;
      case "-w":
      case "--write-out":
        o.writeOut = value();
        break;
      case "--retry":
        value();
        break;
      case "--compressed":
      case "-k":
      case "--insecure":
      case "-#":
      case "--progress-bar":
        break;
      case "--url":
        o.urls.push(value());
        break;
      default:
        if (arg.startsWith("-")) usage(`option ${arg} is not known here`);
        o.urls.push(arg);
    }
  }
  return o;
}

function body(o) {
  const parts = o.data.map((part) => {
    if (part.encode !== undefined) {
      const at = part.encode.indexOf("=");
      return at < 0
        ? encodeURIComponent(part.encode)
        : `${part.encode.slice(0, at)}=${encodeURIComponent(part.encode.slice(at + 1))}`;
    }
    if (part.file && part.text.startsWith("@")) return fs.readFileSync(part.text.slice(1), "utf8");
    return part.text;
  });
  return parts.join("&");
}

function writeOut(format, info) {
  return format
    .replace(/%\{http_code\}|%\{response_code\}/g, String(info.status))
    .replace(/%\{size_download\}/g, String(info.size))
    .replace(/%\{url_effective\}/g, info.url)
    .replace(/%\{content_type\}/g, info.type)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (!o.urls.length) usage("no URL given");
  let failed = 0;
  for (let url of o.urls) {
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    const headers = new Headers();
    for (const line of o.headers) {
      const at = line.indexOf(":");
      if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    let method = o.method;
    let payload;
    if (o.data.length) {
      const data = body(o);
      if (o.get) url += (url.includes("?") ? "&" : "?") + data;
      else {
        payload = data;
        method ??= "POST";
        if (!headers.has("content-type"))
          headers.set("content-type", "application/x-www-form-urlencoded");
      }
    }
    const signal = o.maxTime ? AbortSignal.timeout(o.maxTime * 1000) : undefined;
    let response;
    try {
      response = await fetch(url, {
        method: method ?? "GET",
        headers,
        body: payload,
        redirect: o.follow ? "follow" : "manual",
        signal,
      });
    } catch (error) {
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();
      const cause = error.cause?.code ?? error.name ?? "";
      if (!o.silent || o.showError)
        fs.writeSync(
          2,
          cause === "TimeoutError"
            ? `curl: (28) ${host} took longer than ${o.maxTime} s\n`
            : `curl: (7) could not reach ${host} (${cause || error.message}). Only the sites allowed for this command are reachable.\n`,
        );
      failed = cause === "TimeoutError" ? 28 : 7;
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const head = `HTTP/1.1 ${response.status} ${response.statusText}\r\n${[...response.headers]
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n")}\r\n\r\n`;
    if (o.fail && response.status >= 400) {
      if (!o.silent || o.showError)
        fs.writeSync(2, `curl: (22) The requested URL returned error: ${response.status}\n`);
      failed = 22;
      continue;
    }
    let target = o.output;
    if (o.remoteName) {
      target = path.basename(new URL(response.url || url).pathname) || "index.html";
    }
    const out = o.include ? Buffer.concat([Buffer.from(head), bytes]) : bytes;
    if (target && target !== "-") fs.writeFileSync(target, method === "HEAD" ? head : out);
    else fs.writeSync(1, method === "HEAD" ? head : out);
    if (o.writeOut)
      fs.writeSync(
        1,
        writeOut(o.writeOut, {
          status: response.status,
          size: bytes.length,
          url: response.url || url,
          type: response.headers.get("content-type") ?? "",
        }),
      );
  }
  process.exit(failed);
}

main().catch((error) => {
  fs.writeSync(2, `curl: ${error.message}\n`);
  process.exit(1);
});
