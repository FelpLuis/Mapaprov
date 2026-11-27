// Diagrama de fusões de uma CEO/CTO: fibras dos cabos (cores ABNT), splitters e ligações
import { ABNT, SPLITTERS } from './config.js';
import { store, uid } from './store.js';
import { h, clear, modal, select, toast } from './ui.js';

export function fiberColor(n) { return ABNT[(n - 1) % 12]; }
export function tubeOf(n, total) { return total > 12 ? Math.floor((n - 1) / 12) + 1 : 1; }

export function portLabel(key) {
  const [t, id, p] = key.split(':');
  if (t === 'c') {
    const c = store.cable(id);
    const n = Number(p);
    const total = c?.props.fibras || 0;
    return `${c ? c.name : '?'} · ${total > 12 ? `T${tubeOf(n, total)} ` : ''}F${n} ${fiberColor(n)[0]}`;
  }
  return `Splitter ${p === 'in' ? 'entrada' : `saída ${p}`}`;
}

export function openSplice(boxId, onChange) {
  const box = store.el(boxId);
  if (!box) return;
  box.props.splitters ||= [];
  box.props.fusoes ||= [];
  let pending = null;

  const diagram = h('div', { class: 'splice' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('splice-svg');
  const wrap = h('div', { class: 'splice-wrap' }, diagram, svg);
  const list = h('div', { class: 'fusion-list' });
  const tools = h('div', { class: 'splice-tools' });
  const body = h('div', null, tools, wrap, list);
  const m = modal(`Diagrama de fusões · ${box.name}`, body, { wide: true, onClose: () => onChange?.() });

  const used = () => {
    const map = new Map();
    for (const f of box.props.fusoes) { map.set(f[0], f[1]); map.set(f[1], f[0]); }
    return map;
  };

  function mutate(fn) {
    store.checkpoint();
    fn();
    store.changed('props');
    render();
  }

  function onPort(key) {
    const u = used();
    if (!pending) {
      if (u.has(key)) {
        if (confirm(`Remover a fusão\n${portLabel(key)}  ↔  ${portLabel(u.get(key))}?`)) {
          mutate(() => { box.props.fusoes = box.props.fusoes.filter((f) => f[0] !== key && f[1] !== key); });
        }
        return;
      }
      pending = key;
      render();
      return;
    }
    if (pending === key) { pending = null; render(); return; }
    if (u.has(key)) { toast('Essa porta/fibra já está fusionada.', 'warn'); return; }
    if (pending.split(':').slice(0, 2).join(':') === key.split(':').slice(0, 2).join(':') && key.startsWith('s:')) {
      toast('Não é possível ligar o splitter nele mesmo.', 'warn'); return;
    }
    const a = pending;
    pending = null;
    mutate(() => box.props.fusoes.push([a, key]));
  }

  function port(key, color, label, side) {
    const u = used();
    return h('button', {
      class: `port ${side}${u.has(key) ? ' used' : ''}${pending === key ? ' pending' : ''}`,
      dataset: { key }, title: u.has(key) ? `Fusionada com ${portLabel(u.get(key))} (clique para remover)` : 'Clique para iniciar/concluir uma fusão',
      onclick: () => onPort(key),
    }, h('i', { style: { background: color } }), label);
  }

  function cableBlock(c, side) {
    const total = Number(c.props.fibras) || 1;
    const idx = c.nodes.indexOf(box.id);
    const pos = idx === 0 ? 'ponta (início)' : idx === c.nodes.length - 1 ? 'ponta (fim)' : 'passante';
    const rows = [];
    for (let n = 1; n <= total; n++) {
      const t = tubeOf(n, total);
      const [, col] = fiberColor(n);
      const tube = total > 12 ? h('b', { class: 'tube', style: { background: ABNT[(t - 1) % 12][1] }, title: `Tubo ${t} (${ABNT[(t - 1) % 12][0]})` }) : null;
      rows.push(h('div', { class: 'fiber-row' }, side === 'right' ? tube : null, port(`c:${c.id}:${n}`, col, `${total > 12 ? `T${t}·` : ''}F${n}`, side), side === 'left' ? tube : null));
    }
    return h('div', { class: 'cable-block' }, h('div', { class: 'cable-head' }, h('b', null, c.name), h('small', null, `${total} FO · ${pos}`)), ...rows);
  }

  function splitterBlock(s, i) {
    const n = Number(s.tipo.split('x')[1]) || 2;
    const outs = [];
    for (let k = 1; k <= n; k++) outs.push(port(`s:${s.id}:${k}`, '#94a3b8', `S${k}`, 'right'));
    return h('div', { class: 'splitter-block' },
      h('div', { class: 'cable-head' }, h('b', null, `Splitter ${i + 1} · ${s.tipo}`),
        h('button', { class: 'btn ghost xs', title: 'Remover splitter', onclick: () => mutate(() => {
          box.props.splitters = box.props.splitters.filter((x) => x.id !== s.id);
          box.props.fusoes = box.props.fusoes.filter(([a, b]) => !a.startsWith(`s:${s.id}:`) && !b.startsWith(`s:${s.id}:`));
        }) }, '✕')),
      h('div', { class: 'split-body' }, h('div', null, port(`s:${s.id}:in`, '#e2e8f0', 'IN', 'left')), h('div', { class: 'split-outs' }, outs)));
  }

  function render() {
    const cables = store.cablesAt(box.id);
    const left = [], right = [];
    cables.forEach((c, i) => (i % 2 === 0 ? left : right).push(c));
    clear(diagram,
      h('div', { class: 'col' }, left.length ? left.map((c) => cableBlock(c, 'left')) : h('p', { class: 'muted' }, 'Nenhum cabo chega nesta caixa. Desenhe um cabo terminando ou passando por ela.')),
      h('div', { class: 'col mid' }, box.props.splitters.map(splitterBlock)),
      h('div', { class: 'col' }, right.map((c) => cableBlock(c, 'right'))));

    let tipo = '1x8';
    const a = select(cables.map((c) => [c.id, c.name]), cables[0]?.id, () => {});
    const b = select(cables.map((c) => [c.id, c.name]), cables[1]?.id, () => {});
    clear(tools,
      h('span', null, 'Adicionar splitter '), select(SPLITTERS, tipo, (v) => { tipo = v; }),
      h('button', { class: 'btn', onclick: () => mutate(() => box.props.splitters.push({ id: uid('s'), tipo })) }, '+ Splitter'),
      h('span', { class: 'sep' }),
      h('span', null, 'Fusão sequencial '), a, h('span', null, '↔'), b,
      h('button', { class: 'btn', onclick: () => autoFuse(a.value, b.value) }, 'Fusionar F1…Fn'),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, pending ? `Selecionada: ${portLabel(pending)} — clique no destino` : 'Clique em uma fibra/porta e depois na outra para fusionar.'));

    const fus = box.props.fusoes;
    clear(list, h('h4', null, `Fusões (${fus.length})`),
      fus.length ? h('table', null, h('tbody', null, fus.map((f, i) => h('tr', null,
        h('td', null, i + 1), h('td', null, portLabel(f[0])), h('td', null, '↔'), h('td', null, portLabel(f[1])),
        h('td', null, h('button', { class: 'btn ghost xs', onclick: () => mutate(() => fus.splice(i, 1)) }, 'remover')))))) : h('p', { class: 'muted' }, 'Nenhuma fusão ainda.'));
    requestAnimationFrame(drawLines);
  }

  function autoFuse(aId, bId) {
    if (!aId || !bId || aId === bId) { toast('Escolha dois cabos diferentes.', 'warn'); return; }
    const A = store.cable(aId), B = store.cable(bId);
    const u = used();
    const n = Math.min(A.props.fibras, B.props.fibras);
    let made = 0;
    mutate(() => {
      for (let i = 1; i <= n; i++) {
        const ka = `c:${aId}:${i}`, kb = `c:${bId}:${i}`;
        if (!u.has(ka) && !u.has(kb)) { box.props.fusoes.push([ka, kb]); made++; }
      }
    });
    toast(`${made} fusões criadas.`);
  }

  function drawLines() {
    const r0 = wrap.getBoundingClientRect();
    svg.setAttribute('width', wrap.scrollWidth);
    svg.setAttribute('height', wrap.scrollHeight);
    svg.replaceChildren();
    const anchor = (key) => {
      const el = diagram.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const isRight = el.classList.contains('right');
      return { x: (isRight ? r.left : r.right) - r0.left + wrap.scrollLeft, y: r.top + r.height / 2 - r0.top + wrap.scrollTop, dir: isRight ? -1 : 1 };
    };
    for (const [a, b] of box.props.fusoes) {
      const p = anchor(a), q = anchor(b);
      if (!p || !q) continue;
      const color = a.startsWith('c:') ? fiberColor(Number(a.split(':')[2]))[1] : b.startsWith('c:') ? fiberColor(Number(b.split(':')[2]))[1] : '#94a3b8';
      const dx = Math.max(40, Math.abs(q.x - p.x) / 2);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${p.x},${p.y} C${p.x + dx * p.dir},${p.y} ${q.x + dx * q.dir},${q.y} ${q.x},${q.y}`);
      path.setAttribute('stroke', color);
      path.setAttribute('class', 'fusion-line');
      svg.appendChild(path);
    }
  }

  wrap.addEventListener('scroll', drawLines);
  window.addEventListener('resize', drawLines);
  render();
  return m;
}
