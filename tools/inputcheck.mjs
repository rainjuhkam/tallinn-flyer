// Checks controls + collision with real key events, and that the climb/drop buttons only show on touch devices.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hold = async (page, key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); await sleep(500); };
{
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
  await page.goto(url + '?q=high'); await page.waitForFunction('window.__tf');
  console.log('desktop: vert buttons hidden =', await page.evaluate("document.getElementById('vert').hidden"), '| start', await page.evaluate('__tf.pos()'));
  await page.evaluate('__tf.pose(-5,2.5,-55,Math.PI,0.2)'); // facing south toward the Town Hall north wall (~z=-12)
  await hold(page, 'KeyW', 7000); console.log('W 7s into Town Hall  ->', await page.evaluate('__tf.pos()'), '(should stop near z=-13)');
  await hold(page, 'ShiftLeft', 6000); console.log('Shift 6s (ascend)    ->', await page.evaluate('__tf.pos()'));
  await hold(page, 'KeyW', 3000); console.log('W 3s over the roof   ->', await page.evaluate('__tf.pos()'), '(z should now pass the wall)');
  await hold(page, 'ControlLeft', 8000); console.log('Ctrl 8s (descend)    ->', await page.evaluate('__tf.pos()'), '(should rest on roof or ground, not inside)');
  await page.close();
}
{
  const page = await browser.newPage();
  await page.emulate({ viewport: { width: 400, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' });
  await page.goto(url); await page.waitForFunction('window.__tf'); await sleep(800);
  console.log('mobile: vert buttons hidden =', await page.evaluate("document.getElementById('vert').hidden"), '| quality', await page.evaluate('__tf.render().q'), '| scrollW', await page.evaluate('document.documentElement.scrollWidth'));
  await page.screenshot({ path: path.join(ROOT, 'shots', '6-mobile.png') });
  await page.close();
}
await browser.close();
