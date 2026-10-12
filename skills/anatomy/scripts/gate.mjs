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
//     "subject": "[data-name^=housing],[data-name=plug]",// CSS selector (inside the plate's svg) for the main mechanism:
//                                                      // its box must cover a share of the card like the examples' objects
//     "accent": { "selector": ".pt-wrong", "state": "wrong key" },  // the state marker and the state that shows it;
//                                                      // checked for contrast in the -light page and its dark twin.
//                                                      // No marker: "accent": { "none": "why" }
//     "states": [{ "name": "wrong key", "eval": "window.__lock(0, 0, true)",
//                  "changes": "[data-name^=keypin],[data-name=key]" }, ...]
//   }                                                  // every state the figure claims to show (round 3), each with the
//                                                      // parts that change in it: the change vs rest must land there
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

// Boxes of page elements, in the pixels of a shot of `root` (device scale 1). Hidden elements are skipped.
const SHOWN = `const shown=(el)=>{for(let e=el;e&&e.nodeType===1;e=e.parentElement){const s=getComputedStyle(e);if(s.display==="none"||s.visibility==="hidden"||Number(s.opacity)===0)return false}return true};`;
const RECT = (sel, root) => `(()=>{const r=document.querySelector(${JSON.stringify(root)});if(!r)return null;const R=r.getBoundingClientRect();${SHOWN}let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9,n=0;for(const el of r.querySelectorAll(${JSON.stringify(sel)})){if(!shown(el))continue;const b=el.getBoundingClientRect();if(b.width<0.5&&b.height<0.5)continue;n++;x0=Math.min(x0,b.left);y0=Math.min(y0,b.top);x1=Math.max(x1,b.right);y1=Math.max(y1,b.bottom)}return {n,w:R.width,h:R.height,box:n?[x0-R.left,y0-R.top,x1-R.left,y1-R.top]:null}})()`;
// A bundled example ships no subject declaration: its subject is every solid except the base it stands on, i.e. the
// solids whose own box is under a quarter of the whole drawing's box (the bench plate and its skins are dropped).
const AUTO_SUBJECT = `(()=>{const r=document.querySelector(".iso-plate svg");const R=r.getBoundingClientRect();${SHOWN}const bs=[...r.querySelectorAll("g.iso-solid")].filter(shown).map((e)=>e.getBoundingClientRect()).filter((b)=>b.width>0.5||b.height>0.5);if(!bs.length)return null;const U=(L)=>L.reduce((a,b)=>[Math.min(a[0],b.left),Math.min(a[1],b.top),Math.max(a[2],b.right),Math.max(a[3],b.bottom)],[1e9,1e9,-1e9,-1e9]);const all=U(bs);const A=(all[2]-all[0])*(all[3]-all[1]);const keep=bs.filter((b)=>b.width*b.height<0.25*A);const s=U(keep.length?keep:bs);return {n:keep.length,w:R.width,h:R.height,box:[s[0]-R.left,s[1]-R.top,s[2]-R.left,s[3]-R.top]}})()`;
// Paint every visible fill and stroke under `sel` pure magenta (inline, restorable) so a second shot gives its exact pixels.
const PAINT = (sel, on) => on
  ? `(()=>{${SHOWN}const els=[];for(const g of document.querySelectorAll(${JSON.stringify(sel)}))for(const el of [g,...g.querySelectorAll("*")]){if(!(el instanceof SVGGraphicsElement)||!shown(el))continue;const s=getComputedStyle(el);el.dataset.gateStyle=el.getAttribute("style")??"\\u0000";if(s.fill&&s.fill!=="none")el.style.setProperty("fill","#ff00ff","important");if(s.stroke&&s.stroke!=="none")el.style.setProperty("stroke","#ff00ff","important");el.style.setProperty("opacity","1","important");els.push(el)}return els.length})()`
  : `(()=>{for(const el of document.querySelectorAll("[data-gate-style]")){const v=el.dataset.gateStyle;if(v==="\\u0000")el.removeAttribute("style");else el.setAttribute("style",v);delete el.dataset.gateStyle}})()`;
