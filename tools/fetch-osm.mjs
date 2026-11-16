#!/usr/bin/env node
// Fetch + process OpenStreetMap data for the Tallinn Old Town flyer.
//   node tools/fetch-osm.mjs [slice|full] [--refetch]
// Raw Overpass response is cached in data/raw/<area>.osm.json and reused on every
// later run (pass --refetch to hit the API again). Output: data/<area>.json (source
// of truth) + data/<area>.js (same data as a <script> so index.html works from file://).
// Data © OpenStreetMap contributors, ODbL 1.0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AREAS = {
  slice: { s: 59.4355, w: 24.7425, n: 59.4385, e: 24.7485 },
  full: { s: 59.433, w: 24.738, n: 59.442, e: 24.757 },
};
const ORIGIN = { lat: 59.437, lon: 24.7454 }; // Raekoja plats
const LEVEL_H = 3.2, MARGIN = 40;
const area = process.argv.slice(2).find(a => !a.startsWith('--')) || 'slice';
const refetch = process.argv.includes('--refetch');
if (!AREAS[area]) { console.error('unknown area', area); process.exit(1); }
const B = AREAS[area];

// ---------- fetch (once) ----------
const rawPath = path.join(ROOT, 'data', 'raw', `${area}.osm.json`);
fs.mkdirSync(path.dirname(rawPath), { recursive: true });
if (refetch || !fs.existsSync(rawPath)) {
  const q = `[out:json][timeout:120][bbox:${B.s},${B.w},${B.n},${B.e}];
(
 way["building"]; relation["building"]["type"="multipolygon"];
 way["building:part"]; relation["building:part"]["type"="multipolygon"];
 way["highway"]; relation["highway"]["type"="multipolygon"];
 way["barrier"~"^(city_wall|wall|retaining_wall)$"]; way["historic"~"^(citywalls|city_wall)$"];
 way["leisure"~"^(park|garden|playground)$"]; relation["leisure"~"^(park|garden)$"];
 way["landuse"~"^(grass|village_green|cemetery|forest|meadow)$"];
 way["natural"~"^(wood|scrub|grassland)$"];
 node["natural"="tree"];
);
out body geom;`;
  let ok = false;
  const UA = { 'User-Agent': 'tallinn-flyer-prototype/0.1 (one-off cached fetch)' };
  // overpass-api.de refuses automated clients (HTTP 406/502), so only community mirrors are tried.
  const mirrors = process.argv.includes('--no-overpass') ? [] : ['https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (const url of mirrors) {
    console.log('fetching', url);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(45000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...UA } });
      if (!r.ok) { console.log('  HTTP', r.status); continue; }
      const txt = await r.text();
      JSON.parse(txt);
      fs.writeFileSync(rawPath, txt); ok = true; break;
    } catch (e) { console.log('  failed:', e.message); }
  }
  if (!ok) {
    // Fallback: official OSM API map call (same ODbL data), tiled to stay under its 50k-node limit,
    // then converted to the Overpass "out geom" shape the rest of this script expects.
    const el = new Map(), nx = Math.ceil((B.e - B.w) / 0.0065), ny = Math.ceil((B.n - B.s) / 0.005);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const bb = [B.w + (B.e - B.w) * i / nx, B.s + (B.n - B.s) * j / ny, B.w + (B.e - B.w) * (i + 1) / nx, B.s + (B.n - B.s) * (j + 1) / ny].map(v => v.toFixed(6)).join(',');
      console.log('fetching api.openstreetmap.org map', bb);
      const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${bb}`, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (!r.ok) { console.error('OSM API HTTP', r.status, await r.text()); process.exit(1); }
      for (const e of (await r.json()).elements) el.set(e.type + e.id, e);
      await new Promise(res => setTimeout(res, 1500));
    }
    const geom = w => w && w.nodes ? w.nodes.map(n => el.get('node' + n)).filter(Boolean).map(n => ({ lat: n.lat, lon: n.lon })) : undefined;
    const elements = [];
    for (const e of el.values()) {
      if (e.type === 'node') { if (e.tags) elements.push(e); }
      else if (e.type === 'way') { if (e.tags) elements.push({ type: 'way', id: e.id, tags: e.tags, geometry: geom(e) }); }
      else if (e.tags) elements.push({ type: 'relation', id: e.id, tags: e.tags, members: (e.members || []).map(m => ({ type: m.type, role: m.role, geometry: m.type === 'way' ? geom(el.get('way' + m.ref)) : undefined })) });
    }
    fs.writeFileSync(rawPath, JSON.stringify({ source: 'api.openstreetmap.org/api/0.6/map', elements }));
  }
} else console.log('using cached', path.relative(ROOT, rawPath));
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

// ---------- geometry helpers ----------
const rad = Math.PI / 180, phi = ORIGIN.lat * rad;
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const M_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
const proj = g => [(g.lon - ORIGIN.lon) * M_LON, -(g.lat - ORIGIN.lat) * M_LAT]; // x east, z south
const r1 = v => Math.round(v * 10) / 10;
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const sArea = p => { let a = 0; for (let i = 0, n = p.length; i < n; i++) { const q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; };
const centroid = p => { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; };
const perim = p => p.reduce((s, q, i) => s + Math.hypot(q[0] - p[(i + 1) % p.length][0], q[1] - p[(i + 1) % p.length][1]), 0);
function inPoly(pt, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if ((p[i][1] > pt[1]) !== (p[j][1] > pt[1]) && pt[0] < (p[j][0] - p[i][0]) * (pt[1] - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; } return c; }
function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1e-9;
  let mi = -1, md = tol;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((pts[i][0] - a[0]) * dz - (pts[i][1] - a[1]) * dx) / L; if (d > md) { md = d; mi = i; } }
  if (mi < 0) return [a, b];
  return rdp(pts.slice(0, mi + 1), tol).slice(0, -1).concat(rdp(pts.slice(mi), tol));
}
function cleanRing(pts, tol = 0.2) {
  let p = pts.map(q => [r1(q[0]), r1(q[1])]).filter((q, i, a) => !eq(q, a[(i + 1) % a.length]));
  if (p.length < 3) return null;
  let far = 0, fd = 0; p.forEach((q, i) => { const d = Math.hypot(q[0] - p[0][0], q[1] - p[0][1]); if (d > fd) { fd = d; far = i; } });
  p = rdp(p.slice(0, far + 1), tol).slice(0, -1).concat(rdp(p.slice(far).concat([p[0]]), tol).slice(0, -1));
  return p.length >= 3 ? p : null;
}
function obb(p) { // min-area oriented bbox over edge directions
  let best = null;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length], a = Math.atan2(q[1] - p[i][1], q[0] - p[i][0]), c = Math.cos(a), s = Math.sin(a);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const v of p) { const u = v[0] * c + v[1] * s, w = -v[0] * s + v[1] * c; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, w); y1 = Math.max(y1, w); }
    const A = (x1 - x0) * (y1 - y0);
    if (!best || A < best.A) best = { A, L: x1 - x0, W: y1 - y0, ang: a };
  }
  if (best.W > best.L) { [best.L, best.W] = [best.W, best.L]; best.ang += Math.PI / 2; }
  best.ang = Math.atan2(Math.sin(best.ang), Math.cos(best.ang));
  return best;
}
function stitch(ways) {
  const rings = [], segs = ways.map(w => w.slice());
  while (segs.length) {
    let cur = segs.pop();
    for (;;) {
      if (cur.length > 3 && eq(cur[0], cur[cur.length - 1])) { cur.pop(); rings.push(cur); break; }
      const b = cur[cur.length - 1], i = segs.findIndex(s => eq(s[0], b) || eq(s[s.length - 1], b));
      if (i < 0) break;
      const s = segs.splice(i, 1)[0]; if (!eq(s[0], b)) s.reverse();
      cur = cur.concat(s.slice(1));
    }
  }
  return rings;
}
function hashRand(id) { let s = (id * 2654435761) >>> 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- tag helpers ----------
const num = v => { if (v == null) return null; const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const NAMED = { white: '#e6dfd0', yellow: '#d9b96a', red: '#a3493a', brown: '#7a5a44', grey: '#8f8c86', gray: '#8f8c86', lightgrey: '#b5b1a8', lightgray: '#b5b1a8', darkgrey: '#5a5855', darkgray: '#5a5855', beige: '#d8c8a4', pink: '#d6a79c', green: '#9aab8c', blue: '#93a8bd', orange: '#c98a4e', black: '#33312f', cream: '#e3d6b4', maroon: '#7a3a30', tan: '#c9ad85', silver: '#a9acb0', lightyellow: '#e2d3a0', lightblue: '#a9bccb', lightgreen: '#b3c2a4', darkred: '#7d3a30', darkgreen: '#4f6a55', olive: '#8a8a5c', salmon: '#d3a498' };
function colour(v) {
  if (!v) return null; v = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('');
  return NAMED[v.replace(/[ _-]/g, '')] || null;
}
// Tagged colours are often sampled from sunlit imagery: cap saturation/lightness so they sit in the muted dusk palette.
function mute(hex, maxS, maxL) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let l = (mx + mn) / 2, d = mx - mn, s = d ? d / (1 - Math.abs(2 * l - 1)) : 0, h = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  s = Math.min(s, maxS); l = Math.min(l, maxL);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
  const [R, G, Bl] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, Bl].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
const FACADES =['#c9a25e', '#e3d6b4', '#a9b598', '#9fb0c0', '#d3a498', '#b9b3a4', '#dcc58a', '#e6dfd0', '#c7b08a', '#d9b99b'];
const ROOF_RED = ['#9a4230', '#a64b35', '#8a3b2e', '#b05a3c', '#7d3a30', '#93452f'];
const ROOF_MAT = { metal: '#5a5f66', copper: '#5f8f7a', slate: '#4a4d55', tar_paper: '#3f3d3c', concrete: '#77746f', glass: '#6f8a96', zinc: '#7a8088', eternit: '#6b6964' };
const LANDMARKS = [
  ['townhall', /tallinna raekoda|^raekoda$|town hall/i], ['oleviste', /oleviste|st\.? olaf/i], ['niguliste', /niguliste|st\.? nicholas/i],
  ['viru', /viru v[aä]rav/i], ['margareeta', /paks margareeta|fat margaret/i], ['kiek', /kiek in de k[oö]k/i],
  ['hermann', /pikk hermann/i], ['toompea', /toompea loss|toompea castle|riigikogu/i], ['nevski', /nevsk/i],
  ['puhavaimu', /p[üu]ha ?vaimu/i], ['toomkirik', /toomkirik|neitsi maarja piiskoplik/i],
];
const ROOF_MAP = { gabled: 'gabled', hipped: 'hipped', 'half-hipped': 'gabled', pyramidal: 'pyramidal', conical: 'conical', cone: 'conical', dome: 'dome', onion: 'onion', flat: 'flat', skillion: 'skillion', gambrel: 'gabled', mansard: 'hipped', round: 'gabled', saltbox: 'gabled', side_hipped: 'hipped' };
const SMALL = new Set(['garage', 'garages', 'shed', 'hut', 'roof', 'kiosk', 'service', 'carport', 'toilets', 'bunker']);
const MODERN = new Set(['retail', 'commercial', 'industrial', 'office', 'supermarket', 'parking', 'warehouse']);

// ---------- collect ----------
const x0 = (B.w - ORIGIN.lon) * M_LON - MARGIN, x1 = (B.e - ORIGIN.lon) * M_LON + MARGIN;
const z0 = -(B.n - ORIGIN.lat) * M_LAT - MARGIN, z1 = -(B.s - ORIGIN.lat) * M_LAT + MARGIN;
const inB = p => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1;
const polysOf = el => { // -> [{outer, holes}]
  if (el.type === 'way') { if (!el.geometry || el.geometry.length < 4) return []; const p = el.geometry.map(proj); if (!eq(p[0], p[p.length - 1])) return []; p.pop(); return [{ outer: p, holes: [] }]; }
  const get = role => stitch((el.members || []).filter(m => m.type === 'way' && m.geometry && (m.role === role || (role === 'outer' && !m.role))).map(m => m.geometry.map(proj)));
  const outers = get('outer').map(o => ({ outer: o, holes: [] }));
  for (const h of get('inner')) { const o = outers.find(o => inPoly(h[0], o.outer)); if (o) o.holes.push(h); }
  return outers;
};
const blds = [], parts = [], roads = [], plazas = [], walls = [], greens = [], trees = [];
const stats = { h: {}, r: {}, c: {}, rc: {} };
for (const el of raw.elements) {
  const t = el.tags || {};
  if (el.type === 'node') { if (t.natural === 'tree') { const p = proj(el); if (inB(p)) trees.push([r1(p[0]), r1(p[1])]); } continue; }
  const isPart = t['building:part'] && t['building:part'] !== 'no', isB = t.building && t.building !== 'no';
  if (el.type === 'relation' && t.type !== 'multipolygon') continue;
  if ((isPart || isB) && (t.location === 'underground' || num(t.layer) < 0)) continue;
  if (isPart || isB) {
    polysOf(el).forEach((pg, k) => {
      const outer = cleanRing(pg.outer); if (!outer) return;
      const A = Math.abs(sArea(outer)); if (A < (isPart ? 1 : 4)) return;
      if (!inB(centroid(outer))) return;
      if (sArea(outer) < 0) outer.reverse();
      const holes = pg.holes.map(h => cleanRing(h)).filter(h => h && Math.abs(sArea(h)) > 3).map(h => (sArea(h) > 0 ? h.reverse() : h));
      (isB ? blds : parts).push({ id: el.id * (el.type === 'relation' ? -1 : 1), k, t, outer, holes, A, isPart: !isB });
    });
    continue;
  }
  if (t.highway) {
    if (/proposed|construction|platform|bus_stop|elevator|corridor/.test(t.highway) || t.tunnel === 'yes' || t.indoor === 'yes' || t.level && num(t.level) < 0) continue;
    const g = el.type === 'way' ? el.geometry : null;
    const closed = g && g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    if (el.type === 'relation' || (closed && (t.area === 'yes' || (t.highway === 'pedestrian' && t.area !== 'no')))) {
      for (const pg of polysOf(el)) { const o = cleanRing(pg.outer, 0.3); if (o) plazas.push({ p: o.flat(), h: pg.holes.map(h => cleanRing(h, 0.3)).filter(Boolean).map(h => h.flat()) }); }
      continue;
    }
    if (!g) continue;
    const W = { primary: 12, secondary: 10, tertiary: 8, residential: 6, unclassified: 6, living_street: 5.5, pedestrian: 5, service: 3.5, cycleway: 2.5, footway: 2.2, path: 1.8, steps: 2.2, track: 3 }[t.highway.replace('_link', '')] || 3;
    const kind = /primary|secondary|tertiary/.test(t.highway) ? 2 : /footway|path|steps|cycleway/.test(t.highway) ? 0 : 1;
    let run = [];
    const flush = () => { if (run.length > 1) { const s = rdp(run.map(q => [r1(q[0]), r1(q[1])]), 0.3); roads.push({ p: s.flat(), w: num(t.width) || W, k: kind }); } run = []; };
    for (const q of g.map(proj)) { if (inB(q)) run.push(q); else flush(); }
    flush(); continue;
  }
  if (/^(city_wall|wall|retaining_wall)$/.test(t.barrier || '') || /^(citywalls|city_wall)$/.test(t.historic || '')) {
    if (!el.geometry) continue;
    const city = t.barrier === 'city_wall' || /citywalls|city_wall/.test(t.historic || '');
    let run = [];
    const flush = () => { if (run.length > 1) { const s = rdp(run.map(q => [r1(q[0]), r1(q[1])]), 0.3); walls.push({ p: s.flat(), h: num(t.height) || (city ? 9 : 2.4), w: city ? 2.2 : 0.5, city: city ? 1 : 0 }); } run = []; };
    for (const q of el.geometry.map(proj)) { if (inB(q)) run.push(q); else flush(); }
    flush(); continue;
  }
  if (/^(park|garden|playground)$/.test(t.leisure || '') || /^(grass|village_green|cemetery|forest|meadow)$/.test(t.landuse || '') || /^(wood|scrub|grassland)$/.test(t.natural || '')) {
    for (const pg of polysOf(el)) { const o = cleanRing(pg.outer, 0.4); if (o && inB(centroid(o))) greens.push({ p: o.flat(), wood: /wood|forest|park|garden/.test(t.natural || t.landuse || t.leisure) ? 1 : 0 }); }
  }
}

// ---------- outlines vs building:part ----------
const dropOutline = new Set(), keepPart = new Map();
for (const b of blds) {
  const mine = parts.filter(p => inPoly(centroid(p.outer), b.outer));
  if (!mine.length) continue;
  const cover = mine.reduce((s, p) => s + p.A, 0) / b.A;
  const bh = num(b.t.height) || (num(b.t['building:levels']) || 3) * LEVEL_H;
  for (const p of mine) {
    if (cover >= 0.5) keepPart.set(p, b);
    else if ((num(p.t.height) || (num(p.t['building:levels']) || 0) * LEVEL_H) > bh + 0.5) keepPart.set(p, b);
  }
  if (cover >= 0.5) dropOutline.add(b);
}
for (const p of parts) if (!keepPart.has(p) && !blds.some(b => inPoly(centroid(p.outer), b.outer))) keepPart.set(p, null);

// ---------- resolve attributes ----------
const out = [];
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const lowConf = [];
function resolve(b, parent) {
  const t = b.t, pt = parent ? parent.t : {}, seedId = parent ? Math.abs(parent.id) : Math.abs(b.id), rnd = hashRand(seedId);
  const type = t.building && t.building !== 'yes' ? t.building : (pt.building || 'yes');
  const name = t.name || pt.name || '', names = [name, t['name:en'], pt['name:en'], t['name:et'], pt['name:et']].filter(Boolean).join(' | ');
  const isChurch = /church|cathedral|chapel/.test(type) || t.amenity === 'place_of_worship' || pt.amenity === 'place_of_worship';
  const isTower = type === 'tower' || t.man_made === 'tower' || t['tower:type'] || /\btorn\b|torn$/i.test(name) || t.historic === 'city_gate';
  const ob = obb(b.outer), nv = b.outer.length, fill = b.A / ob.A, compact = 4 * Math.PI * b.A / perim(b.outer) ** 2;
  const hw = ob.W / 2;
  // roof shape
  let rs = ROOF_MAP[t['roof:shape']], rsrc = rs ? 'tag' : 'heuristic';
  if (t['roof:shape'] && !rs) { rs = 'flat'; rsrc = 'heuristic'; }
  if (!rs) {
    if (isTower) rs = nv >= 7 && compact > 0.8 ? 'conical' : 'pyramidal';
    else if (b.A < 14 || SMALL.has(type)) rs = 'flat';
    else if (MODERN.has(type) && b.A > 1500) rs = 'flat';
    else if (b.holes.length) rs = 'hipped';
    else if (fill >= 0.78 && nv <= 8) rs = ob.L / ob.W >= 1.15 || isChurch ? 'gabled' : 'hipped';
    else rs = 'hipped';
  }
  // ridge direction
  let ra = ob.ang;
  if (t['roof:orientation'] === 'across') ra += Math.PI / 2;
  // roof height
  let rh = num(t['roof:height']);
  if (rh == null) {
    const span = t['roof:orientation'] === 'across' ? ob.L / 2 : hw;
    rh = rs === 'flat' ? 0 : rs === 'gabled' ? Math.min(Math.max(span * 0.95, 1.5), 8) : rs === 'skillion' ? Math.min(span * 0.5, 3)
      : rs === 'hipped' ? Math.min(Math.max(hw * 0.8, 1.2), 5.5) : rs === 'conical' || rs === 'pyramidal' ? Math.min(Math.max(ob.W * (isTower ? 0.9 : 0.5), 2), 12) : rs === 'dome' ? ob.W * 0.5 : rs === 'onion' ? ob.W * 1.1 : 0;
  }
  // height (h = eave height above ground, mh = base)
  let h, hsrc;
  const th = num(t.height) ?? num(t['building:height']), lv = num(t['building:levels']);
  if (th != null) { h = Math.max(th - rh, Math.min(th, 2.5)); hsrc = 'tag'; }
  else if (lv != null) { h = Math.max(lv, 1) * LEVEL_H; hsrc = 'levels'; }
  else if (parent && (num(pt.height) != null || num(pt['building:levels']) != null)) { h = num(pt.height) != null ? Math.max(num(pt.height) - rh, 2.5) : num(pt['building:levels']) * LEVEL_H; hsrc = 'parent'; }
  else { hsrc = 'default'; h = isChurch ? 16 : isTower ? 18 : SMALL.has(type) ? 3 : b.A < 30 ? 3.5 : LEVEL_H * (2 + Math.floor(rnd() * 3)) + (rnd() - 0.5); }
  const mh = num(t.min_height) ?? (num(t['building:min_level']) != null ? num(t['building:min_level']) * LEVEL_H : 0);
  if (h <= mh + 0.3) h = mh + 0.3;
  // colours
  let c = colour(t['building:colour']) || colour(pt['building:colour']), csrc = c ? 'tag' : 'palette';
  if (c) c = mute(c, 0.42, 0.78);
  if (!c) c = isChurch || isTower ? '#b3ad9e' : FACADES[Math.floor(rnd() * FACADES.length)];
  let rc = colour(t['roof:colour']) || colour(pt['roof:colour']), rcsrc = rc ? 'tag' : 'palette';
  if (rc) rc = mute(rc, 0.58, 0.4);
  if (!rc) { const mat = t['roof:material'] || pt['roof:material'], m = mat === 'metal' ? ['#5a5f66', '#6b4a40', '#4f5a52', '#7a4636'][Math.floor(rnd() * 4)] : ROOF_MAT[mat]; if (m) { rc = m; rcsrc = 'material'; } else rc = rs === 'flat' ? ['#55504c', '#5e5a55', '#4c4a48'][Math.floor(rnd() * 3)] : ROOF_RED[Math.floor(hashRand(Math.abs(b.id) + b.k)() * ROOF_RED.length)]; }
  let lm; for (const [key, re] of LANDMARKS) if (re.test(names)) { lm = key; break; }
  bump(stats.h, hsrc); bump(stats.r, rsrc); bump(stats.c, csrc); bump(stats.rc, rcsrc);
  if (hsrc === 'default' || rsrc === 'heuristic') lowConf.push({ id: b.id, name, A: Math.round(b.A), hsrc, rsrc, rs, h: r1(h) });
  const o = { id: b.id, p: b.outer.flat(), h: r1(h), rs, rh: r1(rh), ra: Math.round(ra * 1000) / 1000, c, rc };
  if (b.holes.length) o.holes = b.holes.map(h => h.flat());
  if (mh) o.mh = r1(mh);
  if (name) o.n = name;
  if (lm) o.lm = lm;
  if (isChurch) o.ch = 1;
  if (isTower) o.tw = 1;
  if (b.isPart) o.part = 1;
  o.q = (hsrc === 'tag' ? 'T' : hsrc === 'default' ? 'D' : 'L') + (rsrc === 'tag' ? 'T' : 'H'); // quality flags: height, roof
  out.push(o);
}
for (const b of blds) if (!dropOutline.has(b)) resolve(b, null);
for (const [p, parent] of keepPart) resolve(p, parent);

const data = {
  meta: { area, bbox: B, origin: ORIGIN, bounds: [x0, z0, x1, z1].map(r1), generated: new Date().toISOString().slice(0, 10),
    attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0 — https://www.openstreetmap.org/copyright', stats },
  b: out, roads, plazas, walls, greens, trees,
};
const json = JSON.stringify(data);
fs.writeFileSync(path.join(ROOT, 'data', `${area}.json`), json);
fs.writeFileSync(path.join(ROOT, 'data', `${area}.js`), `// Generated by tools/fetch-osm.mjs from data/${area}.json — do not edit.\n// Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)\nwindow.TALLINN=${json};\n`);

// ---------- report ----------
console.log(`\n${area}: ${out.length} buildings/parts (${dropOutline.size} outlines replaced by parts), ${roads.length} road runs, ${plazas.length} plazas, ${walls.length} walls, ${greens.length} green areas, ${trees.length} trees — ${(json.length / 1024).toFixed(0)} KB`);
console.log('height source :', stats.h); console.log('roof source   :', stats.r); console.log('facade colour :', stats.c); console.log('roof colour   :', stats.rc);
console.log('landmarks     :', out.filter(o => o.lm).map(o => `${o.lm}(${o.id}${o.part ? ' part' : ''} h=${o.h} ${o.rs})`).join(', ') || 'none');
console.log('named         :', out.filter(o => o.n && !o.part).length);
console.log('largest low-confidence buildings (default height and/or heuristic roof):');
for (const l of lowConf.sort((a, b) => b.A - a.A).slice(0, 15)) console.log(`  ${String(l.id).padEnd(11)} ${String(l.A).padStart(5)} m²  h=${l.h} (${l.hsrc})  roof=${l.rs} (${l.rsrc})  ${l.name}`);
fs.writeFileSync(path.join(ROOT, 'data', `${area}.report.json`), JSON.stringify({ stats, lowConfidence: lowConf }, null, 1));
