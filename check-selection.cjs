const fs = require("fs");
function hex2rgb(h) {
  h = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
}
function lin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLum(hex) {
  const [r, g, b] = hex2rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const la = relLum(a),
    lb = relLum(b);
  const l = Math.max(la, lb),
    d = Math.min(la, lb);
  return (l + 0.05) / (d + 0.05);
}
const files = fs.readdirSync("themes").filter((f) => f.endsWith(".json") && f !== "index.json");
let failGround = 0,
  failBody = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync("themes/" + f, "utf8"));
  const wt = j.payloads && j.payloads["windows-terminal"];
  const omp = j.payloads && j.payloads["oh-my-posh"];
  if (!wt || !omp) {
    console.log(f, "NO PAYLOAD SHAPE", Object.keys(j));
    continue;
  }
  const sel = wt.selectionBackground;
  const body = omp.body;
  const ground = omp.ground;
  const rg = ratio(sel, ground);
  const rb = ratio(sel, body);
  if (rg < 2.0) failGround++;
  if (rb < 4.5) failBody++;
  console.log(f.padEnd(28), "sel/ground=", rg.toFixed(2), "sel/body=", rb.toFixed(2));
}
console.log("failGround", failGround, "failBody", failBody);
