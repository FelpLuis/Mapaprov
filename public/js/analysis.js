// Cálculos de projeto: metragem, orçamento óptico e lista de materiais
import { CABLE_TYPES, KINDS, LOSS, SPLITTER_LOSS } from './config.js';
import { dist, lineLength } from './geo.js';

// metragem de lançamento = traçado + reserva do cabo + reservas técnicas no caminho + 3% de catenária (aéreo)
export function cableLength(project, c) {
  const base = lineLength(c.coords);
  let reservas = Number(c.props.reserva) || 0;
  for (const id of c.nodes) {
    const e = id && project.elements.find((x) => x.id === id);
    if (e?.kind === 'reserva') reservas += Number(e.props.metros) || 0;
  }
  const folga = c.props.lancamento === 'subterraneo' ? 0 : base * 0.03;
  return { tracado: base, reservas, folga, total: base + reservas + folga };
}

// grafo da rede: nós = elementos ligados aos cabos; arestas = trechos de cabo entre eles
export function buildGraph(project) {
  const adj = new Map();
  const add = (a, b, w, cable) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, w, cable });
    adj.get(b).push({ to: a, w, cable });
  };
  for (const c of project.cables) {
    let last = null, acc = 0;
    for (let i = 0; i < c.coords.length; i++) {
      if (i > 0) acc += dist(c.coords[i - 1], c.coords[i]);
      const n = c.nodes[i];
      if (!n) continue;
      if (last && last !== n) add(last, n, acc, c.id);
      last = n; acc = 0;
    }
  }
  return adj;
}

export function pathToPop(project, fromId, graph = buildGraph(project)) {
  const kindOf = new Map(project.elements.map((e) => [e.id, e.kind]));
  const D = new Map([[fromId, 0]]), prev = new Map();
  const todo = new Set([fromId]);
  while (todo.size) {
    let u = null, best = Infinity;
    for (const n of todo) if (D.get(n) < best) { best = D.get(n); u = n; }
    todo.delete(u);
    if (kindOf.get(u) === 'pop' && u !== fromId) {
      const path = [u];
      while (prev.has(path[0])) path.unshift(prev.get(path[0]).from);
      return { distance: best, path };
    }
    for (const { to, w } of graph.get(u) || []) {
      const nd = best + w;
      if (nd < (D.get(to) ?? Infinity)) { D.set(to, nd); prev.set(to, { from: u }); todo.add(to); }
    }
  }
  return null;
}

/**
 * Estimativa do sinal na caixa/cliente: Tx do POP − (fibra + fusões + conectores + splitters).
 * Splitters considerados: os das CEOs no caminho e o da própria caixa (CTOs intermediárias são tratadas como passagem).
 */
export function powerBudget(project, el) {
  const r = pathToPop(project, el.id);
  if (!r) return null;
  const byId = new Map(project.elements.map((e) => [e.id, e]));
  const pop = byId.get(r.path[r.path.length - 1]);
  const boxes = r.path.slice(1, -1).map((id) => byId.get(id)).filter((e) => e && (e.kind === 'ceo' || e.kind === 'cto'));
  let splitter = 0;
  const splitterList = [];
  const addSpl = (e) => { const s = (e.props.splitters || [])[0]; if (s) { splitter += SPLITTER_LOSS[s.tipo] || 0; splitterList.push(`${e.name} ${s.tipo}`); } };
  for (const b of boxes) if (b.kind === 'ceo') addSpl(b);
  if (el.kind === 'ceo' || el.kind === 'cto') addSpl(el);
  const fibra = (r.distance / 1000) * LOSS.fibraDbKm;
  const fusoes = (boxes.length + 1) * 2 * LOSS.fusao;
  const conectores = 2 * LOSS.conector;
  const total = fibra + fusoes + conectores + splitter;
  const tx = Number(pop.props.potenciaTx) || 0;
  const rx = tx - total;
  return { pop, distance: r.distance, boxes: boxes.length, fibra, fusoes, conectores, splitter, splitterList, total, tx, rx, ok: rx >= LOSS.rxMin && rx <= LOSS.rxMax };
}

export function materials(project) {
  const rows = [];
  const push = (grupo, item, qtd, un) => { if (qtd) rows.push({ grupo, item, qtd, un }); };

  for (const k of Object.keys(KINDS)) {
    const els = project.elements.filter((e) => e.kind === k);
    if (!els.length) continue;
    if (k === 'cto') {
      const by = {};
      for (const e of els) { const key = `${e.props.portas || '?'} portas${e.props.modelo ? ` · ${e.props.modelo}` : ''}`; by[key] = (by[key] || 0) + 1; }
      for (const [key, n] of Object.entries(by)) push('Caixas', `CTO ${key}`, n, 'un');
    } else if (k === 'ceo') {
      const by = {};
      for (const e of els) { const key = `${e.props.capacidade || '?'} fusões${e.props.modelo ? ` · ${e.props.modelo}` : ''}`; by[key] = (by[key] || 0) + 1; }
      for (const [key, n] of Object.entries(by)) push('Caixas', `CEO ${key}`, n, 'un');
    } else if (k === 'poste') {
      const novos = els.filter((e) => e.props.situacao === 'Novo').length;
      push('Infraestrutura', 'Postes existentes (ocupação)', els.length - novos, 'un');
      push('Infraestrutura', 'Postes novos', novos, 'un');
    } else if (k === 'reserva') {
      push('Infraestrutura', 'Suporte de reserva técnica', els.length, 'un');
    } else if (k === 'cliente') {
      push('Clientes', 'Clientes / ONUs', els.length, 'un');
    } else if (k === 'pop') {
      push('Ativos', 'POP / OLT', els.length, 'un');
    }
  }

  const spl = {};
  for (const e of project.elements) for (const s of e.props.splitters || []) spl[s.tipo] = (spl[s.tipo] || 0) + 1;
  for (const [t, n] of Object.entries(spl)) push('Splitters', `Splitter PLC ${t}`, n, 'un');

  let fus = 0;
  for (const e of project.elements) fus += (e.props.fusoes || []).length;
  push('Serviços', 'Fusões ópticas (diagramadas)', fus, 'un');

  const cab = {};
  let anc = 0, susp = 0;
  const kindOf = new Map(project.elements.map((e) => [e.id, e.kind]));
  for (const c of project.cables) {
    const t = CABLE_TYPES[c.props.tipo]?.label || c.props.tipo;
    const key = `${t} ${c.props.fibras}FO${c.props.modelo ? ` ${c.props.modelo}` : ''} (${c.props.lancamento === 'subterraneo' ? 'subterrâneo' : 'aéreo'})`;
    cab[key] = (cab[key] || 0) + cableLength(project, c).total;
    if (c.props.lancamento !== 'subterraneo') {
      c.nodes.forEach((n, i) => {
        if (!n || !['poste', 'reserva'].includes(kindOf.get(n))) return;
        if (i === 0 || i === c.nodes.length - 1) anc++; else susp++;
      });
    }
  }
  for (const [k, m] of Object.entries(cab)) push('Cabos', k, Math.ceil(m), 'm');
  push('Ferragens', 'Conjunto de ancoragem (pontas em poste)', anc, 'un');
  push('Ferragens', 'Conjunto de suspensão (passagem em poste)', susp, 'un');
  return rows;
}

export function materialsCsv(rows) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return ['Grupo;Item;Quantidade;Unidade', ...rows.map((r) => [q(r.grupo), q(r.item), r.qtd, r.un].join(';'))].join('\r\n');
}
