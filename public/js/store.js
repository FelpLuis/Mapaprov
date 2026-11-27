// Estado do projeto, desfazer/refazer e salvamento automático no navegador
const KEY = 'fiber3d.project.v1';
const MAX_HISTORY = 80;

export function uid(prefix = 'x') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyProject(name = 'Projeto FTTH Cubatão') {
  return { format: 'fiber3d', version: 1, name, created: new Date().toISOString(), elements: [], cables: [], refs: [], overlays: [] };
}

function normalize(p) {
  const base = emptyProject();
  const out = { ...base, ...p };
  for (const k of ['elements', 'cables', 'refs', 'overlays']) if (!Array.isArray(out[k])) out[k] = [];
  for (const c of out.cables) {
    if (!Array.isArray(c.nodes) || c.nodes.length !== c.coords.length) c.nodes = c.coords.map((_, i) => (c.nodes && c.nodes[i]) || null);
  }
  return out;
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.history = [];
    this.future = [];
    this.listeners = new Set();
    this.saveTimer = null;
    this.lastSaveError = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.project = normalize(JSON.parse(raw));
    } catch { /* armazenamento indisponível: começa vazio */ }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // chame ANTES de alterar o projeto
  checkpoint() {
    this.history.push(JSON.stringify(this.project));
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future = [];
  }

  // chame DEPOIS de alterar
  changed(what = 'all') {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
    for (const fn of this.listeners) fn(what);
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.project));
      this.lastSaveError = null;
    } catch (e) {
      this.lastSaveError = e;
      for (const fn of this.listeners) fn('save-error');
    }
  }

  undo() {
    if (!this.history.length) return false;
    this.future.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.history.pop());
    this.changed();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.future.pop());
    this.changed();
    return true;
  }

  replace(project) {
    this.checkpoint();
    this.project = normalize(project);
    this.changed();
  }

  el(id) { return this.project.elements.find((e) => e.id === id); }
  cable(id) { return this.project.cables.find((c) => c.id === id); }

  // cabos que chegam/passam por um elemento
  cablesAt(id) { return this.project.cables.filter((c) => c.nodes.includes(id)); }

  removeElement(id) {
    const p = this.project;
    p.elements = p.elements.filter((e) => e.id !== id);
    for (const c of p.cables) c.nodes = c.nodes.map((n) => (n === id ? null : n));
  }

  removeCable(id) {
    const p = this.project;
    p.cables = p.cables.filter((c) => c.id !== id);
    // remove fusões que usavam o cabo
    for (const e of p.elements) {
      if (Array.isArray(e.props?.fusoes)) e.props.fusoes = e.props.fusoes.filter(([a, b]) => !a.startsWith(`c:${id}:`) && !b.startsWith(`c:${id}:`));
    }
  }

  moveElement(id, lngLat) {
    const e = this.el(id);
    if (!e) return;
    e.lng = lngLat[0]; e.lat = lngLat[1];
    for (const c of this.project.cables) c.nodes.forEach((n, i) => { if (n === id) c.coords[i] = [e.lng, e.lat]; });
  }
}

export const store = new Store();
