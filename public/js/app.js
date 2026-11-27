// Fiber 3D — projetista de redes FTTH em mapa 3D (Cubatão/SP)
import { CITY, SOURCES, KINDS, KIND_ORDER, CABLE_TYPES, FIBER_COUNTS, SPLITTERS, defaultProps, defaultCableProps, LOSS } from './config.js';
import { dist, fmtM, lineLength, bboxOf } from './geo.js';
import { store, uid, emptyProject } from './store.js';
import { buildPoints, buildCableLines, build3D, buildHandles, buildRefs, ctoUsage } from './render.js';
import { readKmlFile, parseKml, snapCables, toKml, toKmz, toGeoJSON } from './kml.js';
import { cableLength, powerBudget, materials, materialsCsv } from './analysis.js';
import { openSplice } from './splice.js';
import { h, clear, toast, modal, download, pickFile, field, select } from './ui.js';
import { enableGoogle3D, disableGoogle3D, googleActive } from './google3d.js';

/* global maplibregl */
maplibregl.setWorkerUrl(new URL('../vendor/maplibre-gl-csp-worker.js', import.meta.url).href);

const PREFS_KEY = 'fiber3d.prefs.v1';
const prefs = Object.assign({
  satellite: false, terrain: true, exaggeration: 1.2, buildings: true, boundary: true, labels: true, scale3d: 3,
  google3d: false, googleZ: 0, googleKey: '', mapillaryToken: '',
  hiddenKinds: [], hiddenCables: [], autoPoles: true, cableTipo: 'distribuicao', cableFibras: 12, cableLanc: 'aereo', view: null,
}, (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })());
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// chaves compartilhadas pela equipe: arquivo opcional public/config.json no servidor (fora do git)
const siteConfig = await fetch('config.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const googleKey = () => (prefs.googleKey || siteConfig.googleMapsKey || '').trim();
const mapillaryToken = () => (prefs.mapillaryToken || siteConfig.mapillaryToken || '').trim();

const state = {
  tool: 'select',          // select | add:<kind> | cable | drop | measure
  sel: null,               // { type: 'el'|'cable', id }
  draft: null,             // { coords: [], nodes: [] }
  measure: [],
  drag: null,
  overlayEdit: null,       // id da imagem de planta em ajuste
  tab: 'tools',
  hasGlyphs: false,
  basemapOk: false,
};

/* ---------------------------------------------------------------- mapa ---------------------------------------------------------------- */

async function loadStyle() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(SOURCES.style, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(r.status);
    state.basemapOk = true;
    return await r.json();
  } catch {
    // sem acesso ao mapa base vetorial: usa fundo liso + satélite
    prefs.satellite = true;
    return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#d9dee5' } }] };
  }
}

const style = await loadStyle();
state.hasGlyphs = !!style.glyphs;
const v = prefs.view || {};
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: v.center || CITY.center,
  zoom: v.zoom ?? CITY.zoom,
  pitch: v.pitch ?? CITY.pitch,
  bearing: v.bearing ?? CITY.bearing,
  maxPitch: 85,
  hash: false,
  attributionControl: { compact: true },
  canvasContextAttributes: { antialias: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
window.fiberMap = map; // útil para depuração no console

const EMPTY = { type: 'FeatureCollection', features: [] };
let baseLayerIds = [];

function firstLayer(pred) { return map.getStyle().layers.find(pred)?.id; }

map.on('load', () => {
  baseLayerIds = map.getStyle().layers.map((l) => l.id);
  // satélite (Esri World Imagery) abaixo das ruas e rótulos
  map.addSource('sat', { type: 'raster', tiles: [SOURCES.satellite], tileSize: 256, maxzoom: 19, attribution: 'Imagens © Esri, Maxar, Earthstar Geographics' });
  const beforeSat = firstLayer((l) => l['source-layer'] === 'transportation' || l.type === 'symbol' || l.type === 'fill-extrusion');
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: prefs.satellite ? 'visible' : 'none' } }, beforeSat);

  // relevo (Serra do Mar)
  map.addSource('dem', { type: 'raster-dem', tiles: [SOURCES.terrain], tileSize: 256, encoding: 'terrarium', maxzoom: 15, attribution: 'Relevo: Mapzen/AWS Terrain Tiles' });
  map.addSource('dem-hs', { type: 'raster-dem', tiles: [SOURCES.terrain], tileSize: 256, encoding: 'terrarium', maxzoom: 15 });
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#334155' }, layout: { visibility: prefs.terrain ? 'visible' : 'none' } }, beforeSat);
  applyTerrain();
  try { map.setSky({ 'sky-color': '#7dd3fc', 'horizon-color': '#e0f2fe', 'fog-color': '#e2e8f0', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.8 }); } catch { /* opcional */ }

  // limite municipal (IBGE)
  map.addSource('boundary', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', paint: { 'line-color': '#a855f7', 'line-width': 2.5, 'line-dasharray': [3, 2] } });
  fetch(SOURCES.ibge(CITY.ibge)).then((r) => r.json()).then((g) => map.getSource('boundary').setData(g)).catch(() => {});

  // planta / referências
  map.addSource('refs', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'refs-fill', type: 'fill', source: 'refs', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', '_color'], 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'refs-line', type: 'line', source: 'refs', paint: { 'line-color': ['get', '_color'], 'line-width': 1.5 } });
  map.addLayer({ id: 'refs-pt', type: 'circle', source: 'refs', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': ['get', '_color'], 'circle-radius': 4 } });

  // rede
  map.addSource('cables', { type: 'geojson', data: EMPTY });
  map.addSource('net3d', { type: 'geojson', data: EMPTY });
  map.addSource('points', { type: 'geojson', data: EMPTY });
  map.addSource('draft', { type: 'geojson', data: EMPTY });
  map.addSource('handles', { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'cable-casing', type: 'line', source: 'cables', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['==', ['get', 'sel'], 1], '#22d3ee', '#0f172a'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 7], 'line-opacity': 0.55 } });
  map.addLayer({ id: 'cable-line', type: 'line', source: 'cables', filter: ['!=', ['get', 'lanc'], 'subterraneo'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, ['case', ['==', ['get', 'tipo'], 'backbone'], 4.5, ['==', ['get', 'tipo'], 'drop'], 1.8, 3.2]] } });
  map.addLayer({ id: 'cable-ug', type: 'line', source: 'cables', filter: ['==', ['get', 'lanc'], 'subterraneo'],
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 3.5], 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'net3d', type: 'fill-extrusion', source: 'net3d',
    paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.96 } });
  map.addLayer({ id: 'points', type: 'circle', source: 'points',
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, ['match', ['get', 'kind'], 'poste', 1.5, 'cliente', 2, 3], 18, ['match', ['get', 'kind'], 'poste', 5, 'cliente', 5, 'pop', 10, 8]],
      'circle-stroke-color': ['case', ['==', ['get', 'sel'], 1], '#22d3ee', '#0f172a'],
      'circle-stroke-width': ['case', ['==', ['get', 'sel'], 1], 3, 1.2],
      'circle-pitch-alignment': 'map',
    } });
  if (state.hasGlyphs) {
    map.addLayer({ id: 'point-labels', type: 'symbol', source: 'points', minzoom: 16, filter: ['!=', ['get', 'kind'], 'poste'],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#f8fafc', 'text-halo-color': '#0f172a', 'text-halo-width': 1.6 } });
    map.addLayer({ id: 'cable-labels', type: 'symbol', source: 'cables', minzoom: 17,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
      paint: { 'text-color': '#fde68a', 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 } });
  }
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#22d3ee', 'line-width': 3, 'line-dasharray': [1.5, 1] } });
  map.addLayer({ id: 'draft-pt', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': '#22d3ee', 'circle-radius': 4, 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1 } });
  map.addSource('sv', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'sv', type: 'circle', source: 'sv', paint: { 'circle-color': '#facc15', 'circle-radius': 8, 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'handles', type: 'circle', source: 'handles', paint: { 'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': '#0891b2', 'circle-stroke-width': 2.5, 'circle-pitch-alignment': 'map' } });

  applyBuildings();
  applyLabels();
  for (const o of store.project.overlays) addOverlayLayer(o);
  refreshMap();
  renderTab();
  updateStatus();
  if (!state.basemapOk) toast('Mapa base vetorial indisponível — usando imagem de satélite.', 'warn', 6000);
  if (prefs.google3d) applyGoogleMode();
});

/* ------------------------------------------------------- modo realista (Google) ------------------------------------------------------- */

const credits = document.getElementById('g-credits');

async function applyGoogleMode() {
  const on = prefs.google3d && !!googleKey();
  if (on && !googleActive()) {
    // o conteúdo do Google não é misturado com outros mapas base: esconde OSM/satélite/relevo
    for (const id of baseLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    map.setLayoutProperty('sat', 'visibility', 'none');
    map.setLayoutProperty('hillshade', 'visibility', 'none');
    map.setTerrain(null);
    credits.hidden = false;
    clear(credits, h('b', null, 'Google'), h('span', null, ''));
    try {
      await enableGoogle3D(map, {
        key: googleKey(),
        beforeId: 'cable-casing',
        onCredits: (t) => { credits.lastChild.textContent = t ? ` · ${t}` : ''; },
        onError: (msg) => toast(`Google 3D: ${msg}. Confira a chave e se a "Map Tiles API" está ativada no Google Cloud.`, 'error', 10000),
      });
      if (map.getPitch() < 40) map.easeTo({ pitch: 60 });
    } catch (err) {
      toast(`Não foi possível ativar o modo realista: ${err.message}`, 'error', 8000);
      prefs.google3d = false; savePrefs(); applyGoogleMode();
    }
  } else if (!on && googleActive()) {
    disableGoogle3D(map);
    credits.hidden = true;
    for (const id of baseLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
    if (!state.basemapOk && map.getLayer('bg')) map.setLayoutProperty('bg', 'visibility', 'visible');
    map.setLayoutProperty('sat', 'visibility', prefs.satellite ? 'visible' : 'none');
    applyBuildings();
    applyLabels();
    applyTerrain();
  }
  refreshMap();
}

/* ------------------------------------------------------------- Street View ------------------------------------------------------------ */

const sv = document.getElementById('sv');
const svFrame = document.getElementById('sv-frame');
const svTitle = document.getElementById('sv-title');
document.getElementById('sv-close').onclick = () => { sv.hidden = true; svFrame.src = 'about:blank'; map.getSource('sv')?.setData(EMPTY); };

function openStreetView(lngLat, label) {
  const [lng, lat] = lngLat;
  const ext = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  if (!googleKey()) {
    window.open(ext, '_blank', 'noopener');
    toast('Para ver o Street View dentro do mapa, cadastre a chave do Google em Camadas → Chaves de API.', 'warn', 7000);
    return;
  }
  // olha na direção em que a câmera do mapa está apontando
  svFrame.src = SOURCES.streetView(googleKey(), lat, lng, (map.getBearing() + 360) % 360);
  svTitle.textContent = label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  document.getElementById('sv-ext').href = ext;
  sv.hidden = false;
  map.getSource('sv')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }] });
}

