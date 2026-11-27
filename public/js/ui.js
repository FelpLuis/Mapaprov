// Utilidades de interface (sem dependências)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren(...children.flat().filter(Boolean));
  return el;
}

let toastTimer;
export function toast(msg, kind = 'info', ms = 3500) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.appendChild(t); }
  t.className = `show ${kind}`;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, ms);
}

export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}` },
      h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'btn ghost', onclick: close, title: 'Fechar (Esc)' }, '✕')),
      h('div', { class: 'modal-body' }, body)));
  document.body.appendChild(back);
  document.addEventListener('keydown', onKey);
  return { close, el: back };
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve(inp.files[0] || null); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);
}

export function select(options, value, onchange) {
  const s = h('select', { onchange: () => onchange(s.value) });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    s.appendChild(h('option', { value: v, selected: String(v) === String(value) }, l));
  }
  return s;
}
