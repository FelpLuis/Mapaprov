// Converte o projeto em GeoJSON para as camadas 2D e 3D do mapa
import { KINDS, CABLE_TYPES } from './config.js';
import { band, circle, dist, lerp, rect } from './geo.js';

const SEL = '#22d3ee';

export function cableColor(c) {
  return c.props.cor || (CABLE_TYPES[c.props.tipo] || CABLE_TYPES.distribuicao).color;
}

export function ctoUsage(project, el) {
  const drops = project.cables.filter((c) => c.props.tipo === 'drop' && c.nodes.includes(el.id)).length;
  return { usadas: drops, total: Number(el.props.portas) || 0 };
}

function elementLabel(project, e) {
  if (e.kind === 'cto') {
    const u = ctoUsage(project, e);
    return `${e.name} (${u.usadas}/${u.total})`;
  }
  return e.name;
}

function feat(geometry, properties) { return { type: 'Feature', geometry, properties }; }
function poly(coordinates, properties) { return feat({ type: 'Polygon', coordinates }, properties); }

export function buildPoints(project, sel) {
  return {
    type: 'FeatureCollection',
    features: project.elements.map((e) => feat({ type: 'Point', coordinates: [e.lng, e.lat] }, {
      ref: e.id, rtype: 'el', kind: e.kind, name: elementLabel(project, e),
      color: (KINDS[e.kind] || KINDS.marcador).color, sel: sel?.id === e.id ? 1 : 0,
    })),
  };
}

export function buildCableLines(project, sel) {
  return {
    type: 'FeatureCollection',
    features: project.cables.filter((c) => c.coords.length >= 2).map((c) => feat({ type: 'LineString', coordinates: c.coords }, {
      ref: c.id, rtype: 'cable', name: `${c.name} · ${c.props.fibras}FO`, color: cableColor(c),
      lanc: c.props.lancamento, tipo: c.props.tipo, sel: sel?.id === c.id ? 1 : 0,
    })),
  };
}

// alturas reais em metros; "s" exagera a espessura dos objetos pequenos para ficarem visíveis
export function build3D(project, sel, s = 3, z = 0) {
  const out = [];
  const byId = new Map(project.elements.map((e) => [e.id, e]));

  for (const e of project.elements) {
    const p = [e.lng, e.lat];
    const color = sel?.id === e.id ? SEL : (KINDS[e.kind] || KINDS.marcador).color;
    const P = { ref: e.id, rtype: 'el', color };
    switch (e.kind) {
      case 'poste': {
        const h = Number(e.props.altura) || 9;
        out.push(poly(circle(p, 0.17 * s, 8), { ...P, base: 0, top: h }));
        out.push(poly(rect(p, 0.9 * s, 0.12 * s), { ...P, color: sel?.id === e.id ? SEL : '#6b7280', base: h - 0.6, top: h - 0.45 }));
        break;
      }
      case 'cto': out.push(poly(rect(p, 0.8 * s, 0.5 * s), { ...P, base: 4.9, top: 5.9 })); break;
      case 'ceo': out.push(poly(circle(p, 0.4 * s, 14), { ...P, base: 5.9, top: 6.9 })); break;
      case 'reserva': out.push(poly(circle(p, 0.55 * s, 16), { ...P, base: 6.75, top: 7.05 })); break;
      case 'pop': out.push(poly(rect(p, 9, 6), { ...P, base: 0, top: 4.2 })); break;
      case 'cliente':
        out.push(poly(circle(p, 0.08 * s, 6), { ...P, base: 0, top: 2.6 }));
        out.push(poly(rect(p, 0.7 * s, 0.7 * s), { ...P, base: 2.6, top: 3.2 }));
        break;
      default: out.push(poly(circle(p, 0.25 * s, 8), { ...P, base: 0, top: 2 }));
    }
  }

  for (const c of project.cables) {
    if (c.coords.length < 2) continue;
    const color = sel?.id === c.id ? SEL : cableColor(c);
    const P = { ref: c.id, rtype: 'cable', color };
    const aerial = c.props.lancamento !== 'subterraneo';
    const w = (c.props.tipo === 'backbone' ? 0.16 : c.props.tipo === 'drop' ? 0.08 : 0.12) * s;
    if (!aerial) {
      for (let i = 1; i < c.coords.length; i++) out.push(poly(band(c.coords[i - 1], c.coords[i], w * 1.5), { ...P, base: 0, top: 0.08 }));
      continue;
    }
    const alt = Number(c.props.altura) || 6.8;
    const hAt = (i) => {
      const el = byId.get(c.nodes[i]);
      if (!el || el.kind === 'poste' || el.kind === 'reserva') return alt;
      return KINDS[el.kind]?.h || alt;
    };
    const thick = 0.1 * s;
    for (let i = 1; i < c.coords.length; i++) {
      const a = c.coords[i - 1], b = c.coords[i];
      const span = dist(a, b);
      const ha = hAt(i - 1), hb = hAt(i);
      const sag = Math.min(0.7, span * 0.012);
      const n = Math.max(1, Math.min(14, Math.ceil(span / 3)));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
        const h = ha + (hb - ha) * tm - sag * 4 * tm * (1 - tm);
        out.push(poly(band(lerp(a, b, t0), lerp(a, b, t1), w), { ...P, base: h - thick / 2, top: h + thick / 2 }));
      }
    }
  }
  if (z) for (const f of out) { f.properties.base = Math.max(0, f.properties.base + z); f.properties.top = Math.max(0.05, f.properties.top + z); }
  return { type: 'FeatureCollection', features: out };
}

export function buildHandles(coords) {
  return {
    type: 'FeatureCollection',
    features: (coords || []).map((c, i) => feat({ type: 'Point', coordinates: c }, { i })),
  };
}

export function buildRefs(project) {
  const features = [];
  for (const r of project.refs) {
    if (!r.visible) continue;
    for (const f of r.geojson.features || []) {
      features.push({ ...f, properties: { ...(f.properties || {}), _ref: r.id, _color: r.color || '#64748b', name: f.properties?.name || '' } });
    }
  }
  return { type: 'FeatureCollection', features };
}