function applyTerrain() {
  if (prefs.terrain) map.setTerrain({ source: 'dem', exaggeration: Number(prefs.exaggeration) || 1 });
  else map.setTerrain(null);
  if (map.getLayer('hillshade')) map.setLayoutProperty('hillshade', 'visibility', prefs.terrain ? 'visible' : 'none');
}

function applyBuildings() {
  for (const l of map.getStyle().layers) {
    if (l['source-layer'] === 'building') map.setLayoutProperty(l.id, 'visibility', prefs.buildings ? 'visible' : 'none');
  }
}

function applyLabels() {
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && !['point-labels', 'cable-labels'].includes(l.id)) map.setLayoutProperty(l.id, 'visibility', prefs.labels ? 'visible' : 'none');
  }
}

function visibleProject() {
  const p = store.project;
  const hk = new Set(prefs.hiddenKinds), hc = new Set(prefs.hiddenCables);
  return { ...p, elements: p.elements.filter((e) => !hk.has(e.kind)), cables: p.cables.filter((c) => !hc.has(c.props.tipo)) };
}

let refreshQueued = false;
function refreshMap() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if (!map.getSource('points')) return;
    const vp = visibleProject();
    map.getSource('points').setData(buildPoints(vp, state.sel));
    map.getSource('cables').setData(buildCableLines(vp, state.sel));
    map.getSource('net3d').setData(build3D(vp, state.sel, Number(prefs.scale3d) || 3, googleActive() ? Number(prefs.googleZ) || 0 : 0));
    map.getSource('refs').setData(buildRefs(store.project));
    refreshDraft();
    refreshHandles();
  });
}

function refreshDraft() {
  const f = [];
  const d = state.draft;
  if (d && d.coords.length) {
    const coords = state.hover ? [...d.coords, state.hover] : d.coords;
    if (coords.length >= 2) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    for (const c of d.coords) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} });
  }
  if (state.tool === 'measure' && state.measure.length) {
    const coords = state.hover ? [...state.measure, state.hover] : state.measure;
    if (coords.length >= 2) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    for (const c of state.measure) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} });
  }
  map.getSource('draft')?.setData({ type: 'FeatureCollection', features: f });
}

function refreshHandles() {
  let coords = [];
  if (state.overlayEdit) coords = store.project.overlays.find((o) => o.id === state.overlayEdit)?.coords || [];
  else if (state.sel?.type === 'cable' && state.tool === 'select') coords = store.cable(state.sel.id)?.coords || [];
  map.getSource('handles')?.setData(buildHandles(coords));
}

store.on((what) => {
  if (what === 'save-error') { toast('Não foi possível salvar no navegador (espaço cheio?). Exporte o projeto em JSON.', 'error', 8000); return; }
  if (state.sel && !(state.sel.type === 'el' ? store.el(state.sel.id) : store.cable(state.sel.id))) state.sel = null;
  refreshMap();
  if (what !== 'drag') {
    renderProps();
    if (['list', 'bom', 'layers', 'project'].includes(state.tab)) renderTab();
  }
  updateStatus();
});

/* ------------------------------------------------------------- interação ------------------------------------------------------------- */

const PICK_LAYERS = ['points', 'net3d', 'cable-line', 'cable-ug', 'cable-casing'];

function pickAt(point, tol = 6) {
  const layers = PICK_LAYERS.filter((l) => map.getLayer(l));
  const feats = map.queryRenderedFeatures([[point.x - tol, point.y - tol], [point.x + tol, point.y + tol]], { layers });
  if (!feats.length) return null;
  // prioridade: elementos pontuais antes de cabos
  const el = feats.find((f) => f.properties.rtype === 'el');
  const f = el || feats[0];
  return { type: f.properties.rtype, id: f.properties.ref };
}

function snapAt(point, radius = 16, exclude = null) {
  let best = null, bestD = radius;
  for (const e of visibleProject().elements) {
    if (e.id === exclude || e.kind === 'marcador') continue;
    const p = map.project([e.lng, e.lat]);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestD || (best && d <= bestD + 2 && rank(e.kind) < rank(best.kind))) { best = e; bestD = Math.min(d, bestD); }
  }
  return best;
}
const rank = (k) => ({ pop: 0, ceo: 1, cto: 2, cliente: 3, reserva: 4, poste: 5 }[k] ?? 9);

function nextName(kind) {
  const short = KINDS[kind]?.short || 'Cabo';
  const list = kind === 'cabo' ? store.project.cables : store.project.elements.filter((e) => e.kind === kind);
  let n = list.length + 1;
  const names = new Set(list.map((x) => x.name));
  while (names.has(`${short}-${String(n).padStart(2, '0')}`)) n++;
  return `${short}-${String(n).padStart(2, '0')}`;
}

function makeElement(kind, lngLat, extra = {}) {
  const e = { id: uid('e'), kind, name: nextName(kind), lng: lngLat[0], lat: lngLat[1], props: defaultProps(kind), ...extra };
  store.project.elements.push(e);
  return e;
}

function setTool(tool) {
  if (state.draft && state.draft.coords.length >= 2 && !tool.startsWith('cable') && tool !== 'drop') finishCable();
  state.tool = tool;
  state.draft = (tool === 'cable' || tool === 'drop') ? { coords: [], nodes: [] } : null;
  state.measure = [];
  state.overlayEdit = null;
  map.doubleClickZoom[(tool === 'select') ? 'enable' : 'disable']();
  map.getCanvas().style.cursor = tool === 'select' ? '' : 'crosshair';
  renderBanner();
  refreshMap();
  if (state.tab === 'tools') renderTab();
}

function select_(sel) {
  state.sel = sel;
  refreshMap();
  renderProps();
}

map.on('click', (ev) => {
  if (state.drag?.moved) return;
  const p = ev.point;
  const ll = [ev.lngLat.lng, ev.lngLat.lat];
  const t = state.tool;

  if (t === 'select') {
    const hit = pickAt(p);
    if (hit && ev.originalEvent.shiftKey && hit.type === 'cable' && state.sel?.id === hit.id) { insertVertex(hit.id, ll, p); return; }
    select_(hit);
    return;
  }
  if (t.startsWith('add:')) {
    const kind = t.slice(4);
    store.checkpoint();
    let pos = ll;
    const extra = {};
    if (['cto', 'ceo', 'reserva'].includes(kind)) {
      const pole = snapAt(p, 16);
      if (pole?.kind === 'poste') { pos = [pole.lng, pole.lat]; extra.poste = pole.id; }
    }
    const e = makeElement(kind, pos);
    // caixa colocada em cima de um poste: os cabos que passam pelo poste passam a passar pela caixa
    if (extra.poste) for (const c of store.project.cables) c.nodes = c.nodes.map((n) => (n === extra.poste ? e.id : n));
    store.changed();
    select_({ type: 'el', id: e.id });
    return;
  }
  if (t === 'cable' || t === 'drop') { addDraftPoint(p, ll); return; }
  if (t === 'measure') { state.measure.push(ll); renderBanner(); refreshDraft(); }
  if (t === 'streetview') { const hit = pickAt(p); const e = hit?.type === 'el' ? store.el(hit.id) : null; openStreetView(e ? [e.lng, e.lat] : ll, e?.name); }
});