// Accent contrast: the marker's pixels (from the magenta shot) against the drawn pixels in a ring just outside it.
// Returns the share of marker pixels whose luminance is at least T.accentStep away from the ring's median.
const CONTRAST = (normal, magenta) => `(async()=>{const load=async(s)=>{const i=new Image();i.src="data:image/png;base64,"+s;await i.decode();const c=document.createElement("canvas");c.width=i.width;c.height=i.height;const x=c.getContext("2d");x.drawImage(i,0,0);return x.getImageData(0,0,i.width,i.height)};const A=await load("${normal}"),B=await load("${magenta}");const w=A.width,h=A.height;if(B.width!==w||B.height!==h)return null;const L=(d,i)=>0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];const m=new Uint8Array(w*h);let n=0;for(let i=0;i<w*h;i++){const r=B.data[i*4],g=B.data[i*4+1],b=B.data[i*4+2];if(r>200&&g<70&&b>200){m[i]=1;n++}}if(!n)return {n:0};const hist=new Map();for(const i of [0,w-1,(h-1)*w,h*w-1]){const v=Math.round(L(A.data,i));hist.set(v,(hist.get(v)||0)+1)}const paper=Math.round(L(A.data,2*w+2));const R=${T.accentRing};const ring=[];const dm=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(!m[y*w+x])continue;for(let dy=-R;dy<=R;dy+=2)for(let dx=-R;dx<=R;dx+=2){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;const k=yy*w+xx;if(m[k]||dm[k])continue;dm[k]=1;const v=L(A.data,k);if(Math.abs(v-paper)>${T.paperDelta})ring.push(v)}}if(!ring.length)ring.push(paper);ring.sort((a,b)=>a-b);const med=ring[Math.floor(ring.length/2)];let far=0,sum=0;for(let i=0;i<w*h;i++)if(m[i]){const v=L(A.data,i);sum+=v;if(Math.abs(v-med)>=${T.accentStep})far++}return {n,share:far/n,mean:sum/n,ring:med}})()`;
// State-local difference: changed pixels inside a box (state vs rest) over all changed pixels.
const DIFFIN = (a, b, box, noise) => `(async()=>{const load=async(s)=>{const i=new Image();i.src="data:image/png;base64,"+s;await i.decode();const c=document.createElement("canvas");c.width=i.width;c.height=i.height;const x=c.getContext("2d");x.drawImage(i,0,0);return x.getImageData(0,0,i.width,i.height)};const A=await load("${a}"),B=await load("${b}"),N=${noise ? `await load("${noise}")` : "null"};if(A.width!==B.width||A.height!==B.height)return null;const D=(P,Q,k)=>Math.abs(P.data[k]-Q.data[k])+Math.abs(P.data[k+1]-Q.data[k+1])+Math.abs(P.data[k+2]-Q.data[k+2])>30;const nm=new Uint8Array(A.width*A.height);let noisy=0;if(N&&N.width===A.width&&N.height===A.height){const R=4;for(let y=0;y<A.height;y++)for(let x=0;x<A.width;x++)if(D(A,N,(y*A.width+x)*4)){noisy++;for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<A.width&&yy<A.height)nm[yy*A.width+xx]=1}}}const [x0,y0,x1,y1]=${JSON.stringify(box)};let ch=0,inside=0,bx=[1e9,1e9,-1,-1];for(let y=0;y<A.height;y++)for(let x=0;x<A.width;x++){const k=(y*A.width+x)*4;if(!nm[y*A.width+x]&&D(A,B,k)){ch++;bx=[Math.min(bx[0],x),Math.min(bx[1],y),Math.max(bx[2],x),Math.max(bx[3],y)];if(x>=x0&&x<=x1&&y>=y0&&y<=y1)inside++}}return {changed:ch,inside,noisy,total:A.width*A.height,bbox:[bx[0]/A.width,bx[1]/A.height,bx[2]/A.width,bx[3]/A.height].map((v)=>Math.round(v*100)/100)}})()`;
// Percentages in messages are cut to one decimal toward the side of the threshold, so a value just under a minimum
// never prints as the minimum (79.96% shows as 79.9%, not 80%), and one just over a maximum never prints as the maximum.
const pctDown = (v) => String(Math.floor(v * 1000) / 10);
const pctUp = (v) => String(Math.ceil(v * 1000) / 10);
const down2 = (v) => (Math.floor(v * 100) / 100).toFixed(2);
const up2 = (v) => (Math.ceil(v * 100) / 100).toFixed(2);
const unionBox = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const padBox = (b, d, w, h) => b && [Math.max(0, b[0] - d), Math.max(0, b[1] - d), Math.min(w, b[2] + d), Math.min(h, b[3] + d)];
const boxArea = (b) => (b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0);
// A region given as fractions of the card [x0, y0, x1, y1] (bundled examples have no selectors to name their parts by).
const fracBox = (f, w, h) => f && [f[0] * w, f[1] * h, f[2] * w, f[3] * h];

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
  if (pixels) { const [x0, y0, x1, y1] = pixels.box; pixels.span = Math.max((x1 - x0) / pixels.w, (y1 - y0) / pixels.h); pixels.minor = Math.min((x1 - x0) / pixels.w, (y1 - y0) / pixels.h); }
  const sr = await p.evaluate(spec?.subject ? RECT(spec.subject, ".iso-plate svg") : AUTO_SUBJECT);
  const subject = sr?.box ? { n: sr.n, box: sr.box, share: boxArea(sr.box) / (sr.w * sr.h), auto: !spec?.subject } : { n: 0, share: 0, auto: !spec?.subject };
  return { p, count, still, card, pixels, subject, subjectSel: spec?.subject };
}

