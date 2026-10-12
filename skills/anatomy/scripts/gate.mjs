// gate.mjs: the size, composition and comparison gate for a built figure (SKILL.md, "Verification rounds", round 2).
//
//   node scripts/gate.mjs <page.html> [--spec figure.json] [--shots dir] [--wait ms] [--keep]
//   node scripts/gate.mjs --examples          measure every built bundled example and print the baseline table
//
// The audit, lines.mjs and the console check prove geometry and strokes. None of them measures how much machine there
// is, how the card is filled, or whether the figure was ever put next to an example. This does, and exits 1 on any FAIL.
// Thresholds and where each comes from are in gate-baselines.json beside this file.
//
// figure.json (next to the page, or at <page dir>/<page name without -light>/figure.json, or --spec):
//   {
//     "tier": "figure" | "hero" | "epic",              // SKILL.md workflow step 1
//     "parts": ["bench plate", "feet", ...],           // the step-4 parts list: one entry per physical part;
//                                                      // a set of identical fasteners (corner screws) is one entry
//     "recorded": 26,                                  // optional: R.solids.length from the audit recorder
//     "closest": "dial-indicator",                     // bundled example to compare against (an .mjs one)
//     "preload": "window.__noTour = true;",            // optional: runs before the page (stop the tour)
//     "rest": "window.__pose && window.__pose('rest')",// optional: JS that poses the figure for the measured still
//     "states": [{ "name": "wrong key", "eval": "window.__lock(0, 0, true)" }, ...]
//   }                                                  // every state the figure claims to show (round 3)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANATOMY = resolve(HERE, "..");
const BASE = JSON.parse(readFileSync(join(HERE, "gate-baselines.json"), "utf8"));
const T = BASE.thresholds;

function chromePath() {
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean);
  const playwright = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  for (const root of playwright) if (existsSync(root)) for (const dir of readdirSync(root).sort().reverse()) for (const sub of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome", "chrome-linux64/chrome"]) candidates.push(join(root, dir, sub));
  return candidates.find((path) => existsSync(path));
}

async function browser() {
  const binary = chromePath();
  if (!binary) throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.");
  const profile = mkdtempSync(join(tmpdir(), "iso-gate-"));
  const chrome = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--allow-file-access-from-files", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "about:blank"]);
  const port = await new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("Chrome did not start")), 20000);
    chrome.stderr.on("data", (chunk) => { text += chunk; const m = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) { clearTimeout(timer); done(Number(m[1])); } });
  });
  const close = () => { chrome.kill("SIGKILL"); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return { port, close };
}

async function openPage(port, url, { preload = "", width = 1440, height = 1300 } = {}) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const problems = [];
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
    else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") problems.push(`console.error: ${data.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
    else if (data.method === "Runtime.exceptionThrown") problems.push(`exception: ${(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text).slice(0, 300)}`);
  };
  await new Promise((done) => (socket.onopen = done));
  const send = (method, params = {}) => new Promise((done) => { const call = ++id; pending.set(call, done); socket.send(JSON.stringify({ id: call, method, params })); });
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`); return r.result?.result?.value; };
  await send("Runtime.enable");
  await send("Page.enable");
  if (preload) await send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(1200);
  const shot = async (selector) => {
    const box = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:"center"});const r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height}})()`);
    if (!box) return null;
    await sleep(150);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }, captureBeyondViewport: true });
    return r.result.data;
  };
  return { evaluate, shot, problems, close: () => socket.close() };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Counted in the page: every kit solid paints exactly one path.iso-fill (iso-kit.mjs solidSvg), in every SVG layer of the plate.
const COUNT = `(()=>{const plate=document.querySelector(".iso-plate");if(!plate)return null;const shown=(el)=>{for(let e=el;e&&e!==plate;e=e.parentElement){const s=getComputedStyle(e);if(s.display==="none"||s.visibility==="hidden"||Number(s.opacity)===0)return false}return true};return {solids:[...plate.querySelectorAll("path.iso-fill")].filter((p)=>(p.getAttribute("d")||"").length>4&&shown(p)).length,svg:!!plate.querySelector("svg")}})()`;