map.on('dblclick', (ev) => {
  if (state.tool === 'cable' || state.tool === 'drop') { ev.preventDefault(); finishCable(); }
  if (state.tool === 'measure') { ev.preventDefault(); }
});

map.on('contextmenu', (ev) => {
  if (state.draft) { ev.preventDefault(); undoDraftPoint(); }
});

function addDraftPoint(point, ll) {
  const d = state.draft;
  const snap = snapAt(point, 16);
  const pos = snap ? [snap.lng, snap.lat] : ll;
  const last = d.coords[d.coords.length - 1];
  if (last && dist(last, pos) < 0.5) return; // clique duplo / repetido
  d.coords.push(pos);
  d.nodes.push(snap ? snap.id : null);
  renderBanner();
  refreshDraft();
}

function undoDraftPoint() {
  if (!state.draft?.coords.length) return;
  state.draft.coords.pop();
  state.draft.nodes.pop();
  renderBanner();
  refreshDraft();
}

function finishCable() {
  const d = state.draft;
  if (!d || d.coords.length < 2) { toast('Um cabo precisa de pelo menos 2 pontos.', 'warn'); return; }
  const isDrop = state.tool === 'drop';
  store.checkpoint();
  const tipo = isDrop ? 'drop' : prefs.cableTipo;
  const props = { ...defaultCableProps(tipo), fibras: isDrop ? 1 : Number(prefs.cableFibras), lancamento: isDrop ? 'aereo' : prefs.cableLanc };
  const nodes = [...d.nodes];
  d.coords.forEach((c, i) => {
    if (nodes[i]) return;
    if (isDrop && i === d.coords.length - 1) nodes[i] = makeElement('cliente', c).id;
    else if (!isDrop && prefs.autoPoles && props.lancamento === 'aereo') nodes[i] = makeElement('poste', c, { props: { ...defaultProps('poste'), situacao: 'Existente' } }).id;
  });
  const cable = { id: uid('c'), name: nextName('cabo'), coords: d.coords.map((c) => [...c]), nodes, props };
  store.project.cables.push(cable);
  store.changed();
  state.draft = { coords: [], nodes: [] };
  select_({ type: 'cable', id: cable.id });
  toast(`${cable.name} criado · ${fmtM(lineLength(cable.coords))}`);
  renderBanner();
}

