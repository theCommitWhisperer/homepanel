// Renders public/icon.svg to the PNG sizes the manifest and iOS need.
import fs from "node:fs";
import { launch } from "./browser.mjs";
const svg = fs.readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");
const b = await launch();
const p = await b.newPage();
for (const size of [192, 512]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:#161c22}</style>${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}`);
  await p.screenshot({ path: new URL(`../public/icon-${size}.png`, import.meta.url).pathname });
}
await b.close();
console.log("icons written");
