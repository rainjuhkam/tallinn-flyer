#!/usr/bin/env node
// Self-check: screenshots + scripted fly-through frame times, using the locally installed Edge/Chrome.
//   cd tools && npm i puppeteer-core   (one-off, dev only)
//   node tools/selfcheck.mjs [area] [quality] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [area = 'slice', q = 'high', outDir = path.join(ROOT, 'shots')] = process.argv.slice(2);
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
if (!exe) { console.error('no Chrome/Edge found'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,720', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + `?area=${area}&q=${q}&clean=1`);
await page.waitForFunction('window.__tf', { timeout: 30000 }).catch(() => {});
if (errs.length || !(await page.evaluate('!!window.__tf'))) { console.log('PAGE ERRORS:', errs); await browser.close(); process.exit(1); }
console.log('gpu:', await page.evaluate('__tf.gpu()'));
console.log('scene:', JSON.stringify(await page.evaluate('({...__tf.info,lamps:__tf.lamps,trees:__tf.trees})')));
// [name, x, y, z, yaw, pitch]
const shots = JSON.parse(process.env.SHOTS || 'null') || [
  ['1-square-ground', -5, 2.5, -55, Math.PI, 0.12],
  ['2-street-ground', 60, 2.5, -40, 1.2, 0.1],
  ['3-rooftops', -60, 32, -110, Math.PI + 0.6, 0.45],
  ['4-above', 0, 90, 40, 0, 1.0],
  ['5-topdown', 0, 150, -20, 0, 1.5],
];
for (const [name, x, y, z, yaw, pitch] of shots) {
  await page.evaluate(`__tf.pose(${x},${y},${z},${yaw},${pitch})`);
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(name, JSON.stringify(await page.evaluate('__tf.render()')));
}
if (!process.env.NOFLY) console.log('fly-through:', JSON.stringify(await page.evaluate('__tf.fly(10)')));
if (errs.length) console.log('PAGE ERRORS:', errs);
await browser.close();