function insertVertex(cableId, ll, point) {
  const c = store.cable(cableId);
  let best = 0, bestD = Infinity;
  for (let i = 1; i < c.coords.length; i++) {
    const a = map.project(c.coords[i - 1]), b = map.project(c.coords[i]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(a.x + t * dx - point.x, a.y + t * dy - point.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  store.checkpoint();
  const snap = snapAt(point, 12);
  c.coords.splice(best, 0, snap ? [snap.lng, snap.lat] : ll);
  c.nodes.splice(best, 0, snap ? snap.id : null);
  store.changed();
}

// arrastar elementos selecionados, vértices de cabo e cantos da planta
map.on('mousedown', (ev) => {
  if (state.tool !== 'select' || ev.originalEvent.button !== 0) return;
  const tol = 7, p = ev.point;
  const box = [[p.x - tol, p.y - tol], [p.x + tol, p.y + tol]];
  const hf = map.queryRenderedFeatures(box, { layers: ['handles'] })[0];
  if (hf) {
    const i = hf.properties.i;
    if (ev.originalEvent.altKey && state.sel?.type === 'cable') {
      const c = store.cable(state.sel.id);
      if (c.coords.length > 2) { store.checkpoint(); c.coords.splice(i, 1); c.nodes.splice(i, 1); store.changed(); }
      ev.preventDefault();
      return;
    }
    state.drag = { kind: state.overlayEdit ? 'corner' : 'vertex', i, started: false, moved: false };
  } else if (state.sel?.type === 'el') {
    const f = map.queryRenderedFeatures(box, { layers: ['points', 'net3d'] }).find((x) => x.properties.ref === state.sel.id);
    if (f) state.drag = { kind: 'el', started: false, moved: false };
  }
  if (state.drag) { ev.preventDefault(); map.dragPan.disable(); }
});

map.on('mousemove', (ev) => {
  const ll = [ev.lngLat.lng, ev.lngLat.lat];
  state.cursor = ev.lngLat;
  if (state.drag) {
    if (!state.drag.started) { store.checkpoint(); state.drag.started = true; }
    state.drag.moved = true;
    const d = state.drag;
    if (d.kind === 'el') store.moveElement(state.sel.id, ll);
    else if (d.kind === 'vertex') { const c = store.cable(state.sel.id); c.coords[d.i] = ll; c.nodes[d.i] = null; }
    else if (d.kind === 'corner') { const o = store.project.overlays.find((x) => x.id === state.overlayEdit); o.coords[d.i] = ll; map.getSource(`ov-${o.id}`)?.setCoordinates(o.coords); }
    store.changed('drag');
    return;
  }
  if (state.draft || state.tool === 'measure') {
    const snap = state.draft ? snapAt(ev.point, 16) : null;
    state.hover = snap ? [snap.lng, snap.lat] : ll;
    map.getCanvas().style.cursor = snap ? 'copy' : 'crosshair';
    refreshDraft();
    if (state.tool === 'measure') renderBanner();
  } else if (state.tool === 'select') {
    const hit = map.queryRenderedFeatures([[ev.point.x - 5, ev.point.y - 5], [ev.point.x + 5, ev.point.y + 5]], { layers: ['handles', ...PICK_LAYERS].filter((l) => map.getLayer(l)) });
    map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
  }
  throttledStatus();
});

map.on('mouseup', (ev) => {
  const d = state.drag;
  if (!d) return;
  map.dragPan.enable();
  if (d.moved && d.kind === 'vertex') {
    const c = store.cable(state.sel.id);
    const snap = snapAt(ev.point, 14);
    if (snap) { c.coords[d.i] = [snap.lng, snap.lat]; c.nodes[d.i] = snap.id; }
  }
  if (d.moved) store.changed();
  setTimeout(() => { state.drag = null; }, 0);
});

map.on('moveend', () => {
  prefs.view = { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  savePrefs();
  updateStatus();
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); store.redo(); return; }
  if (typing || document.querySelector('.modal-back')) return;
  if (e.key === 'Escape') { if (state.draft?.coords.length) { state.draft = { coords: [], nodes: [] }; renderBanner(); refreshDraft(); } else setTool('select'); return; }
  if (e.key === 'Enter' && state.draft) { finishCable(); return; }
  if (e.key === 'Backspace' && state.draft) { e.preventDefault(); undoDraftPoint(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) { e.preventDefault(); deleteSelection(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if (k === 'V') setTool('select');
  else if (k === 'K') setTool('cable');
  else if (k === 'D') setTool('drop');
  else if (k === 'N') setTool('measure');
  else if (k === 'S') setTool('streetview');
  else {
    const kind = KIND_ORDER.find((x) => KINDS[x].key === k);
    if (kind) setTool(`add:${kind}`);
  }
});

function deleteSelection() {
  const s = state.sel;
  if (!s) return;
  store.checkpoint();
  if (s.type === 'el') {
    const e = store.el(s.id);
    // cabos cuja ponta era o cliente/poste continuam existindo; só perdem a ligação
    store.removeElement(s.id);
    toast(`${e?.name || 'Elemento'} excluído.`);
  } else {
    store.removeCable(s.id);
    toast('Cabo excluído.');
  }
  state.sel = null;
  store.changed();
}

/* --------------------------------------------------------------- status --------------------------------------------------------------- */

const statusEl = document.getElementById('status');
let stT = 0;
function throttledStatus() { const n = performance.now(); if (n - stT > 80) { stT = n; updateStatus(); } }
function updateStatus() {
  const c = state.cursor;
  const parts = [];
  if (c) {
    parts.push(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
    const z = prefs.terrain ? map.queryTerrainElevation?.(c) : null;
    if (z != null) parts.push(`alt. ${Math.round(z / (Number(prefs.exaggeration) || 1))} m`);
  }
  parts.push(`zoom ${map.getZoom().toFixed(1)}`);
  const p = store.project;
  const km = p.cables.reduce((t, x) => t + lineLength(x.coords), 0);
  parts.push(`${p.elements.length} elementos · ${p.cables.length} cabos · ${fmtM(km)}`);
  statusEl.replaceChildren(...parts.map((t) => h('span', null, t)));
}

/* --------------------------------------------------------------- banner -------------------------------------------------------------- */

const banner = document.getElementById('banner');
function renderBanner() {
  const t = state.tool;
  if (t === 'select') { banner.hidden = true; return; }
  banner.hidden = false;
  if (t.startsWith('add:')) {
    const k = t.slice(4);
    clear(banner, h('span', { class: 'swatch', style: { background: KINDS[k].color } }), h('b', null, `Adicionar ${KINDS[k].label}`),
      h('span', { class: 'muted' }, ['cto', 'ceo', 'reserva'].includes(k) ? 'clique no mapa — perto de um poste, encaixa nele' : 'clique no mapa'),
      h('button', { class: 'btn xs', onclick: () => setTool('select') }, 'Concluir (Esc)'));
    return;
  }
  if (t === 'streetview') {
    clear(banner, h('b', null, 'Street View'), h('span', { class: 'muted' }, 'clique em uma rua ou elemento para ver a foto real no painel'),
      h('button', { class: 'btn xs', onclick: () => setTool('select') }, 'Sair (Esc)'));
    return;
  }
  if (t === 'measure') {
    const coords = state.hover ? [...state.measure, state.hover] : state.measure;
    clear(banner, h('b', null, 'Medir'), h('span', null, fmtM(lineLength(coords))), h('span', { class: 'muted' }, 'clique para adicionar pontos'),
      h('button', { class: 'btn xs', onclick: () => { state.measure = []; renderBanner(); refreshDraft(); } }, 'Limpar'),
      h('button', { class: 'btn xs', onclick: () => setTool('select') }, 'Sair (Esc)'));
    return;
  }
  const d = state.draft;
  const len = d ? lineLength(d.coords) : 0;
  if (t === 'drop') {
    clear(banner, h('span', { class: 'swatch', style: { background: CABLE_TYPES.drop.color } }), h('b', null, 'Drop'),
      h('span', { class: 'muted' }, 'clique na CTO, nos postes e no cliente (cria o cliente se não existir) · duplo clique/Enter conclui'),
      h('span', null, `${d.coords.length} pts · ${fmtM(len)}`),
      h('button', { class: 'btn xs primary', onclick: finishCable }, 'Concluir'),
      h('button', { class: 'btn xs', onclick: () => setTool('select') }, 'Cancelar'));
    return;
  }
  clear(banner, h('span', { class: 'swatch', style: { background: CABLE_TYPES[prefs.cableTipo].color } }), h('b', null, 'Cabo'),
    select(Object.entries(CABLE_TYPES).filter(([k]) => k !== 'drop').map(([k, v]) => [k, v.label]), prefs.cableTipo, (v) => { prefs.cableTipo = v; savePrefs(); renderBanner(); }),
    select(FIBER_COUNTS.map((n) => [n, `${n} FO`]), prefs.cableFibras, (v) => { prefs.cableFibras = Number(v); savePrefs(); }),
    select([['aereo', 'Aéreo'], ['subterraneo', 'Subterrâneo']], prefs.cableLanc, (v) => { prefs.cableLanc = v; savePrefs(); }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.autoPoles, onchange: (e) => { prefs.autoPoles = e.target.checked; savePrefs(); } }), 'criar postes nos vértices'),
    h('span', null, `${d.coords.length} pts · ${fmtM(len)}`),
    h('button', { class: 'btn xs primary', onclick: finishCable }, 'Concluir (Enter)'),
    h('button', { class: 'btn xs', onclick: undoDraftPoint }, 'Desfazer ponto'),
    h('button', { class: 'btn xs', onclick: () => setTool('select') }, 'Sair'));
}

/* ------------------------------------------------------------ propriedades ----------------------------------------------------------- */

const right = document.getElementById('right');
const propsEl = document.getElementById('props');
const propsTitle = document.getElementById('props-title');
document.getElementById('props-close').onclick = () => select_(null);

function bindInput(obj, key, { type = 'text', num = false, after } = {}) {
  const inp = type === 'textarea' ? h('textarea', null) : h('input', { type });
  inp.value = obj[key] ?? '';
  inp.addEventListener('change', () => {
    store.checkpoint();
    obj[key] = num ? Number(inp.value) : inp.value;
    after?.();
    store.changed('props');
  });
  return inp;
}
function bindSelect(obj, key, options, { num = false, after } = {}) {
  return select(options, obj[key], (v) => { store.checkpoint(); obj[key] = num ? Number(v) : v; after?.(); store.changed('props'); });
}

function googleLinks(lat, lng) {
  return h('div', { class: 'row' },
    h('a', { class: 'btn xs', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` }, 'Google Maps'),
    h('a', { class: 'btn xs', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}` }, 'Street View'),
    h('a', { class: 'btn xs', target: '_blank', rel: 'noopener', href: `https://earth.google.com/web/@${lat},${lng},30a,300d,35y,0h,60t,0r` }, 'Google Earth'));
}

function renderProps() {
  const s = state.sel;
  if (!s) { right.hidden = true; return; }
  right.hidden = false;
  if (s.type === 'el') renderElementProps(store.el(s.id));
  else renderCableProps(store.cable(s.id));
  requestAnimationFrame(() => map.resize());
}

function renderElementProps(e) {
  if (!e) return;
  propsTitle.textContent = KINDS[e.kind]?.label || 'Elemento';
  const P = e.props;
  const cables = store.cablesAt(e.id);
  const parts = [
    field('Nome', bindInput(e, 'name')),
    field('Tipo', select(KIND_ORDER.map((k) => [k, KINDS[k].label]), e.kind, (v) => {
      store.checkpoint(); e.kind = v; e.props = { ...defaultProps(v), ...e.props }; store.changed();
    })),
  ];
  if (e.kind === 'pop') parts.push(h('div', { class: 'grid2' }, field('OLT', bindInput(P, 'olt')), field('PON / slot', bindInput(P, 'pon'))), field('Potência Tx (dBm)', bindInput(P, 'potenciaTx', { type: 'number', num: true })), field('Endereço', bindInput(P, 'endereco')));
  if (e.kind === 'cto') {
    const u = ctoUsage(store.project, e);
    parts.push(h('div', { class: 'grid2' }, field('Modelo', bindInput(P, 'modelo')), field('Portas', bindSelect(P, 'portas', [8, 16, 24, 32], { num: true }))),
      h('div', { class: 'stat' }, h('span', null, 'Ocupação (drops)'), h('b', null, `${u.usadas} / ${u.total}`)), field('Endereço', bindInput(P, 'endereco')));
  }
  if (e.kind === 'ceo') parts.push(h('div', { class: 'grid2' }, field('Modelo', bindInput(P, 'modelo')), field('Capacidade (fusões)', bindSelect(P, 'capacidade', [12, 24, 48, 72, 96, 144, 288], { num: true }))), field('Bandejas', bindInput(P, 'bandejas', { type: 'number', num: true })));
  if (e.kind === 'poste') parts.push(h('div', { class: 'grid2' }, field('Nº / plaqueta', bindInput(P, 'numero')), field('Altura (m)', bindInput(P, 'altura', { type: 'number', num: true }))),
    h('div', { class: 'grid2' }, field('Material', bindSelect(P, 'material', ['Concreto', 'Madeira', 'Metálico', 'Fibra'])), field('Situação', bindSelect(P, 'situacao', ['Existente', 'Novo', 'A substituir']))),
    field('Proprietário', bindInput(P, 'proprietario')));
  if (e.kind === 'reserva') parts.push(field('Metros de reserva', bindInput(P, 'metros', { type: 'number', num: true })));
  if (e.kind === 'cliente') parts.push(h('div', { class: 'grid2' }, field('Contrato / login', bindInput(P, 'contrato')), field('Porta CTO', bindInput(P, 'porta'))), field('Endereço', bindInput(P, 'endereco')));

  if (e.kind === 'ceo' || e.kind === 'cto') {
    P.splitters ||= [];
    parts.push(h('h4', null, 'Splitters'),
      ...P.splitters.map((sp, i) => h('div', { class: 'row' }, h('span', null, `#${i + 1}`), bindSelect(sp, 'tipo', SPLITTERS),
        h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); P.splitters.splice(i, 1); store.changed('props'); } }, 'remover'))),
      h('div', { class: 'row' }, h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); P.splitters.push({ id: uid('s'), tipo: e.kind === 'cto' ? '1x8' : '1x4' }); store.changed('props'); } }, '+ splitter'),
        h('button', { class: 'btn primary', onclick: () => openSplice(e.id, () => renderProps()) }, `Diagrama de fusões (${(P.fusoes || []).length})`)));
  }
  if (e.kind === 'ceo' || e.kind === 'cto' || e.kind === 'cliente') {
    const b = powerBudget(store.project, e);
    parts.push(h('h4', null, 'Orçamento óptico (estimativa)'));
    if (!b) parts.push(h('p', { class: 'muted' }, 'Sem caminho de cabos até um POP. Ligue a caixa à rede para calcular.'));
    else parts.push(h('table', { class: 'budget' }, h('tbody', null,
      h('tr', null, h('td', null, `Tx ${b.pop.name}`), h('td', null, `${b.tx.toFixed(1)} dBm`)),
      h('tr', null, h('td', null, `Fibra ${fmtM(b.distance)} × ${LOSS.fibraDbKm} dB/km`), h('td', null, `−${b.fibra.toFixed(2)} dB`)),
      h('tr', null, h('td', null, `Fusões (${b.boxes + 1} caixas)`), h('td', null, `−${b.fusoes.toFixed(2)} dB`)),
      h('tr', null, h('td', null, 'Conectores'), h('td', null, `−${b.conectores.toFixed(2)} dB`)),
      h('tr', null, h('td', null, `Splitters ${b.splitterList.join(', ') || '—'}`), h('td', null, `−${b.splitter.toFixed(2)} dB`)),
      h('tr', null, h('td', null, h('b', null, 'Sinal estimado')), h('td', null, h('span', { class: `badge ${b.ok ? 'ok' : 'bad'}` }, `${b.rx.toFixed(2)} dBm`))))));
  }
  if (cables.length) {
    parts.push(h('h4', null, `Cabos conectados (${cables.length})`),
      ...cables.map((c) => h('button', { class: 'list-item', onclick: () => select_({ type: 'cable', id: c.id }) }, h('span', { class: 'swatch', style: { background: CABLE_TYPES[c.props.tipo]?.color } }), c.name, h('small', null, `${c.props.fibras} FO`))));
  }
  parts.push(h('h4', null, 'Observações'), bindInput(P, 'obs', { type: 'textarea' }));
  if (P.kml && Object.keys(P.kml).length) parts.push(h('details', null, h('summary', { class: 'muted' }, 'Dados do KML de origem'), h('table', null, h('tbody', null, Object.entries(P.kml).map(([k, v2]) => h('tr', null, h('td', null, k), h('td', null, String(v2))))))));
  parts.push(h('h4', null, 'Localização'), h('p', { class: 'muted' }, `${e.lat.toFixed(6)}, ${e.lng.toFixed(6)}`),
    h('button', { class: 'btn primary', style: { marginBottom: '6px' }, onclick: () => openStreetView([e.lng, e.lat], e.name) }, 'Street View neste ponto'), googleLinks(e.lat, e.lng),
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn', onclick: () => map.flyTo({ center: [e.lng, e.lat], zoom: 19, pitch: 65 }) }, 'Centralizar'),
      h('button', { class: 'btn danger', onclick: deleteSelection }, 'Excluir')));
  clear(propsEl, parts);
}