// The accent / state marker in one theme: its pixels against the drawn ring around it, in the pose that shows it.
async function accentIn(port, page, { selector, pose, preload, wait }) {
  const p = await openPage(port, pathToFileURL(resolve(page)).href, { preload: preload ?? "" });
  try {
    await sleep(wait ?? 1300);
    await p.evaluate(`(()=>{const s=document.createElement("style");s.textContent="[data-readout]{visibility:hidden!important}";document.head.appendChild(s)})()`);
    if (pose) { await p.evaluate(pose); await sleep(900); }
    const normal = await p.shot(".iso-plate svg");
    const painted = await p.evaluate(PAINT(selector, true));
    if (!painted) return { n: 0 };
    const magenta = await p.shot(".iso-plate svg");
    await p.evaluate(PAINT(selector, false));
    return await p.evaluate(CONTRAST(normal, magenta));
  } finally { p.close(); }
}
const darkOf = (page) => page.replace(/-light\.html$/, ".html");

function judge(m, tier, report) {
  const floor = T.solidsFloor[tier];
  const s = m.count?.solids ?? 0;
  report(s >= floor, `drawn solids ${s} ≥ ${floor} (${tier} floor)`, `drawn solids ${s} < ${floor}, the ${tier} floor. Add real parts (SKILL.md workflow step 4 and "Every creation is highly detailed").`);
  // Card fill is measured per axis, so padding the card's height (or width) cannot move it: the drawing's box must span
  // most of the card on its long axis and must not leave a band of empty card on the other one.
  const { span, minor, fill: f } = m.pixels;
  report(span >= T.span[0] && span <= T.span[1], `card span ${span.toFixed(2)} within ${T.span.join("–")} (drawing box on its long axis; area ${f.toFixed(2)}, for reference)`, `card span ${span > T.span[1] ? up2(span) : down2(span)} outside ${T.span.join("–")}: on its longer axis the drawing's box covers ${(span * 100).toFixed(0)}% of the card (examples ${BASE.measured.range.span.join("–")}). ${span > T.span[1] ? "It runs into the card edge: fit with a larger pad." : "The object is small in the card: fit with a smaller pad, or tighten the plate to the mechanism."}`);
  report(minor >= T.minorMin, `card cross-span ${minor.toFixed(2)} ≥ ${T.minorMin}`, `card cross-span ${down2(minor)} < ${T.minorMin}: the drawing covers only ${(minor * 100).toFixed(0)}% of the card on its short axis, leaving an empty band (examples ${BASE.measured.range.minor.join("–")}). Shrink the card to the drawing or build the object out on that axis.`);
  const ink = m.pixels.ink;
  report(ink >= T.inkMin, `ink in its box ${ink.toFixed(2)} ≥ ${T.inkMin}`, `ink ${down2(ink)} < ${T.inkMin}: the drawing's box is mostly air (examples ${BASE.measured.range.ink.join("–")}).`);
  const sj = m.subject;
  if (!sj.auto || sj.share) report(sj.share >= T.subjectMin, `subject ${sj.auto ? "(whole object, auto) " : ""}covers ${sj.share.toFixed(2)} of the card ≥ ${T.subjectMin}`, sj.n ? `subject covers ${down2(sj.share)} of the card < ${T.subjectMin}: the mechanism the figure is about is too small to read (examples' whole object ${BASE.measured.range.subject.join("–")}). Make it the dominant thing in the card: draw it larger (a cutaway or training-scale model), move props off the plate, or crop the scene to it.` : `figure.json "subject" (${m.subjectSel}) matches nothing visible: name the main mechanism's elements (a CSS selector inside the plate's svg).`);
  const bare = m.pixels.cells.filter((c) => c.rel < T.cellMin);
  report(!bare.length, `no bare region (every 1/16 cell of the drawing has ≥ ${T.cellMin}× the median line density)`, `bare region${bare.length > 1 ? "s" : ""}: ${bare.map((c) => `cell col ${c.i + 1} row ${c.j + 1} at ${c.rel}× median line density`).join(", ")} (examples never fall below ${BASE.measured.range.cellMin[0]}×). Add the real parts that belong there.`);
}

