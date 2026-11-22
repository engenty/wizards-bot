import assert from "node:assert/strict";
import { get } from "node:http";
import { after, before, describe, test } from "node:test";
import type { Artifact, ArtifactMeta, Event } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { ARTIFACT_LIMIT, ArtifactRefused } from "./artifacts.ts";
import { checkPage, PAGE_HEADER_POLICY, PAGE_POLICY, wrapPage } from "./page.ts";

const CHART = `<h1>Rain in March</h1>
<svg id="chart" viewBox="0 0 400 200"></svg>
<script src="/artifact-lib/d3.js"></script>
<script>d3.select("#chart").append("rect").attr("width", 40).attr("height", 120);</script>`;

/** A policy as its directives, each with its sources. */
const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );

describe("the policy of an artifact's page", () => {
  const policy = directives(PAGE_POLICY);
  const header = directives(PAGE_HEADER_POLICY);

  test("names no address on the network", () => {
    // Everything a page may load is written in it.
    const inPage = new Set(["'none'", "'unsafe-inline'", "data:", "blob:"]);
    for (const [name, sources] of policy) {
      for (const source of sources) assert.ok(inPage.has(source), `${name} allows ${source}`);
    }
    assert.deepEqual(policy.get("default-src"), ["'none'"]);
    assert.deepEqual(policy.get("connect-src"), ["'none'"]);
    assert.deepEqual(policy.get("form-action"), ["'none'"]);
    assert.deepEqual(policy.get("base-uri"), ["'none'"]);
    assert.ok(!PAGE_POLICY.includes("unsafe-eval"));
  });

  test("names the home nowhere: a page asks no one, not even for a library", () => {
    for (const [name, sources] of policy) assert.ok(!sources.includes("'self'"), name);
    // `data:` is for the modules of the import map, whose address is their own text.
    assert.deepEqual(policy.get("script-src"), ["'unsafe-inline'", "data:"]);
    assert.deepEqual(policy.get("img-src"), ["data:", "blob:"]);
    assert.deepEqual(policy.get("style-src"), ["'unsafe-inline'"]);
  });

  test("as a header gives the page an origin of its own, and only the home may frame it", () => {
    assert.deepEqual(header.get("sandbox"), ["allow-scripts", "allow-modals"]);
    assert.deepEqual(header.get("frame-ancestors"), ["'self'"]);
    for (const [name, sources] of policy) assert.deepEqual(header.get(name), sources);
  });
});