function renderCableProps(c) {
  if (!c) return;
  propsTitle.textContent = 'Cabo óptico';
  const P = c.props;
  const L = cableLength(store.project, c);
  const names = c.nodes.map((n) => n && store.el(n)).filter((e) => e && e.kind !== 'poste');
  const first = c.nodes[0] && store.el(c.nodes[0]), last = c.nodes[c.nodes.length - 1] && store.el(c.nodes[c.nodes.length - 1]);
  const poles = c.nodes.filter((n) => n && store.el(n)?.kind === 'poste').length;
  clear(propsEl,
    field('Nome', bindInput(c, 'name')),
    h('div', { class: 'grid2' },
      field('Tipo', bindSelect(P, 'tipo', Object.entries(CABLE_TYPES).map(([k, v2]) => [k, v2.label]), { after: () => { P.altura = CABLE_TYPES[P.tipo].altura; } })),
      field('Fibras', bindSelect(P, 'fibras', FIBER_COUNTS.map((n) => [n, `${n} FO`]), { num: true }))),
    h('div', { class: 'grid2' },
      field('Lançamento', bindSelect(P, 'lancamento', [['aereo', 'Aéreo'], ['subterraneo', 'Subterrâneo']])),
      field('Altura no poste (m)', bindInput(P, 'altura', { type: 'number', num: true }))),
    h('div', { class: 'grid2' },
      field('Modelo', bindInput(P, 'modelo'), 'ex.: AS-80, AS-120, Fig. 8'),
      field('Reserva extra (m)', bindInput(P, 'reserva', { type: 'number', num: true }))),
    field('Cor no mapa', h('div', { class: 'row' }, bindInput(P, 'cor', { type: 'color' }), h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); P.cor = ''; store.changed('props'); } }, 'padrão do tipo'))),
    h('h4', null, 'Metragem'),
    h('div', { class: 'stat' }, h('span', null, 'Traçado'), h('b', null, fmtM(L.tracado))),
    h('div', { class: 'stat' }, h('span', null, 'Reservas técnicas'), h('b', null, fmtM(L.reservas))),
    h('div', { class: 'stat' }, h('span', null, 'Catenária (3%)'), h('b', null, fmtM(L.folga))),
    h('div', { class: 'stat' }, h('span', null, 'Total para lançamento'), h('b', null, fmtM(L.total))),
    h('div', { class: 'stat' }, h('span', null, 'Postes no trajeto'), h('b', null, poles)),
    h('h4', null, 'Trajeto'),
    h('p', null, `${first?.name || 'ponta livre'} → ${last?.name || 'ponta livre'}`),
    ...names.map((e) => h('button', { class: 'list-item', onclick: () => select_({ type: 'el', id: e.id }) }, h('span', { class: 'swatch', style: { background: KINDS[e.kind].color } }), e.name, h('small', null, KINDS[e.kind].short))),
    h('p', { class: 'hint' }, 'Arraste os pontos brancos para mudar o traçado (soltando sobre um poste/caixa, o cabo se liga a ele). ', h('b', null, 'Shift+clique'), ' no cabo insere um ponto; ', h('b', null, 'Alt+clique'), ' em um ponto o remove.'),
    h('h4', null, 'Observações'), bindInput(P, 'obs', { type: 'textarea' }),
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn', onclick: () => { store.checkpoint(); c.coords.reverse(); c.nodes.reverse(); store.changed(); } }, 'Inverter sentido'),
      h('button', { class: 'btn', onclick: () => fit(c.coords) }, 'Enquadrar'),
      h('button', { class: 'btn danger', onclick: deleteSelection }, 'Excluir')));
}

function fit(coords) {
  const b = bboxOf(coords);
  if (b) map.fitBounds(b, { padding: 80, maxZoom: 19, pitch: map.getPitch() });
}

/* --------------------------------------------------------------- abas ---------------------------------------------------------------- */

const tabBody = document.getElementById('tab-body');
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
  renderTab();
});

function renderTab() {
  const t = state.tab;
  if (t === 'tools') clear(tabBody, toolsTab());
  else if (t === 'layers') clear(tabBody, layersTab());
  else if (t === 'project') clear(tabBody, projectTab());
  else if (t === 'list') clear(tabBody, listTab());
  else if (t === 'bom') clear(tabBody, bomTab());
}

function toolBtn(tool, label, color, key) {
  return h('button', { class: `btn${state.tool === tool ? ' active' : ''}`, onclick: () => setTool(tool) },
    color ? h('span', { class: 'swatch', style: { background: color } }) : null, label, key ? h('kbd', null, key) : null);
}

function toolsTab() {
  return [
    h('h4', null, 'Edição'),
    h('div', { class: 'tool-grid' },
      toolBtn('select', 'Selecionar / mover', null, 'V'),
      toolBtn('measure', 'Medir distância', null, 'N'),
      toolBtn('streetview', 'Street View', '#facc15', 'S')),
    h('h4', null, 'Cabos'),
    h('div', { class: 'tool-grid' },
      toolBtn('cable', 'Lançar cabo', CABLE_TYPES[prefs.cableTipo].color, 'K'),
      toolBtn('drop', 'Drop p/ cliente', CABLE_TYPES.drop.color, 'D')),
    h('h4', null, 'Elementos'),
    h('div', { class: 'tool-grid' }, KIND_ORDER.map((k) => toolBtn(`add:${k}`, KINDS[k].short === 'Marcador' ? 'Marcador' : KINDS[k].label.split(' · ')[0], KINDS[k].color, KINDS[k].key))),
    h('h4', null, 'Como projetar'),
    h('div', { class: 'hint' },
      h('p', null, '1. ', h('b', null, 'POP/OLT'), ': posicione o ponto de presença.'),
      h('p', null, '2. ', h('b', null, 'Lançar cabo'), ': clique de poste em poste (encaixa em postes/caixas próximos; sem poste, cria um). Duplo clique ou Enter conclui, botão direito desfaz o último ponto.'),
      h('p', null, '3. ', h('b', null, 'CEO/CTO'), ': clique sobre um poste para instalar a caixa nele — os cabos do poste passam a chegar na caixa.'),
      h('p', null, '4. Abra a caixa e use o ', h('b', null, 'Diagrama de fusões'), ' para ligar fibras e splitters.'),
      h('p', null, '5. ', h('b', null, 'Drop'), ': da CTO até a casa do cliente. A ocupação da CTO e o sinal estimado aparecem no painel.'),
      h('p', null, h('b', null, 'Ctrl+Z / Ctrl+Y'), ' desfaz/refaz · ', h('b', null, 'Del'), ' exclui · ', h('b', null, 'Esc'), ' sai da ferramenta · arraste com botão direito para girar e inclinar o 3D.')),
  ];
}

function check(label, value, onchange, color) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value, onchange: (e) => onchange(e.target.checked) }), color ? h('span', { class: 'swatch', style: { background: color } }) : null, label);
}

