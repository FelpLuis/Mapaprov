// Importação e exportação KML/KMZ (ex.: projetos exportados do IXC Fiber Docs, Google Earth, OZmap)
import { CABLE_TYPES, KINDS, KIND_ORDER, defaultCableProps, defaultProps } from './config.js';
import { dist, lineLength } from './geo.js';
import { uid } from './store.js';

/* global JSZip */

export async function readKmlFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.kmz') || name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.toLowerCase().endsWith('.kml'));
    if (!entries.length) throw new Error('O KMZ não contém nenhum arquivo .kml.');
    entries.sort((a, b) => (a.name.toLowerCase() === 'doc.kml' ? -1 : b.name.toLowerCase() === 'doc.kml' ? 1 : 0));
    return entries[0].async('text');
  }
  return file.text();
}

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const childText = (node, tag) => {
  for (const c of node.children) if (c.localName === tag) return c.textContent.trim();
  return '';
};

function parseCoords(text) {
  return text.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2 && isFinite(c[0]) && isFinite(c[1])).map((c) => [c[0], c[1]]);
}

function kmlColorToHex(c) {
  // KML usa aabbggrr
  if (!c || c.length !== 8) return '';
  return `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}`;
}

function collectStyles(doc) {
  const styles = new Map();
  for (const st of doc.getElementsByTagName('Style')) {
    const id = st.getAttribute('id');
    if (!id) continue;
    const ls = st.getElementsByTagName('LineStyle')[0];
    const is = st.getElementsByTagName('IconStyle')[0];
    styles.set(id, {
      line: ls ? kmlColorToHex(childText(ls, 'color')) : '',
      icon: is ? (is.getElementsByTagName('href')[0]?.textContent || '') : '',
    });
  }
  for (const sm of doc.getElementsByTagName('StyleMap')) {
    const id = sm.getAttribute('id');
    const normal = [...sm.getElementsByTagName('Pair')].find((p) => childText(p, 'key') === 'normal');
    const url = normal ? childText(normal, 'styleUrl').replace(/^#/, '') : '';
    if (id && styles.has(url)) styles.set(id, styles.get(url));
  }
  return styles;
}

function folderPath(pm) {
  const parts = [];
  for (let n = pm.parentElement; n; n = n.parentElement) {
    if (n.localName === 'Folder' || n.localName === 'Document') {
      const nm = childText(n, 'name');
      if (nm) parts.unshift(nm);
    }
  }
  return parts.join(' / ');
}

function extended(pm) {
  const out = {};
  for (const d of pm.getElementsByTagName('Data')) {
    const k = d.getAttribute('name');
    if (k) out[k] = childText(d, 'value');
  }
  for (const d of pm.getElementsByTagName('SimpleData')) {
    const k = d.getAttribute('name');
    if (k) out[k] = d.textContent.trim();
  }
  return out;
}

export function classifyPoint(text) {
  const t = norm(text);
  if (/\bCTO\b|ATENDIMENTO|\bNAP\b|TERMINACAO|\bCAT\b/.test(t)) return 'cto';
  if (/\bCEO\b|EMENDA|SPLICE|\bCE\b|\bCEF\b/.test(t)) return 'ceo';
  if (/\bPOP\b|\bOLT\b|DATA ?CENTER|CENTRAL|\bDIO\b/.test(t)) return 'pop';
  if (/RESERVA|\bRT\b|SOBRA/.test(t)) return 'reserva';
  if (/POSTE|\bPT\b|POLE|\bPST\b/.test(t)) return 'poste';
  if (/CLIENTE|\bONU\b|\bONT\b|ASSINANTE/.test(t)) return 'cliente';
  return 'marcador';
}

export function classifyLine(text) {
  const t = norm(text);
  if (/DROP|\bBLI\b|ASSINANTE/.test(t)) return 'drop';
  if (/BACKBONE|TRONCO|FEEDER|ALIMENTA|PRIMARIO|\bBKB\b/.test(t)) return 'backbone';
  return 'distribuicao';
}

export function fiberCount(text, tipo) {
  const t = norm(text);
  const m = t.match(/(\d{1,3})\s*(?:FO|F|FIBRAS?|FIBERS?|FB)\b/) || t.match(/\bAS\s?\d{2,3}[^\d]{1,4}(\d{1,3})\b/) || t.match(/\b(\d{1,3})\s*FO/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n <= 576 ? n : (CABLE_TYPES[tipo] || CABLE_TYPES.distribuicao).fibras;
}

/**
 * Lê um texto KML e devolve elementos, cabos e uma camada de referência (polígonos e o que não for rede).
 */
export function parseKml(text, { snapMeters = 3 } = {}) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Arquivo KML inválido.');
  const styles = collectStyles(doc);
  const elements = [], cables = [], refFeatures = [];
  const counters = {};
  const nextName = (k) => { counters[k] = (counters[k] || 0) + 1; return `${KINDS[k]?.short || 'Cabo'}-${String(counters[k]).padStart(2, '0')}`; };

  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = childText(pm, 'name');
    const desc = childText(pm, 'description');
    const folder = folderPath(pm);
    const styleId = childText(pm, 'styleUrl').replace(/^#/, '');
    const style = styles.get(styleId) || {};
    const ext = extended(pm);
    const hint = `${folder} ${name} ${styleId} ${style.icon || ''} ${Object.values(ext).join(' ')}`;

    const points = [...pm.getElementsByTagName('Point')].map((g) => parseCoords(g.getElementsByTagName('coordinates')[0]?.textContent || '')[0]).filter(Boolean);
    const lines = [...pm.getElementsByTagName('LineString')].map((g) => parseCoords(g.getElementsByTagName('coordinates')[0]?.textContent || '')).filter((c) => c.length >= 2);
    const polys = [...pm.getElementsByTagName('Polygon')].map((g) => {
      const outer = g.getElementsByTagName('outerBoundaryIs')[0] || g;
      return parseCoords(outer.getElementsByTagName('coordinates')[0]?.textContent || '');
    }).filter((c) => c.length >= 3);

    for (const p of points) {
      const kind = classifyPoint(hint);
      elements.push({
        id: uid('e'), kind, name: name || nextName(kind), lng: p[0], lat: p[1],
        props: mergeExt({ ...defaultProps(kind), obs: desc ? stripHtml(desc).slice(0, 2000) : '', kml: { pasta: folder, ...ext } }, ext),
      });
    }
    for (const coords of lines) {
      const tipo = classifyLine(hint);
      const props = mergeExt({ ...defaultCableProps(tipo), fibras: fiberCount(`${name} ${folder} ${Object.values(ext).join(' ')}`, tipo), cor: style.line || '', obs: desc ? stripHtml(desc).slice(0, 2000) : '', kml: { pasta: folder, ...ext } }, ext, ['fibras', 'tipo']);
      if (/SUBTERR|DUTO|CANALIZ/.test(norm(hint))) props.lancamento = 'subterraneo';
      cables.push({ id: uid('c'), name: name || nextName('cabo'), coords, nodes: coords.map(() => null), props });
    }
    for (const ring of polys) {
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      refFeatures.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { name, pasta: folder } });
    }
  }

  snapCables(cables, elements, snapMeters);
  return { elements, cables, refFeatures };
}

