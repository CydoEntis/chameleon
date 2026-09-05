const fs = require("fs");
const path = require("path");
const dir = "themes";
const files = fs.readdirSync(dir).filter(f=>f.endsWith(".json") && f!=="index.json");
function chromaOf(hex){
  hex = hex.replace("#","");
  const r=parseInt(hex.slice(0,2),16), g=parseInt(hex.slice(2,4),16), b=parseInt(hex.slice(4,6),16);
  return (Math.max(r,g,b)-Math.min(r,g,b))/255;
}
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
  const ground = data.payloads.herdr.ground;
  const sel = data.payloads.herdr.selection_bg;
  console.log(f, "ground", ground, chromaOf(ground).toFixed(3), "sel", sel, chromaOf(sel).toFixed(3));
}