function layersTab() {
  const p = store.project;
  const toggleIn = (arr, key, on) => { const s = new Set(prefs[arr]); on ? s.delete(key) : s.add(key); prefs[arr] = [...s]; savePrefs(); refreshMap(); };
  const exag = h('input', { type: 'range', min: 1, max: 3, step: 0.1, value: prefs.exaggeration, oninput: (e) => { prefs.exaggeration = Number(e.target.value); savePrefs(); applyTerrain(); } });
  const scale = h('input', { type: 'range', min: 1, max: 8, step: 0.5, value: prefs.scale3d, oninput: (e) => { prefs.scale3d = Number(e.target.value); savePrefs(); refreshMap(); } });
  const keyInp = h('input', { type: 'password', placeholder: siteConfig.googleMapsKey ? 'definida no servidor (config.json)' : 'AIza…', value: prefs.googleKey, autocomplete: 'off' });
  const mlyInp = h('input', { type: 'password', placeholder: siteConfig.mapillaryToken ? 'definido no servidor (config.json)' : 'MLY|…', value: prefs.mapillaryToken, autocomplete: 'off' });
  const zRange = h('input', { type: 'range', min: -30, max: 30, step: 0.5, value: prefs.googleZ, oninput: (e) => { prefs.googleZ = Number(e.target.value); zLabel.textContent = `${prefs.googleZ} m`; savePrefs(); refreshMap(); } });
  const zLabel = h('b', null, `${prefs.googleZ} m`);
  return [
    h('h4', null, 'Modo realista (Google)'),
    check('Prédios, postes e árvores reais em 3D (Google Photorealistic 3D)', prefs.google3d, (v2) => {
      if (v2 && !googleKey()) { toast('Cadastre a chave do Google em "Chaves de API" abaixo.', 'warn'); renderTab(); return; }
      prefs.google3d = v2; savePrefs(); applyGoogleMode(); renderTab();
    }),
    prefs.google3d ? field('Altura da rede sobre o modelo do Google', h('div', { class: 'row' }, zRange, zLabel), 'Se os cabos ficarem enterrados ou flutuando, ajuste aqui (o modelo do Google tem relevo próprio).') : null,
    h('p', { class: 'muted' }, 'No modo realista o mapa OSM, o satélite e o relevo ficam ocultos (o Google não permite misturar). Use a tecla S para abrir o Street View em qualquer ponto.'),
    h('h4', null, 'Mapa base'),
    check('Imagem de satélite', prefs.satellite, (v2) => { prefs.satellite = v2; savePrefs(); map.setLayoutProperty('sat', 'visibility', v2 ? 'visible' : 'none'); }),
    check('Prédios 3D (OpenStreetMap)', prefs.buildings, (v2) => { prefs.buildings = v2; savePrefs(); applyBuildings(); }),
    check('Relevo 3D (Serra do Mar)', prefs.terrain, (v2) => { prefs.terrain = v2; savePrefs(); applyTerrain(); }),
    field('Exagero do relevo', exag),
    check('Rótulos de ruas e bairros', prefs.labels, (v2) => { prefs.labels = v2; savePrefs(); applyLabels(); }),
    check('Limite municipal (IBGE)', prefs.boundary, (v2) => { prefs.boundary = v2; savePrefs(); map.setLayoutProperty('boundary-line', 'visibility', v2 ? 'visible' : 'none'); }),
    field('Espessura dos objetos 3D', scale, 'Aumenta postes, caixas e cabos para ficarem visíveis de longe.'),
    h('h4', null, 'Rede'),
    ...KIND_ORDER.map((k) => check(`${KINDS[k].label} (${p.elements.filter((e) => e.kind === k).length})`, !prefs.hiddenKinds.includes(k), (on) => toggleIn('hiddenKinds', k, on), KINDS[k].color)),
    ...Object.entries(CABLE_TYPES).map(([k, d]) => check(`Cabos · ${d.label} (${p.cables.filter((c) => c.props.tipo === k).length})`, !prefs.hiddenCables.includes(k), (on) => toggleIn('hiddenCables', k, on), d.color)),
    h('h4', null, 'Dados da cidade (OpenStreetMap)'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: loadOsmPoles }, 'Postes do OSM na área visível'),
      h('button', { class: 'btn', onclick: loadMapillaryPoles }, 'Postes reais (Mapillary)'),
      h('button', { class: 'btn', onclick: loadBairros }, 'Bairros de Cubatão')),
    h('div', { id: 'bairros' }),
    h('h4', null, `Camadas de referência (${p.refs.length})`),
    ...p.refs.map((r) => h('div', { class: 'row' },
      check(`${r.name} (${r.geojson.features.length})`, r.visible, (on) => { store.checkpoint(); r.visible = on; store.changed(); }, r.color),
      h('button', { class: 'btn xs', onclick: () => fit(r.geojson.features.flatMap(coordsOf)) }, 'ver'),
      h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); p.refs = p.refs.filter((x) => x !== r); store.changed(); } }, '✕'))),
    h('h4', null, `Plantas / imagens sobrepostas (${p.overlays.length})`),
    ...p.overlays.map(overlayRow),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: importReference }, '+ Referência KML/KMZ/GeoJSON'),
      h('button', { class: 'btn', onclick: addOverlay }, '+ Imagem de planta')),
    h('h4', null, 'Chaves de API'),
    field('Google Maps Platform', keyInp, 'Ative "Map Tiles API" (3D) e "Maps Embed API" (Street View) e restrinja a chave ao domínio mapa.noc.updown.com.br.'),
    field('Mapillary (token de cliente)', mlyInp, 'Gratuito em mapillary.com/dashboard/developers — usado para postes detectados nas fotos de rua.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => {
      prefs.googleKey = keyInp.value.trim(); prefs.mapillaryToken = mlyInp.value.trim(); savePrefs();
      if (googleActive()) { disableGoogle3D(map); prefs.google3d = !!googleKey(); applyGoogleMode(); }
      toast('Chaves salvas neste navegador.');
      renderTab();
    } }, 'Salvar chaves')),
  ];
}

function coordsOf(f) {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'LineString' || g.type === 'MultiPoint') return g.coordinates;
  if (g.type === 'Polygon' || g.type === 'MultiLineString') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.flat(2);
  return [];
}

/* --------------------------------------------------------- plantas sobrepostas --------------------------------------------------------- */

function addOverlayLayer(o) {
  if (map.getSource(`ov-${o.id}`)) return;
  map.addSource(`ov-${o.id}`, { type: 'image', url: o.url, coordinates: o.coords });
  map.addLayer({ id: `ov-${o.id}`, type: 'raster', source: `ov-${o.id}`, paint: { 'raster-opacity': o.opacity ?? 0.6 }, layout: { visibility: o.visible === false ? 'none' : 'visible' } }, 'refs-fill');
}

function removeOverlayLayer(o) {
  if (map.getLayer(`ov-${o.id}`)) map.removeLayer(`ov-${o.id}`);
  if (map.getSource(`ov-${o.id}`)) map.removeSource(`ov-${o.id}`);
}

function viewCorners(shrink = 0.2) {
  const c = map.getCanvas();
  const W = c.clientWidth, H = c.clientHeight;
  const x0 = W * shrink, x1 = W * (1 - shrink), y0 = H * shrink, y1 = H * (1 - shrink);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => map.unproject(q).toArray());
}

async function addOverlay() {
  const file = await pickFile('image/png,image/jpeg,image/webp');
  if (!file) return;
  const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  map.easeTo({ pitch: 0, bearing: 0 });
  map.once('moveend', () => {
    store.checkpoint();
    const o = { id: uid('o'), name: file.name, url, coords: viewCorners(), opacity: 0.6, visible: true };
    store.project.overlays.push(o);
    addOverlayLayer(o);
    store.changed();
    state.overlayEdit = o.id;
    refreshHandles();
    toast('Arraste os 4 cantos brancos para alinhar a planta às ruas. Clique em "ok" quando terminar.', 'info', 7000);
    renderTab();
  });
}

function overlayRow(o) {
  const editing = state.overlayEdit === o.id;
  return h('div', { class: 'hint', style: { marginBottom: '6px' } },
    h('div', { class: 'row' }, check(o.name, o.visible !== false, (on) => { o.visible = on; map.setLayoutProperty(`ov-${o.id}`, 'visibility', on ? 'visible' : 'none'); store.changed(); })),
    field('Opacidade', h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: o.opacity ?? 0.6, oninput: (e) => { o.opacity = Number(e.target.value); map.setPaintProperty(`ov-${o.id}`, 'raster-opacity', o.opacity); }, onchange: () => store.changed() })),
    h('div', { class: 'row' },
      h('button', { class: `btn xs${editing ? ' active' : ''}`, onclick: () => { if (state.tool !== 'select') setTool('select'); state.overlayEdit = editing ? null : o.id; select_(null); refreshHandles(); renderTab(); } }, editing ? 'ok' : 'ajustar cantos'),
      h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); o.coords = viewCorners(); map.getSource(`ov-${o.id}`).setCoordinates(o.coords); store.changed(); } }, 'trazer para a tela'),
      h('button', { class: 'btn xs', onclick: () => { store.checkpoint(); removeOverlayLayer(o); store.project.overlays = store.project.overlays.filter((x) => x !== o); state.overlayEdit = null; store.changed(); } }, 'remover')));
}

/* -------------------------------------------------------------- OSM ------------------------------------------------------------------ */