// Capture each declared state (readout hidden) and check where its change lands: the pixels that differ from the rest
// pose must fall mostly inside the box of the parts the state declares it changes ("changes": a CSS selector, measured in
// both poses; bundled examples use "region": card fractions). Returns the stills for the pairwise check.
async function runStates(p, spec, states, shots, report) {
  const hide = `(()=>{let s=document.getElementById("gate-hide");if(!s){s=document.createElement("style");s.id="gate-hide";s.textContent="[data-readout]{visibility:hidden!important}";document.head.appendChild(s)}})()`;
  await p.evaluate(hide);
  const pose = async (code) => { if (code) await p.evaluate(code); };
  await pose(spec.rest); await sleep(900);
  const rest = await p.shot(".iso-plate");
  // A second rest still: pixels that change while nothing is asked of the figure (a running screen, a plume, an idle
  // animation) are masked out of every state's difference, so the check measures the state, not the background motion.
  await sleep(900);
  const rest2 = await p.shot(".iso-plate");
  const out = [];
  for (const st of states) {
    let before = null;
    if (st.changes) { await pose(spec.rest); await sleep(st.wait ?? 900); before = await p.evaluate(RECT(st.changes, ".iso-plate")); }
    await pose(st.eval);
    await sleep(st.wait ?? 900);
    const b64 = await p.shot(".iso-plate");
    const file = join(shots, `state-${String(st.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    out.push({ name: st.name, b64, file });
    if (!st.changes && !st.region) { report(false, "", `state "${st.name}" declares no "changes": a CSS selector for the parts that move or light up in it (round 1).`); continue; }
    const after = st.changes ? await p.evaluate(RECT(st.changes, ".iso-plate")) : null;
    const W = (after ?? before)?.w, H = (after ?? before)?.h;
    let box = st.changes ? unionBox(before?.box, after?.box) : null;
    const dims = await p.evaluate(`(()=>{const r=document.querySelector(".iso-plate").getBoundingClientRect();return [r.width,r.height]})()`);
    if (st.region) box = fracBox(st.region, dims[0], dims[1]);
    if (!box) { report(false, "", `state "${st.name}": "changes" (${st.changes}) matches nothing visible.`); continue; }
    box = padBox(box, T.localPad, dims[0], dims[1]);
    const area = boxArea(box) / (dims[0] * dims[1]);
    const d = await p.evaluate(DIFFIN(rest, b64, box, rest2));
    if (!d || !d.changed) { if (st.eval !== spec.rest) report(false, "", `state "${st.name}" looks identical to the rest pose with the readout hidden.`); continue; }
    const share = d.inside / d.changed;
    const ok = share >= T.localMin && area <= T.localMaxArea;
    report(ok, `state "${st.name}": ${pctDown(share)}% of its change vs rest lies on the parts it declares (box ${pctDown(area)}% of the card)`, area > T.localMaxArea ? `state "${st.name}": the declared parts' box covers ${pctUp(area)}% of the card (max ${T.localMaxArea * 100}%), so it cannot show where the change is. Name only the parts that change.` : `state "${st.name}": only ${pctDown(share)}% of what changes vs rest lies on the parts it declares (needs ≥ ${T.localMin * 100}%). Either the declared parts are wrong or the state's difference is diffuse (a global tint, a moved camera, an animation running elsewhere).`);
    if (st.eval !== spec.rest) out[out.length - 1].local = { share, area, bbox: d.bbox };
  }
  return out;
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
      console.log("example          tier    solids  fill  span  minor ink   min cell  subject  accent light/dark  local");
      for (const [name, e] of Object.entries(BASE.examples)) {
        const page = join(ANATOMY, "examples", name, `${name}-light.html`);
        if (!existsSync(page)) { console.log(`${name.padEnd(16)} not built (${e.page ?? "node build.mjs --light"})`); continue; }
        const m = await measure(port, page, { wait: e.wait });
        const min = Math.min(...m.pixels.cells.map((c) => c.rel));
        let local = "";
        if (e.states) { const st = await runStates(m.p, { rest: e.rest }, e.states, mkdtempSync(join(tmpdir(), "gate-ex-")), () => {}); local = st.filter((x) => x.local).map((x) => `${x.name} ${x.local.share.toFixed(2)}@${x.local.area.toFixed(2)} diff[${x.local.bbox}]`).join(", "); }
        m.p.close();
        const acc = [];
        for (const pg of [page, darkOf(page)]) acc.push(existsSync(pg) ? await accentIn(port, pg, { selector: T.accentDefault, wait: e.wait }) : null);
        const a = acc.map((r) => (r == null ? "  -  " : r.n ? r.share.toFixed(2) : "none")).join("/");
        console.log(`${name.padEnd(16)} ${e.tier.padEnd(7)} ${String(m.count.solids).padStart(6)}  ${m.pixels.fill.toFixed(2)}  ${m.pixels.span.toFixed(2)}  ${m.pixels.minor.toFixed(2)}  ${m.pixels.ink.toFixed(2)}  ${min.toFixed(2)}      ${m.subject.share.toFixed(2)}     ${a}  ${local}${m.p.problems.length ? "  " + m.p.problems[0] : ""}`);
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
      report(typeof spec.subject === "string" && spec.subject.trim(), `subject declared (${spec.subject})`, `figure.json declares no "subject": a CSS selector for the main mechanism's elements in the plate's svg (round 1).`);
      if (spec.recorded != null) report(spec.recorded >= T.solidsFloor[tier], `recorder solids ${spec.recorded} ≥ ${T.solidsFloor[tier]}`, `recorder solids ${spec.recorded} < ${T.solidsFloor[tier]}, the ${tier} floor.`);
    }
    tier = tier ?? "figure";
    const m = await measure(port, page, { ...(spec ?? {}), wait: opt.wait ?? spec?.wait ?? BASE.examples[example]?.wait });
    if (!m.count || !m.pixels) { report(false, "", "no .iso-plate with an svg in the page: build it with the kit's plateHtml."); }
    else judge(m, tier, report);
    writeFileSync(join(shots, "still.png"), Buffer.from(m.still ?? "", "base64"));
    if (example) {
      // A bundled example is held to the same state-local and accent checks where gate-baselines.json declares them.
      const e = BASE.examples[example] ?? {};
      if (e.states) await runStates(m.p, { rest: e.rest }, e.states, shots, report);
      for (const pg of [...new Set([page, darkOf(page)])].filter(existsSync)) {
        const r = await accentIn(port, pg, { selector: T.accentDefault, wait: e.wait });
        if (r?.n) report(r.share >= T.accentMin, `lit accent stands off its neighbours in ${pg === page ? "light" : "dark"} theme (${pctDown(r.share)}%)`, `lit accent weak in ${pg === page ? "light" : "dark"} theme (${pctDown(r.share)}% < ${T.accentMin * 100}%)`);
      }
    }

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
      // 3. States: each one captured with the readout hidden, for round 3. Identical stills fail outright, and each
      // state's change must sit in the parts it declares ("changes"), not spread over the card.
      const states = Array.isArray(spec.states) ? spec.states : [];
      report(states.length > 0, `${states.length} declared state${states.length === 1 ? "" : "s"}`, `figure.json declares no states: list every state the figure claims to show (round 3).`);
      const stills = await runStates(m.p, spec, states, shots, report);
      let least = null;
      for (let i = 0; i < stills.length; i++) for (let j = i + 1; j < stills.length; j++) {
        const d = await m.p.evaluate(DIFF(stills[i].b64, stills[j].b64));
        const pct = d.total ? (100 * d.changed) / d.total : 0;
        least = !least || d.changed < least.changed ? { changed: d.changed, pct, a: stills[i].name, b: stills[j].name } : least;
        report(d.changed > 0, `states "${stills[i].name}" / "${stills[j].name}" differ in ${d.changed} px (${pct.toFixed(2)}% of the card)`, `states "${stills[i].name}" and "${stills[j].name}" are pixel-identical with the readout hidden: the drawing does not show the difference.`);
      }
      if (least) console.log(`note  least distinct pair: "${least.a}" / "${least.b}", ${least.pct.toFixed(2)}% of the card changes. Look at that pair first: if the difference only reads in the readout, round 3 fails.`);
      if (stills.length) console.log(`look  ${stills.map((s) => s.file).join("\n      ")}\n      (round 3: name what each still shows from the drawing alone; the gate cannot judge legibility)`);

      // 4. Accent: the marker that carries the figure's state must stand off its neighbours in both themes.
      const acc = spec.accent;
      if (acc && acc.none) console.log(`note  no accent marker (${acc.none})`);
      else if (!acc || !acc.selector) report(false, "", `figure.json declares no "accent": { "selector": CSS for the state marker (the lit or accent-coloured parts), "state": the state name that shows it }. A figure with no marker says so: "accent": { "none": "why" }.`);
      else {
        const st = states.find((x) => x.name === acc.state);
        const pose = [spec.rest, st?.eval].filter(Boolean).join(";");
        for (const pg of [...new Set([page, darkOf(page)])]) {
          const theme = pg === page ? (/-light\.html$/.test(page) ? "light" : "page") : "dark";
          if (pg !== page && !existsSync(pg)) { report(false, "", `no dark page next to ${basename(page)} (${basename(pg)}): build both themes so the accent can be checked in each.`); continue; }
          const r = await accentIn(port, pg, { selector: acc.selector, pose, preload: spec.preload, wait: spec.wait });
          if (!r?.n) { report(false, "", `accent "${acc.selector}" shows no pixels in ${theme} theme${acc.state ? ` in state "${acc.state}"` : ""}.`); continue; }
          report(r.share >= T.accentMin, `accent stands off its neighbours in ${theme} theme: ${pctDown(r.share)}% of its pixels ≥ ${T.accentStep} luminance from the ring around it (≥ ${T.accentMin * 100}%)`, `accent is weak in ${theme} theme: only ${pctDown(r.share)}% of its pixels differ by ≥ ${T.accentStep} luminance from the parts around it (needs ≥ ${T.accentMin * 100}%; examples ${BASE.measured.range.accent.join("–")}). On light-toned parts the kit's lit style nearly vanishes (light theme: a white top on near-white parts; dark theme: the same on light greys). Use the high-contrast marker pattern in SKILL.md "Verification rounds".`);
        }
      }
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