// copia campos do ExtendedData com o mesmo nome das propriedades (ex.: portas, modelo, altura)
function mergeExt(props, ext, skip = []) {
  const keys = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const [k, v] of Object.entries(ext)) {
    const key = keys.get(k.toLowerCase());
    if (!key || skip.includes(key) || ['kml', 'splitters', 'fusoes', 'obs'].includes(key) || v === '') continue;
    props[key] = typeof props[key] === 'number' ? (Number(String(v).replace(',', '.')) || props[key]) : v;
  }
  return props;
}

function stripHtml(s) {
  const d = new DOMParser().parseFromString(`<body>${s}</body>`, 'text/html');
  return (d.body.textContent || '').replace(/\s+\n/g, '\n').trim();
}

// liga vértices dos cabos aos elementos próximos (postes, caixas...) para formar a topologia da rede
export function snapCables(cables, elements, maxM = 3) {
  const cell = 0.0005;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  for (const e of elements) {
    const k = key(e.lng, e.lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
  }
  const prio = { pop: 0, ceo: 1, cto: 2, cliente: 3, reserva: 4, poste: 5, marcador: 9 };
  for (const c of cables) {
    c.coords.forEach((pt, i) => {
      if (c.nodes[i]) return;
      const gx = Math.floor(pt[0] / cell), gy = Math.floor(pt[1] / cell);
      let best = null, bestD = maxM, bestP = 99;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const e of grid.get(`${gx + dx}:${gy + dy}`) || []) {
          if (e.kind === 'marcador') continue;
          const d = dist(pt, [e.lng, e.lat]);
          const p = prio[e.kind] ?? 9;
          if (d <= maxM && (p < bestP || (p === bestP && d < bestD))) { best = e; bestD = d; bestP = p; }
        }
      }
      if (best) { c.nodes[i] = best.id; c.coords[i] = [best.lng, best.lat]; }
    });
  }
}