async function overpass(q) {
  const r = await fetch(SOURCES.overpass, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return r.json();
}

async function loadOsmPoles() {
  if (map.getZoom() < 15) { toast('Aproxime o mapa (zoom 15+) para importar os postes de uma área.', 'warn'); return; }
  const b = map.getBounds();
  toast('Buscando postes no OpenStreetMap…');
  try {
    const j = await overpass(`[out:json][timeout:25];(node["power"="pole"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()});node["man_made"="utility_pole"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}););out;`);
    const existing = store.project.elements.filter((e) => e.kind === 'poste');
    store.checkpoint();
    let n = 0;
    for (const el of j.elements || []) {
      const pos = [el.lon, el.lat];
      if (existing.some((e) => dist([e.lng, e.lat], pos) < 1.5)) continue;
      const e = makeElement('poste', pos);
      e.props.numero = el.tags?.ref || '';
      e.props.proprietario = el.tags?.operator || e.props.proprietario;
      e.props.osm = el.id;
      n++;
    }
    store.changed();
    toast(n ? `${n} postes importados do OpenStreetMap.` : 'Nenhum poste novo mapeado no OSM nesta área — desenhe-os com a ferramenta Poste.', n ? 'info' : 'warn', 6000);
  } catch (err) {
    toast(`Falha ao consultar o OpenStreetMap: ${err.message}`, 'error');
  }
}

// postes reconhecidos automaticamente nas fotos de rua do Mapillary
async function loadMapillaryPoles() {
  const tok = mapillaryToken();
  if (!tok) { toast('Cadastre o token do Mapillary em Camadas → Chaves de API.', 'warn'); return; }
  if (map.getZoom() < 15.5) { toast('Aproxime o mapa (zoom 15,5+) para buscar os postes de uma área.', 'warn'); return; }
  const b = map.getBounds();
  toast('Buscando postes detectados pelo Mapillary…');
  try {
    const url = `${SOURCES.mapillary}?access_token=${encodeURIComponent(tok)}&fields=id,object_value,geometry,last_seen_at&object_values=object--support--utility-pole,object--support--pole&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(6)).join(',')}&limit=2000`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const existing = store.project.elements.filter((e) => e.kind === 'poste');
    store.checkpoint();
    let n = 0;
    for (const f of j.data || []) {
      const pos = f.geometry?.coordinates;
      if (!pos || existing.some((e) => dist([e.lng, e.lat], pos) < 3)) continue;
      const e = makeElement('poste', pos);
      e.props.mapillary = f.id;
      e.props.obs = `Detectado pelo Mapillary${f.last_seen_at ? ` (visto em ${new Date(f.last_seen_at).toLocaleDateString('pt-BR')})` : ''}`;
      existing.push(e);
      n++;
    }
    store.changed();
    toast(n ? `${n} postes reais importados do Mapillary.` : 'Nenhum poste novo detectado nesta área (o Mapillary pode não ter fotos aqui).', n ? 'info' : 'warn', 7000);
  } catch (err) {
    toast(`Falha ao consultar o Mapillary: ${err.message}`, 'error', 7000);
  }
}

async function loadBairros() {
  const box = document.getElementById('bairros');
  clear(box, h('p', { class: 'muted' }, 'Carregando…'));
  try {
    const j = await overpass(`[out:json][timeout:25];area["name"="${CITY.name}"]["admin_level"="8"]->.a;(node["place"~"suburb|neighbourhood|quarter|village|hamlet"](area.a);way["place"~"suburb|neighbourhood|quarter"](area.a);relation["place"~"suburb|neighbourhood"](area.a););out center;`);
    const items = (j.elements || []).map((e) => ({ name: e.tags?.name, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon })).filter((x) => x.name && x.lat)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const seen = new Set();
    clear(box, items.filter((x) => !seen.has(x.name) && seen.add(x.name)).map((x) =>
      h('button', { class: 'list-item', onclick: () => map.flyTo({ center: [x.lng, x.lat], zoom: 16.5, pitch: 60 }) }, '📍 ', x.name)));
    if (!items.length) clear(box, h('p', { class: 'muted' }, 'Nenhum bairro retornado.'));
  } catch (err) {
    clear(box, h('p', { class: 'muted' }, `Falha: ${err.message}`));
  }
}

/* ------------------------------------------------------------- projeto --------------------------------------------------------------- */

function projectTab() {
  const p = store.project;
  return [
    field('Nome do projeto', bindInput(p, 'name')),
    h('h4', null, 'IXC Fiber Docs'),
    h('div', { class: 'hint' },
      h('p', null, h('b', null, 'Trazer do IXC: '), 'no IXC abra ', h('b', null, 'Fiber Docs'), ', escolha o projeto e use a opção de exportar em KML/KMZ. Depois clique em “Importar KML/KMZ” abaixo.'),
      h('p', null, 'Os elementos são reconhecidos pelo nome e pela pasta (CTO, CEO, POP/OLT, poste, reserva, cliente, drop, backbone, “12FO”…). Vértices de cabo a até 3 m de um elemento são ligados a ele.'),
      h('p', null, h('b', null, 'Levar para o IXC: '), 'exporte em KMZ e importe no Fiber Docs (ou abra no Google Earth).')),
    h('div', { class: 'tool-grid', style: { marginTop: '8px' } },
      h('button', { class: 'btn primary', onclick: () => importKml(false) }, 'Importar KML/KMZ'),
      h('button', { class: 'btn', onclick: () => importKml(true) }, 'Importar e substituir'),
      h('button', { class: 'btn', onclick: () => exportKml('kmz') }, 'Exportar KMZ'),
      h('button', { class: 'btn', onclick: () => exportKml('kml') }, 'Exportar KML'),
      h('button', { class: 'btn', onclick: () => download(`${slug(p.name)}.geojson`, JSON.stringify(toGeoJSON(p)), 'application/geo+json') }, 'Exportar GeoJSON'),
      h('button', { class: 'btn', onclick: importReference }, 'KML como referência')),
    h('h4', null, 'Arquivo do projeto'),
    h('div', { class: 'tool-grid' },
      h('button', { class: 'btn', onclick: () => download(`${slug(p.name)}.fiber3d.json`, JSON.stringify(p, null, 1), 'application/json') }, 'Salvar (.json)'),
      h('button', { class: 'btn', onclick: openProjectFile }, 'Abrir (.json)'),
      h('button', { class: 'btn danger', onclick: newProject }, 'Novo projeto')),
    h('p', { class: 'muted' }, 'O projeto é salvo automaticamente neste navegador. Para compartilhar ou guardar cópia, use “Salvar (.json)” ou exporte em KMZ.'),
    h('h4', null, 'Resumo'),
    ...KIND_ORDER.map((k) => h('div', { class: 'stat' }, h('span', null, KINDS[k].label), h('b', null, p.elements.filter((e) => e.kind === k).length))),
    ...Object.entries(CABLE_TYPES).map(([k, d]) => {
      const cs = p.cables.filter((c) => c.props.tipo === k);
      return h('div', { class: 'stat' }, h('span', null, `Cabos · ${d.label}`), h('b', null, `${cs.length} · ${fmtM(cs.reduce((t, c) => t + cableLength(p, c).total, 0))}`));
    }),
  ];
}

const slug = (s) => (s || 'projeto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

async function importKml(replace) {
  const file = await pickFile('.kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz');
  if (!file) return;
  try {
    const text = await readKmlFile(file);
    const r = parseKml(text);
    if (!r.elements.length && !r.cables.length && !r.refFeatures.length) { toast('Nenhum elemento encontrado no arquivo.', 'warn'); return; }
    store.checkpoint();
    const p = replace ? { ...emptyProject(file.name.replace(/\.(kmz|kml)$/i, '')), refs: [], overlays: store.project.overlays } : store.project;
    if (replace) for (const o of store.project.overlays) { /* mantém plantas */ void o; }
    p.elements.push(...r.elements);
    // liga também aos elementos já existentes no projeto
    snapCables(r.cables, p.elements, 3);
    p.cables.push(...r.cables);
    if (r.refFeatures.length) p.refs.push({ id: uid('r'), name: `${file.name} · áreas`, color: '#a78bfa', visible: true, geojson: { type: 'FeatureCollection', features: r.refFeatures } });
    if (replace) store.project = p;
    store.changed();
    const all = [...r.elements.map((e) => [e.lng, e.lat]), ...r.cables.flatMap((c) => c.coords), ...r.refFeatures.flatMap(coordsOf)];
    fit(all);
    const linked = r.cables.reduce((t, c) => t + c.nodes.filter(Boolean).length, 0);
    const byKind = KIND_ORDER.map((k) => [k, r.elements.filter((e) => e.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${KINDS[k].short}`).join(', ');
    toast(`Importado: ${byKind || '0 pontos'} · ${r.cables.length} cabos (${linked} ligações)${r.refFeatures.length ? ` · ${r.refFeatures.length} áreas` : ''}.`, 'info', 8000);
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`, 'error', 7000);
  }
}

async function importReference() {
  const file = await pickFile('.kml,.kmz,.geojson,.json');
  if (!file) return;
  try {
    let fc;
    if (/\.(geo)?json$/i.test(file.name)) {
      fc = JSON.parse(await file.text());
      if (fc.type === 'Feature') fc = { type: 'FeatureCollection', features: [fc] };
    } else {
      const r = parseKml(await readKmlFile(file), { snapMeters: 0 });
      fc = { type: 'FeatureCollection', features: [
        ...r.elements.map((e) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lng, e.lat] }, properties: { name: e.name } })),
        ...r.cables.map((c) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c.coords }, properties: { name: c.name } })),
        ...r.refFeatures,
      ] };
    }
    const colors = ['#64748b', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa'];
    store.checkpoint();
    store.project.refs.push({ id: uid('r'), name: file.name, color: colors[store.project.refs.length % colors.length], visible: true, geojson: fc });
    store.changed();
    fit(fc.features.flatMap(coordsOf));
    toast(`Referência adicionada: ${fc.features.length} feições.`);
  } catch (err) {
    toast(`Falha ao ler o arquivo: ${err.message}`, 'error');
  }
}

