#!/usr/bin/env node
// `wget` in the light shell: downloads URLs over Node's fetch, for the same reason as `curl`, and
// writes its output synchronously like it.
const fs = require("node:fs");
const path = require("node:path");

const KNOWN =
  "-q, -O FILE (or -O - for the output), -P FOLDER, --header='Name: value', -U AGENT, -T SECONDS";

function usage(message) {
  fs.writeSync(2, `wget: ${message}\nwget here knows: ${KNOWN}\n`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const o = { headers: new Headers(), urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : usage(`${arg} needs a value`));
    if (arg === "-q" || arg === "--quiet" || arg === "-nv" || arg === "--no-verbose")
      o.quiet = true;
    else if (arg === "-O") o.output = next();
    else if (arg.startsWith("--output-document=")) o.output = arg.slice(18);
    else if (arg === "-P") o.dir = next();
    else if (arg.startsWith("--directory-prefix=")) o.dir = arg.slice(19);
    else if (arg === "--header") o.header = next();
    else if (arg.startsWith("--header=")) o.header = arg.slice(9);
    else if (arg === "-U") o.headers.set("user-agent", next());
    else if (arg.startsWith("--user-agent=")) o.headers.set("user-agent", arg.slice(13));
    else if (arg === "-T") o.timeout = Number(next());
    else if (arg.startsWith("--timeout=")) o.timeout = Number(arg.slice(10));
    else if (arg === "--no-check-certificate" || arg === "-c" || arg === "--continue") continue;
    else if (arg.startsWith("-")) usage(`option ${arg} is not known here`);
    else o.urls.push(arg);
    if (o.header) {
      const at = o.header.indexOf(":");
      if (at > 0) o.headers.append(o.header.slice(0, at).trim(), o.header.slice(at + 1).trim());
      o.header = undefined;
    }
  }
  if (!o.urls.length) usage("no URL given");
  let failed = 0;
  for (let url of o.urls) {
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    let response;
    try {
      response = await fetch(url, {
        headers: o.headers,
        signal: o.timeout ? AbortSignal.timeout(o.timeout * 1000) : undefined,
      });
    } catch (error) {
      fs.writeSync(
        2,
        `wget: could not reach ${url} (${error.cause?.code ?? error.message}). Only the sites allowed for this command are reachable.\n`,
      );
      failed = 4;
      continue;
    }
    if (!response.ok) {
      fs.writeSync(2, `wget: ${url}: ${response.status} ${response.statusText}\n`);
      failed = 8;
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (o.output === "-") {
      fs.writeSync(1, bytes);
      continue;
    }
    const name = o.output ?? (path.basename(new URL(response.url || url).pathname) || "index.html");
    const target = o.dir ? path.join(o.dir, name) : name;
    if (o.dir) fs.mkdirSync(o.dir, { recursive: true });
    fs.writeFileSync(target, bytes);
    if (!o.quiet) fs.writeSync(2, `wget: saved ${target} (${bytes.length} bytes)\n`);
  }
  process.exit(failed);
}

main().catch((error) => {
  fs.writeSync(2, `wget: ${error.message}\n`);
  process.exit(1);
});