// Pixel measures of a PNG of the drawing (the plate's first svg box), computed in the page's own canvas.
const PIXELS = (b64) => `(async()=>{const img=new Image();img.src="data:image/png;base64,${b64}";await img.decode();const w=img.width,h=img.height,c=document.createElement("canvas");c.width=w;c.height=h;const x=c.getContext("2d");x.drawImage(img,0,0);const d=x.getImageData(0,0,w,h).data;const L=new Int16Array(w*h);for(let i=0;i<w*h;i++)L[i]=Math.round(0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2]);const hist=new Map();const edgeRow=(y)=>{for(let x0=0;x0<w;x0++){const v=L[y*w+x0];hist.set(v,(hist.get(v)||0)+1)}};edgeRow(2);edgeRow(h-3);for(let y=0;y<h;y++){for(const x0 of[2,w-3]){const v=L[y*w+x0];hist.set(v,(hist.get(v)||0)+1)}}const paper=[...hist].sort((a,b)=>b[1]-a[1])[0][0];const m=new Uint8Array(w*h),e=new Uint8Array(w*h);let x0=w,y0=h,x1=0,y1=0,n=0;for(let y=2;y<h-2;y++)for(let xx=2;xx<w-2;xx++){const i=y*w+xx;if(Math.abs(L[i]-paper)>${T.paperDelta}){m[i]=1;n++;if(xx<x0)x0=xx;if(xx>x1)x1=xx;if(y<y0)y0=y;if(y>y1)y1=y}}for(let y=0;y<h-1;y++)for(let xx=0;xx<w-1;xx++){const i=y*w+xx;if(m[i]&&Math.max(Math.abs(L[i]-L[i+1]),Math.abs(L[i]-L[i+w]))>${T.edgeDelta})e[i]=1}const G=4,cells=[];for(let j=0;j<G;j++)for(let i=0;i<G;i++){const ya=y0+Math.floor((y1-y0)*j/G),yb=y0+Math.floor((y1-y0)*(j+1)/G),xa=x0+Math.floor((x1-x0)*i/G),xb=x0+Math.floor((x1-x0)*(i+1)/G);let mm=0,ee=0;for(let y=ya;y<yb;y++)for(let xx=xa;xx<xb;xx++){const k=y*w+xx;mm+=m[k];ee+=e[k]}const area=(yb-ya)*(xb-xa);cells.push({i,j,cover:mm/area,density:mm?ee/mm:0})}const inside=cells.filter((c)=>c.cover>=0.3);const med=inside.map((c)=>c.density).sort((a,b)=>a-b)[Math.floor(inside.length/2)]||1;for(const c of inside)c.rel=c.density/med;return {w,h,fill:((x1-x0)*(y1-y0))/(w*h),ink:n/((x1-x0)*(y1-y0)),box:[x0,y0,x1,y1],cells:inside.map((c)=>({i:c.i,j:c.j,rel:Math.round(c.rel*100)/100}))}})()`;

const DIFF = (a, b) => `(async()=>{const load=async(s)=>{const i=new Image();i.src="data:image/png;base64,"+s;await i.decode();const c=document.createElement("canvas");c.width=i.width;c.height=i.height;const x=c.getContext("2d");x.drawImage(i,0,0);return x.getImageData(0,0,i.width,i.height)};const A=await load("${a}"),B=await load("${b}");if(A.width!==B.width||A.height!==B.height)return {changed:-1};let ch=0;for(let k=0;k<A.data.length;k+=4){if(Math.abs(A.data[k]-B.data[k])+Math.abs(A.data[k+1]-B.data[k+1])+Math.abs(A.data[k+2]-B.data[k+2])>30)ch++}return {changed:ch,total:A.width*A.height}})()`;