async function exportKml(fmt) {
  const p = store.project;
  const opts = { cableLength: (c) => cableLength(p, c).total };
  if (fmt === 'kmz') download(`${slug(p.name)}.kmz`, await toKmz(p, opts));
  else download(`${slug(p.name)}.kml`, toKml(p, opts), 'application/vnd.google-earth.kml+xml');
}

async function openProjectFile() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (!Array.isArray(j.elements) || !Array.isArray(j.cables)) throw new Error('não é um projeto Fiber 3D');
    for (const o of store.project.overlays) removeOverlayLayer(o);
    store.replace(j);
    for (const o of store.project.overlays) addOverlayLayer(o);
    fit([...store.project.elements.map((e) => [e.lng, e.lat]), ...store.project.cables.flatMap((c) => c.coords)]);
    toast('Projeto aberto.');
  } catch (err) {
    toast(`Arquivo inválido: ${err.message}`, 'error');
  }
}

function newProject() {
  if (!confirm('Começar um projeto novo? O atual pode ser recuperado com Ctrl+Z nesta sessão — exporte antes se quiser guardar.')) return;
  for (const o of store.project.overlays) removeOverlayLayer(o);
  store.replace(emptyProject());
  state.sel = null;
  renderProps();
}

/* --------------------------------------------------------------- lista --------------------------------------------------------------- */

let listFilter = '';
function listTab() {
  const p = store.project;
  const q = listFilter.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const inp = h('input', { type: 'search', placeholder: 'Filtrar por nome…', value: listFilter, oninput: (e) => { listFilter = e.target.value; const pos = e.target.selectionStart; renderTab(); const n = tabBody.querySelector('input'); n.focus(); n.setSelectionRange(pos, pos); } });
  const groups = [];
  for (const k of KIND_ORDER) {
    if (k === 'poste' && !q) continue; // postes podem ser milhares: só aparecem filtrando
    const els = p.elements.filter((e) => e.kind === k && match(e.name + ' ' + (e.props.numero || '')));
    if (!els.length) continue;
    groups.push(h('h4', null, `${KINDS[k].label} (${els.length})`), ...els.slice(0, 300).map((e) =>
      h('button', { class: 'list-item', onclick: () => { select_({ type: 'el', id: e.id }); map.flyTo({ center: [e.lng, e.lat], zoom: Math.max(map.getZoom(), 18.5) }); } },
        h('span', { class: 'swatch', style: { background: KINDS[k].color } }), e.name, h('small', null, k === 'cto' ? `${ctoUsage(p, e).usadas}/${e.props.portas}` : ''))));
  }
  const cs = p.cables.filter((c) => match(c.name));
  if (cs.length) groups.push(h('h4', null, `Cabos (${cs.length})`), ...cs.slice(0, 300).map((c) =>
    h('button', { class: 'list-item', onclick: () => { select_({ type: 'cable', id: c.id }); fit(c.coords); } },
      h('span', { class: 'swatch', style: { background: CABLE_TYPES[c.props.tipo]?.color } }), c.name, h('small', null, `${c.props.fibras}FO · ${fmtM(lineLength(c.coords))}`))));
  if (!q) groups.push(h('p', { class: 'muted' }, `${p.elements.filter((e) => e.kind === 'poste').length} postes — digite no filtro para listá-los.`));
  return [inp, ...groups];
}

/* ------------------------------------------------------------ materiais -------------------------------------------------------------- */

function bomTab() {
  const p = store.project;
  const rows = materials(p);
  const ctos = p.elements.filter((e) => e.kind === 'cto');
  const budgets = ctos.map((e) => ({ e, b: powerBudget(p, e) }));
  return [
    h('h4', null, 'Lista de materiais'),
    rows.length ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Qtd'))),
      h('tbody', null, rows.map((r) => h('tr', null, h('td', null, h('small', { class: 'muted' }, r.grupo), h('br'), r.item), h('td', { class: 'num' }, `${r.qtd.toLocaleString('pt-BR')} ${r.un}`))))) : h('p', { class: 'muted' }, 'Projeto vazio.'),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => download(`${slug(p.name)}-materiais.csv`, '﻿' + materialsCsv(rows), 'text/csv') }, 'Exportar CSV (Excel)')),
    h('h4', null, `Sinal estimado nas CTOs (${ctos.length})`),
    ctos.length ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'CTO'), h('th', null, 'Distância'), h('th', null, 'Rx'))),
      h('tbody', null, budgets.map(({ e, b }) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { select_({ type: 'el', id: e.id }); map.flyTo({ center: [e.lng, e.lat], zoom: 18.5 }); } },
        h('td', null, e.name), h('td', { class: 'num' }, b ? fmtM(b.distance) : '—'),
        h('td', { class: 'num' }, b ? h('span', { class: `badge ${b.ok ? 'ok' : 'bad'}` }, `${b.rx.toFixed(1)} dBm`) : h('span', { class: 'muted' }, 'sem POP')))))) : h('p', { class: 'muted' }, 'Nenhuma CTO.'),
    h('p', { class: 'muted' }, `Estimativa a 1310 nm: ${LOSS.fibraDbKm} dB/km, ${LOSS.fusao} dB por fusão, ${LOSS.conector} dB por conector e splitters das CEOs no caminho + o da CTO. Faixa aceitável: ${LOSS.rxMin} a ${LOSS.rxMax} dBm.`),
  ];
}

/* --------------------------------------------------------------- busca --------------------------------------------------------------- */

const searchInp = document.getElementById('search');
const searchRes = document.getElementById('search-results');
let searchTimer;
searchInp.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInp.value.trim();
  if (q.length < 3) { searchRes.replaceChildren(); return; }
  searchTimer = setTimeout(() => runSearch(q), 450);
});
searchInp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchRes.replaceChildren(); searchInp.blur(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) searchRes.replaceChildren(); });

async function runSearch(q) {
  const ql = q.toLowerCase();
  const local = [...store.project.elements.filter((e) => e.name.toLowerCase().includes(ql) || String(e.props.numero || '').toLowerCase().includes(ql)).slice(0, 6)
    .map((e) => ({ label: `${KINDS[e.kind].short} · ${e.name}`, center: [e.lng, e.lat], sel: { type: 'el', id: e.id } })),
  ...store.project.cables.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 4).map((c) => ({ label: `Cabo · ${c.name}`, center: c.coords[0], sel: { type: 'cable', id: c.id } }))];
  const show = (geo) => clear(searchRes, [...local, ...geo].map((r) => h('button', { onclick: () => {
    map.flyTo({ center: r.center, zoom: 18, pitch: 60 });
    if (r.sel) select_(r.sel);
    searchRes.replaceChildren();
  } }, r.label)));
  show([]);
  try {
    const vb = CITY.viewbox.join(',');
    const url = `${SOURCES.nominatim}?format=jsonv2&limit=6&countrycodes=br&bounded=1&viewbox=${vb}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
    const j = await r.json();
    show(j.map((x) => ({ label: x.display_name.replace(/, Região .*$/, ''), center: [Number(x.lon), Number(x.lat)] })));
  } catch { /* sem busca de endereços: fica só a busca local */ }
}

/* ------------------------------------------------------------- topo ----------------------------------------------------------------- */

document.getElementById('btn-undo').onclick = () => store.undo();
document.getElementById('btn-redo').onclick = () => store.redo();
const viewBtn = document.getElementById('btn-view');
viewBtn.onclick = () => {
  const is3d = map.getPitch() > 5;
  map.easeTo({ pitch: is3d ? 0 : 62, bearing: is3d ? 0 : -25, duration: 800 });
};
document.getElementById('btn-sv').onclick = () => setTool(state.tool === 'streetview' ? 'select' : 'streetview');
document.getElementById('btn-real').onclick = () => {
  if (!googleKey()) { state.tab = 'layers'; for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x.dataset.tab === 'layers'); renderTab(); toast('Cadastre a chave do Google em "Chaves de API" (aba Camadas).', 'warn'); return; }
  prefs.google3d = !prefs.google3d; savePrefs(); applyGoogleMode(); if (state.tab === 'layers') renderTab();
};
map.on('pitchend', () => { viewBtn.textContent = map.getPitch() > 5 ? '2D' : '3D'; });
viewBtn.textContent = map.getPitch() > 5 ? '2D' : '3D';

renderTab();
renderBanner();

export { map, store, state, modal };