describe("the page the home wraps", () => {
  const content =
    '<meta http-equiv="content-security-policy" content="default-src *"><p id="own">Hello</p>';
  const page = wrapPage({ title: "</title><script>alert(1)</script>", content });

  test("puts the home's policy before anything the agent wrote", () => {
    const policy = page.indexOf(
      `<meta http-equiv="content-security-policy" content="${PAGE_POLICY}">`,
    );
    assert.ok(policy > 0);
    assert.ok(policy < page.indexOf("<title>"));
    assert.ok(page.indexOf("</head>") < page.indexOf(content));
    // The title is text: it opens no tag.
    assert.ok(page.includes("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>"));
    assert.equal(page.split("alert(1)").length, 2);
  });

  test("has the print layout: A4 with margins, colours kept, charts whole", () => {
    assert.match(page, /@page \{ size: A4; margin: 14mm; \}/);
    assert.match(page, /@media print \{/);
    assert.match(page, /print-color-adjust: exact/);
    assert.match(page, /svg, canvas, img, video \{ max-width: 100% !important; \}/);
    assert.match(page, /break-inside: avoid/);
    assert.match(page, /\.no-print, #artifact-note \{ display: none !important; \}/);
  });

  test("prints when its frame asks, and maps nothing a page does not import", () => {
    const map = /<script type="importmap">(.*?)<\/script>/.exec(page)?.[1] ?? "";
    assert.deepEqual(JSON.parse(map), { imports: {} });
    assert.match(page, /event\.data\.type === "artifact\.print"\) print\(\)/);
  });
});

describe("a page with libraries", () => {
  const importsOf = (page: string): Record<string, string> =>
    (
      JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(page)?.[1] ?? "{}") as {
        imports: Record<string, string>;
      }
    ).imports;
  const textOfModule = (address = ""): string =>
    decodeURIComponent(address.replace(/^data:text\/javascript;charset=utf-8,/, ""));

  test("holds D3 where its tag stood, and names no address of the home", () => {
    const page = wrapPage({ title: "Rain", content: CHART });
    assert.match(page, /<script>\/\/ https:\/\/d3js\.org v7\./);
    assert.ok(!page.includes("/artifact-lib/"));
    // The page's own script still follows the library.
    assert.ok(page.indexOf("d3js.org") < page.indexOf('d3.select("#chart")'));
    // Nothing in the library ends its tag early.
    assert.equal(page.split("</script>").length - 1, 4);
  });

  test("holds three.js and the addons it imports as modules that are their own address", () => {
    const page = wrapPage({
      title: "Scene",
      content: `<canvas id="c"></canvas><script type="module">
        import * as THREE from "three";
        import { OrbitControls } from "three/addons/controls/OrbitControls.js";
      </script>`,
    });
    const imports = importsOf(page);
    assert.deepEqual(Object.keys(imports).sort(), [
      "three",
      "three/addons/controls/OrbitControls.js",
      "three/core",
    ]);
    for (const address of Object.values(imports)) {
      assert.match(address, /^data:text\/javascript;charset=utf-8,/);
      // Written into a script tag as it is: nothing in it can end the tag.
      assert.ok(!address.includes("<"));
    }
    // three.js names its core as the import map does, not by a path beside itself.
    const three = textOfModule(imports.three);
    assert.match(three, /from 'three\/core'/);
    assert.ok(!/from '\.\//.test(three));
    assert.match(textOfModule(imports["three/addons/controls/OrbitControls.js"]), /from 'three'/);
  });

  test("names an addon's neighbours as the page would, and follows them", () => {
    const imports = importsOf(
      wrapPage({
        title: "Model",
        content:
          '<script type="module">import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";</script>',
      }),
    );
    const loader = textOfModule(imports["three/addons/loaders/GLTFLoader.js"]);
    assert.match(loader, /from 'three\/addons\/utils\/BufferGeometryUtils\.js'/);
    assert.ok(!/from '\.\.\//.test(loader));
    assert.ok("three/addons/utils/BufferGeometryUtils.js" in imports);
    assert.ok("three" in imports && "three/core" in imports);
  });
});

describe("the check of a page", () => {
  test("lets a page pass that holds everything itself", () => {
    assert.deepEqual(checkPage(CHART), { refused: [], notes: [] });
    const scene = `<canvas id="c"></canvas><script type="module">
      import * as THREE from "three";
      import { OrbitControls } from "three/addons/controls/OrbitControls.js";
    </script><img src="data:image/png;base64,AAAA"><svg><use href="#mark"/></svg>
    <a href="https://example.com">a link</a>`;
    assert.deepEqual(checkPage(scene), { refused: [], notes: [] });
  });

  test("refuses what loads from an address, and says what to use", () => {
    const { refused } = checkPage(
      `<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
       <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
       <img src="https://example.com/logo.png">
       <style>@import url("https://example.com/a.css"); body { background: url(/v1/avatar.png) }</style>
       <script type="module">import { Chart } from "https://esm.sh/chart.js"; import * as d3 from "d3";</script>
       <script src="/artifact-lib/jquery.js"></script>
       <script type="module" src="/artifact-lib/three.js"></script>`,
    );
    assert.equal(refused.length, 9);
    assert.match(
      refused[0] ?? "",
      /^<script> loads https:\/\/cdn\.jsdelivr\.net\/npm\/d3@7\. Load D3/,
    );
    assert.ok(refused.some((line) => line.startsWith("<link> loads https://fonts.googleapis.com")));
    assert.ok(refused.some((line) => line.startsWith("<img> loads https://example.com/logo.png")));
    assert.ok(refused.some((line) => line.startsWith("A <style> loads https://example.com/a.css")));
    assert.ok(refused.some((line) => line.startsWith("A <style> loads /v1/avatar.png")));
    assert.ok(
      refused.some((line) => line.startsWith('A script imports "https://esm.sh/chart.js"')),
    );
    assert.ok(refused.some((line) => line.startsWith('A script imports "d3". D3 is not imported')));
    assert.ok(refused.some((line) => line.startsWith("<script> loads /artifact-lib/jquery.js")));
    // three.js is imported by name: a tag cannot load it.
    assert.ok(refused.some((line) => line.startsWith("<script> loads /artifact-lib/three.js")));
  });

  test("reads a tag inside a script or a comment as text, not as markup", () => {
    const page = `<!-- <script src="https://cdn.example/d3.js"></script> -->
      <script>el.innerHTML = '<img src="' + picture + '">';</script>`;
    assert.deepEqual(checkPage(page).refused, []);
  });

  test("notes a call that asks an address for data", () => {
    const { refused, notes } = checkPage(
      `<script>fetch("/v1/agents"); d3.csv("data.csv"); d3.csvParse(text);</script>`,
    );
    assert.deepEqual(refused, []);
    assert.equal(notes.length, 2);
    assert.match(notes[0] ?? "", /^The page calls fetch\(\)/);
    assert.match(notes[1] ?? "", /^The page calls d3\.csv\(\)/);
  });
});

describe("artifacts of a home", () => {
  let t: TestHome;
  let conversationId: string;
  let id: string;
  before(async () => {
    t = await testHome("Ada");
    conversationId = t.home.store.mainAgent().conversationId;
  });
  after(() => t.stop());

  /** Asks without a token, and with the path exactly as written. */
  const bare = (path: string): Promise<{ status: number; headers: Headers; text: string }> =>
    new Promise((resolve, reject) => {
      get(`${t.url}${path}`, { path }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: new Headers(response.headers as Record<string, string>),
            text,
          }),
        );
      }).on("error", reject);
    });

  test("an agent makes one; it is named in the message and told to the devices", async () => {
    const events: Event[] = [];
    const stop = t.home.events.subscribe((stored) => events.push(stored.event));
    t.model.script.push(
      { calls: [{ name: "artifact_write", arguments: { title: "Rain in March", html: CHART } }] },
      { text: "The chart is beside the chat." },
    );
    const reply = await t.say("Chart the rain");
    stop();
    const part = reply.parts.find((candidate) => candidate.type === "artifact");
    assert.equal(part?.title, "Rain in March");
    id = part?.artifactId as string;
    assert.match(id, /^art_/);
    const told = events.find((event) => event.type === "artifact.updated");
    assert.deepEqual(told?.artifact, {
      id,
      title: "Rain in March",
      format: "html",
      version: 1,
      updatedAt: told?.artifact.updatedAt,
      conversationId,
    });
    const result = t.model.requests.at(-1)?.messages.find((message) => message.role === "tool");
    assert.match(result?.content ?? "", /^Saved as art_\w+, version 1\./);
  });

  test("a device reads it, with its page's address, and lists a conversation's artifacts", async () => {
    const artifact = (await (await t.request(`/v1/artifacts/${id}`)).json()) as Artifact;
    assert.equal(artifact.content, CHART);
    assert.equal(artifact.version, 1);
    assert.match(artifact.page, new RegExp(`^/v1/artifacts/${id}/page\\?until=\\d+&key=[\\w-]+$`));
    const list = (await (
      await t.request(`/v1/conversations/${conversationId}/artifacts`)
    ).json()) as {
      artifacts: ArtifactMeta[];
    };
    assert.deepEqual(
      list.artifacts.map((entry) => [entry.id, entry.title, entry.version]),
      [[id, "Rain in March", 1]],
    );
    assert.equal((await t.request("/v1/artifacts/art_none")).status, 404);
    assert.equal((await fetch(`${t.url}/v1/artifacts/${id}`)).status, 401);
  });

  test("the agent is told when an artifact is the answer, and which are beside the chat", async () => {
    t.model.script.push({ text: "Yes." });
    await t.say("Is the chart there?");
    const system = t.model.requests.at(-1)?.messages[0]?.content ?? "";
    assert.match(system, /An artifact is one page you write with `artifact_write`/);
    assert.match(system, /<script src="\/artifact-lib\/d3\.js"><\/script>/);
    assert.match(system, /import \* as THREE from "three"/);
    assert.match(system, /<main class="sheet">/);
    assert.match(system, /Artifacts beside this chat/);
    assert.match(system, /- "Rain in March" \(art_\w+\), version 1/);
  });

  test("a second write with its id is a new version, and the first one is kept", async () => {
    const next = CHART.replace("March", "April");
    t.model.script.push(
      { calls: [{ name: "artifact_read", arguments: { id } }] },
      {
        calls: [{ name: "artifact_write", arguments: { id, title: "Rain in April", html: next } }],
      },
      { text: "Changed." },
    );
    await t.say("Make it April");
    const read = t.model.requests
      .at(-1)
      ?.messages.filter((message) => message.role === "tool")
      .map((message) => message.content);
    assert.ok(read?.some((text) => text.startsWith("# Rain in March (version 1)\n\n<h1>")));
    const artifact = t.home.artifacts.get(id);
    assert.deepEqual([artifact?.version, artifact?.title], [2, "Rain in April"]);
    assert.equal(t.home.artifacts.version(id, 1), CHART);
    assert.equal(t.home.artifacts.version(id, 2), next);
    assert.equal(t.home.artifacts.list(conversationId).length, 1);
  });

  test("its page opens with its key and without a token, closed off by its headers", async () => {
    const { page } = (await (await t.request(`/v1/artifacts/${id}`)).json()) as Artifact;
    const answer = await bare(page);
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(answer.headers.get("content-security-policy"), PAGE_HEADER_POLICY);
    assert.equal(answer.headers.get("cache-control"), "private, no-store");
    assert.equal(answer.headers.get("referrer-policy"), "no-referrer");
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.equal(answer.headers.get("access-control-allow-origin"), null);
    assert.ok(answer.text.includes("<title>Rain in April</title>"));
    assert.ok(answer.text.includes("<h1>Rain in April</h1>"));
    // Neither the device's token nor the key is written into the page.
    assert.ok(!answer.text.includes(t.token));
    assert.ok(!answer.text.includes(new URL(page, t.url).searchParams.get("key") as string));
  });

  test("a page's address stops working after an hour, and opens no other page", async () => {
    const other = t.home.artifacts.write({
      title: "Other",
      content: "<p>Other</p>",
      conversationId,
    });
    const path = t.home.artifacts.pagePath(id);
    const key = new URL(path, t.url).search;
    const refusedWith = async (candidate: string) => {
      const answer = await bare(candidate);
      assert.equal(answer.status, 403, candidate);
      assert.ok(!answer.text.includes("Rain in April"));
      assert.ok(!answer.text.includes("Other</p>"));
    };
    await refusedWith(`/v1/artifacts/${id}/page`);
    await refusedWith(`/v1/artifacts/${id}/page${key.slice(0, -2)}xx`);
    await refusedWith(`/v1/artifacts/${other.id}/page${key}`);
    await refusedWith(t.home.artifacts.pagePath(id, Date.now() - 61 * 60_000));
    // A later time with the old key is not signed.
    await refusedWith(path.replace(/until=\d+/, `until=${Math.floor(Date.now() / 1000) + 86_400}`));
    assert.equal((await bare(path)).status, 200);
  });

  test("the key of a page opens none of the home's routes", async () => {
    const key = new URL(t.home.artifacts.pagePath(id), t.url).search;
    for (const path of [
      `/v1/artifacts/${id}`,
      `/v1/conversations/${conversationId}/artifacts`,
      `/v1/conversations/${conversationId}/messages`,
      "/v1/agents",
      "/v1/items",
      "/v1/events",
    ]) {
      assert.equal((await bare(`${path}${key}`)).status, 401, path);
    }
  });

  test("nothing answers a page across origins, and there is no address for a library", async () => {
    const withToken = await t.request("/v1/agents");
    assert.equal(withToken.headers.get("access-control-allow-origin"), null);
    for (const path of ["/v1/home", "/", t.home.artifacts.pagePath(id)]) {
      assert.equal((await bare(path)).headers.get("access-control-allow-origin"), null, path);
    }
    for (const path of ["/artifact-lib/d3.js", "/artifact-lib/three.js"]) {
      const answer = await bare(path);
      assert.ok(!answer.text.includes("d3js.org") && !answer.text.includes("THREE"), path);
      assert.equal(answer.headers.get("access-control-allow-origin"), null, path);
    }
  });

  test("a page travels in one piece with its library, packed where the browser takes that", async () => {
    const chart = t.home.artifacts.write({ title: "Rain", content: CHART, conversationId });
    const path = t.home.artifacts.pagePath(chart.id);
    const plain = await bare(path);
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.match(plain.text, /<script>\/\/ https:\/\/d3js\.org v7\./);
    assert.ok(!plain.text.includes("/artifact-lib/"));
    // fetch asks for gzip and unpacks it.
    const packed = await fetch(`${t.url}${path}`);
    assert.equal(packed.headers.get("content-encoding"), "gzip");
    assert.equal(await packed.text(), plain.text);
  });

  test("a page that loads from an address is not kept, and the agent reads why", async () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script><svg></svg>';
    t.model.script.push(
      { calls: [{ name: "artifact_write", arguments: { title: "From a CDN", html } }] },
      { text: "I will change it." },
    );
    const reply = await t.say("Chart it again");
    assert.equal(
      reply.parts.find((part) => part.type === "artifact"),
      undefined,
    );
    assert.equal(reply.parts.find((part) => part.type === "activity")?.state, "failed");
    const result = t.model.requests.at(-1)?.messages.findLast((message) => message.role === "tool");
    assert.match(
      result?.content ?? "",
      /^Not saved\. An artifact loads nothing from outside itself/,
    );
    assert.match(result?.content ?? "", /<script src="\/artifact-lib\/d3\.js"><\/script>/);
    assert.ok(!t.home.artifacts.list(conversationId).some((entry) => entry.title === "From a CDN"));
    assert.equal(textOf(reply), "I will change it.");
  });

  test("a page that asks for data while it runs is kept, and the agent is told to change it", async () => {
    const html = '<script>fetch("/v1/agents").then((r) => r.json());</script>';
    t.model.script.push(
      { calls: [{ name: "artifact_write", arguments: { title: "Asks", html } }] },
      { text: "Done." },
    );
    await t.say("One more");
    const result = t.model.requests.at(-1)?.messages.findLast((message) => message.role === "tool");
    assert.match(result?.content ?? "", /^Saved as art_\w+, version 1\./);
    assert.match(result?.content ?? "", /It will not work as it is:\n- The page calls fetch\(\)/);
  });

  test("a page that is too large, empty or another conversation's is refused", () => {
    const write = (input: { id?: string; content: string; conversationId?: string }) =>
      t.home.artifacts.write({ title: "T", conversationId, ...input });
    assert.throws(
      () => write({ content: "x".repeat(ARTIFACT_LIMIT + 1) }),
      (error) => error instanceof ArtifactRefused && /at most 512 KB/.test(error.message),
    );
    assert.throws(() => write({ content: "  " }), ArtifactRefused);
    assert.throws(
      () => write({ id, content: "<p>Mine now</p>", conversationId: "cnv_other" }),
      /There is no artifact art_\w+ in this conversation/,
    );
    assert.throws(() => write({ id: "art_none", content: "<p>x</p>" }), ArtifactRefused);
    assert.equal(t.home.artifacts.get(id)?.version, 2);
  });
});