const SIDE = (a, b, la, lb) => `(async()=>{const load=async(s)=>{const i=new Image();i.src="data:image/png;base64,"+s;await i.decode();return i};const A=await load("${a}"),B=await load("${b}");const pad=24,top=28;const c=document.createElement("canvas");c.width=A.width+B.width+pad*3;c.height=Math.max(A.height,B.height)+top+pad;const x=c.getContext("2d");x.fillStyle="#808080";x.fillRect(0,0,c.width,c.height);x.drawImage(A,pad,top);x.drawImage(B,A.width+pad*2,top);x.fillStyle="#fff";x.font="bold 14px monospace";x.fillText(${JSON.stringify(la)},pad,19);x.fillText(${JSON.stringify(lb)},A.width+pad*2,19);return c.toDataURL("image/png").split(",")[1]})()`;

function specFor(page) {
  const dir = dirname(page), name = basename(page, ".html").replace(/-light$/, "");
  for (const p of [join(dir, `${name}.figure.json`), join(dir, "figure.json"), join(dir, name, "figure.json")]) if (existsSync(p)) return p;
  return null;
}
const exampleOf = (page) => { const rel = resolve(page).split(join(ANATOMY, "examples") + "/")[1]; return rel ? rel.split("/")[0] : null; };

async function measure(port, page, spec) {
  const url = pathToFileURL(resolve(page)).href;
  const p = await openPage(port, url, { preload: spec?.preload ?? "" });
  await sleep(spec?.wait ?? 1300);
  if (spec?.rest) { await p.evaluate(spec.rest); await sleep(600); }
  const count = await p.evaluate(COUNT);
  const still = await p.shot(".iso-plate svg");
  const card = await p.shot(".iso-plate");
  const pixels = still ? await p.evaluate(PIXELS(still)) : null;
  return { p, count, still, card, pixels };
}