/* ---------------------------------- exportação ---------------------------------- */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hexToKml = (hex, a = 'ff') => {
  const h = (hex || '#ffffff').replace('#', '');
  return `${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
};

function flatProps(props) {
  const out = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'kml' || k === 'fusoes') continue;
    if (k === 'splitters') { out.push([k, (v || []).map((s) => s.tipo).join(', ')]); continue; }
    if (v !== '' && v != null && typeof v !== 'object') out.push([k, v]);
  }
  return out;
}

function placemark(name, styleId, props, geomXml) {
  const fp = flatProps(props);
  const descr = fp.length ? `<![CDATA[<table>${fp.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>]]>` : '';
  const ext = fp.map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join('');
  return `<Placemark><name>${esc(name)}</name><description>${descr}</description><styleUrl>#${styleId}</styleUrl><ExtendedData>${ext}</ExtendedData>${geomXml}</Placemark>`;
}

export function toKml(project, { cableLength } = {}) {
  const icons = { pop: 'square', ceo: 'polygon', cto: 'placemark_square', poste: 'shaded_dot', reserva: 'donut', cliente: 'homegardenbusiness', marcador: 'placemark_circle' };
  const styles = [];
  for (const k of KIND_ORDER) {
    const href = k === 'cliente' ? 'http://maps.google.com/mapfiles/kml/shapes/homegardenbusiness.png' : `http://maps.google.com/mapfiles/kml/shapes/${icons[k]}.png`;
    styles.push(`<Style id="k_${k}"><IconStyle><color>${hexToKml(KINDS[k].color)}</color><scale>${k === 'poste' ? 0.6 : 0.9}</scale><Icon><href>${href}</href></Icon></IconStyle><LabelStyle><scale>0.7</scale></LabelStyle></Style>`);
  }
  for (const [t, def] of Object.entries(CABLE_TYPES)) {
    styles.push(`<Style id="c_${t}"><LineStyle><color>${hexToKml(def.color)}</color><width>${t === 'backbone' ? 4 : t === 'drop' ? 1.5 : 3}</width></LineStyle></Style>`);
  }
  const folders = [];
  for (const k of KIND_ORDER) {
    const els = project.elements.filter((e) => e.kind === k);
    if (!els.length) continue;
    folders.push(`<Folder><name>${esc(KINDS[k].label)}</name>${els.map((e) => placemark(e.name, `k_${k}`, { tipo: KINDS[k].short, ...e.props }, `<Point><coordinates>${e.lng},${e.lat},0</coordinates></Point>`)).join('')}</Folder>`);
  }
  for (const [t, def] of Object.entries(CABLE_TYPES)) {
    const cs = project.cables.filter((c) => c.props.tipo === t && c.coords.length >= 2);
    if (!cs.length) continue;
    folders.push(`<Folder><name>Cabos · ${esc(def.label)}</name>${cs.map((c) => {
      const len = cableLength ? cableLength(c) : lineLength(c.coords);
      const props = { ...c.props, comprimento_m: Math.round(len) };
      const geom = `<LineString><tessellate>1</tessellate><coordinates>${c.coords.map((p) => `${p[0]},${p[1]},0`).join(' ')}</coordinates></LineString>`;
      return placemark(c.name, `c_${t}`, props, geom);
    }).join('')}</Folder>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(project.name)}</name>${styles.join('')}${folders.join('')}</Document></kml>\n`;
}

export async function toKmz(project, opts) {
  const zip = new JSZip();
  zip.file('doc.kml', toKml(project, opts));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz', compression: 'DEFLATE' });
}

export function toGeoJSON(project) {
  return {
    type: 'FeatureCollection',
    features: [
      ...project.elements.map((e) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lng, e.lat] }, properties: { id: e.id, tipo: e.kind, nome: e.name, ...flatObj(e.props) } })),
      ...project.cables.map((c) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c.coords }, properties: { id: c.id, tipo: 'cabo', nome: c.name, comprimento_m: Math.round(lineLength(c.coords)), ...flatObj(c.props) } })),
    ],
  };
}

function flatObj(p) { return Object.fromEntries(flatProps(p)); }