function judge(m, tier, report) {
  const floor = T.solidsFloor[tier];
  const s = m.count?.solids ?? 0;
  report(s >= floor, `drawn solids ${s} ≥ ${floor} (${tier} floor)`, `drawn solids ${s} < ${floor}, the ${tier} floor. Add real parts (SKILL.md workflow step 4 and "Every creation is highly detailed").`);
  const f = m.pixels.fill;
  report(f >= T.cardFill[0] && f <= T.cardFill[1], `card fill ${f.toFixed(2)} within ${T.cardFill.join("–")}`, `card fill ${f.toFixed(2)} outside ${T.cardFill.join("–")}: the drawing's box covers ${(f * 100).toFixed(0)}% of the drawing area (craft.md section 6: "about 55–65% of the card"; examples ${BASE.measured.range.fill.join("–")}). ${f > T.cardFill[1] ? "Too much of it is base or travel: tighten the plate to the mechanism, or fill it with real parts." : "The object is small in the card: fit with a smaller pad."}`);
  const ink = m.pixels.ink;
  report(ink >= T.inkMin, `ink in its box ${ink.toFixed(2)} ≥ ${T.inkMin}`, `ink ${ink.toFixed(2)} < ${T.inkMin}: the drawing's box is mostly air (examples ${BASE.measured.range.ink.join("–")}).`);
  const bare = m.pixels.cells.filter((c) => c.rel < T.cellMin);
  report(!bare.length, `no bare region (every 1/16 cell of the drawing has ≥ ${T.cellMin}× the median line density)`, `bare region${bare.length > 1 ? "s" : ""}: ${bare.map((c) => `cell col ${c.i + 1} row ${c.j + 1} at ${c.rel}× median line density`).join(", ")} (examples never fall below ${BASE.measured.range.cellMin[0]}×). Add the real parts that belong there.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { shots: null, spec: null, wait: null, examples: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spec") opt.spec = argv[++i];
    else if (argv[i] === "--shots") opt.shots = argv[++i];
    else if (argv[i] === "--wait") opt.wait = Number(argv[++i]);
    else if (argv[i] === "--examples") opt.examples = true;
    else rest.push(argv[i]);
  }
  const { port, close } = await browser();
  try {
    if (opt.examples) {
      console.log("example          tier    solids  fill  ink   min cell");
      for (const [name, e] of Object.entries(BASE.examples)) {
        const page = join(ANATOMY, "examples", name, `${name}-light.html`);
        if (!existsSync(page)) { console.log(`${name.padEnd(16)} not built (${e.page ?? "node build.mjs --light"})`); continue; }
        const m = await measure(port, page, { wait: e.wait });
        const min = Math.min(...m.pixels.cells.map((c) => c.rel));
        console.log(`${name.padEnd(16)} ${e.tier.padEnd(7)} ${String(m.count.solids).padStart(6)}  ${m.pixels.fill.toFixed(2)}  ${m.pixels.ink.toFixed(2)}  ${min.toFixed(2)}${m.p.problems.length ? "  " + m.p.problems[0] : ""}`);
        m.p.close();
      }
      return;
    }
    const page = rest[0];
    if (!page || !existsSync(page)) { console.error("usage: node gate.mjs <page.html> [--spec figure.json] [--shots dir]"); process.exitCode = 2; return; }
    const example = exampleOf(page);
    const specPath = opt.spec ?? specFor(page);
    const spec = specPath ? JSON.parse(readFileSync(specPath, "utf8")) : null;
    const shots = resolve(opt.shots ?? join(dirname(page), "shots", "gate"));
    mkdirSync(shots, { recursive: true });
    let fails = 0;
    const report = (ok, good, bad) => { if (ok) console.log(`PASS  ${good}`); else { fails++; console.log(`FAIL  ${bad}`); } };
    console.log(`gate: ${page}${example ? ` (bundled example ${example})` : ""}${specPath ? `\nspec: ${specPath}` : ""}`);

    // 1. Size: the declared tier against the parts list, the recorder and the drawing.
    let tier;
    if (example) { tier = BASE.examples[example]?.tier; console.log(`tier  ${tier} (gate-baselines.json; a bundled example ships no parts list, so only the drawing is measured)`); }
    else if (!spec) { report(false, "", `no figure.json next to the page (or --spec). Write it in round 1: tier, parts list, closest example, states.`); }
    else {
      tier = spec.tier;
      report(["figure", "hero", "epic"].includes(tier), `tier ${tier}`, `tier "${tier}" is not figure, hero or epic (SKILL.md workflow step 1).`);
      const parts = Array.isArray(spec.parts) ? spec.parts.length : 0;
      const dup = Array.isArray(spec.parts) ? spec.parts.length - new Set(spec.parts.map((s) => String(s).trim().toLowerCase())).size : 0;
      report(parts >= T.partsMin[tier] && !dup, `parts list ${parts} ≥ ${T.partsMin[tier]}`, `parts list has ${parts} entries${dup ? ` (${dup} duplicated)` : ""}; a ${tier} needs ≥ ${T.partsMin[tier]} distinct parts (SKILL.md workflow steps 1 and 4).`);
      if (spec.recorded != null) report(spec.recorded >= T.solidsFloor[tier], `recorder solids ${spec.recorded} ≥ ${T.solidsFloor[tier]}`, `recorder solids ${spec.recorded} < ${T.solidsFloor[tier]}, the ${tier} floor.`);
    }
    tier = tier ?? "figure";
    const m = await measure(port, page, { ...(spec ?? {}), wait: opt.wait ?? spec?.wait ?? BASE.examples[example]?.wait });
    if (!m.count || !m.pixels) { report(false, "", "no .iso-plate with an svg in the page: build it with the kit's plateHtml."); }
    else judge(m, tier, report);
    writeFileSync(join(shots, "still.png"), Buffer.from(m.still ?? "", "base64"));

    if (!example && spec) {
      // 2. Comparison: the figure next to the closest example, same device scale, card for card.
      const closest = spec.closest;
      const exPage = closest && join(ANATOMY, "examples", closest, `${closest}-light.html`);
      if (!closest || !BASE.examples[closest]) report(false, "", `figure.json "closest" must name a bundled example (${Object.keys(BASE.examples).join(", ")}).`);
      else {
        if (!existsSync(exPage) && existsSync(join(ANATOMY, "examples", closest, "build.mjs"))) spawnSync(process.execPath, ["build.mjs", "--light"], { cwd: join(ANATOMY, "examples", closest), stdio: "ignore" });
        if (!existsSync(exPage)) report(false, "", `closest example ${closest} has no built page (${BASE.examples[closest].page ?? "React example: pick an .mjs one"}).`);
        else {
          const ex = await measure(port, exPage, { wait: BASE.examples[closest].wait });
          const side = await m.p.evaluate(SIDE(m.card, ex.card, `${basename(page)} · ${m.count.solids} solids`, `${closest} · ${ex.count.solids} solids`));
          const out = join(shots, `compare-${closest}.png`);
          writeFileSync(out, Buffer.from(side, "base64"));
          writeFileSync(join(shots, "compare.json"), JSON.stringify({ page: resolve(page), mtime: statSync(page).mtimeMs, example: closest, image: out, solids: [m.count.solids, ex.count.solids] }, null, 2));
          report(existsSync(out) && statSync(out).size > 1000, `comparison written: ${out} (read it: round 4)`, `comparison image could not be written`);
          ex.p.close();
        }
      }
      // 3. States: each one captured with the readout hidden, for round 3. Identical stills fail outright.
      const states = Array.isArray(spec.states) ? spec.states : [];
      report(states.length > 0, `${states.length} declared state${states.length === 1 ? "" : "s"}`, `figure.json declares no states: list every state the figure claims to show (round 3).`);
      const stills = [];
      for (const st of states) {
        await m.p.evaluate(`(()=>{let s=document.getElementById("gate-hide");if(!s){s=document.createElement("style");s.id="gate-hide";s.textContent="[data-readout]{visibility:hidden!important}";document.head.appendChild(s)}})()`);
        if (st.eval) await m.p.evaluate(st.eval);
        await sleep(st.wait ?? 900);
        const b64 = await m.p.shot(".iso-plate");
        const file = join(shots, `state-${String(st.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
        writeFileSync(file, Buffer.from(b64, "base64"));
        stills.push({ name: st.name, b64, file });
      }
      let least = null;
      for (let i = 0; i < stills.length; i++) for (let j = i + 1; j < stills.length; j++) {
        const d = await m.p.evaluate(DIFF(stills[i].b64, stills[j].b64));
        const pct = d.total ? (100 * d.changed) / d.total : 0;
        least = !least || d.changed < least.changed ? { changed: d.changed, pct, a: stills[i].name, b: stills[j].name } : least;
        report(d.changed > 0, `states "${stills[i].name}" / "${stills[j].name}" differ in ${d.changed} px (${pct.toFixed(2)}% of the card)`, `states "${stills[i].name}" and "${stills[j].name}" are pixel-identical with the readout hidden: the drawing does not show the difference.`);
      }
      if (least) console.log(`note  least distinct pair: "${least.a}" / "${least.b}", ${least.pct.toFixed(2)}% of the card changes. Look at that pair first: if the difference only reads in the readout, round 3 fails.`);
      if (stills.length) console.log(`look  ${stills.map((s) => s.file).join("\n      ")}\n      (round 3: name what each still shows from the drawing alone; the gate cannot judge legibility)`);
    }
    for (const problem of m.p.problems) report(false, "", problem);
    m.p.close();
    console.log(fails ? `gate failed: ${fails} problem${fails === 1 ? "" : "s"}` : "gate passed");
    if (fails) process.exitCode = 1;
  } finally { close(); }
}

if (typeof WebSocket === "undefined" && !process.execArgv.includes("--experimental-websocket")) {
  const child = spawn(process.execPath, ["--experimental-websocket", ...process.argv.slice(1)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else main().catch((error) => { console.error(error); process.exit(2); });
