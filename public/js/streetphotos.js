// Fotos de rua gratuitas (Mapillary): visualizador embutido + busca da foto mais próxima
/* global mapillary */
import { SOURCES } from './config.js';
import { dist } from './geo.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
let viewer = null;
let libPromise = null;

function loadLib() {
  libPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${VENDOR}mapillary.js`;
    s.onload = () => resolve();
    s.onerror = () => { libPromise = null; reject(new Error('não foi possível carregar o visualizador')); };
    document.head.appendChild(s);
  });
  return libPromise;
}

// foto mais próxima do ponto (procura num raio crescente); prefere as mais recentes entre as próximas
export async function nearestImage(token, [lng, lat]) {
  for (const r of [0.0006, 0.002, 0.006]) {
    const bbox = [lng - r, lat - r, lng + r, lat + r].map((x) => x.toFixed(6)).join(',');
    const url = `${SOURCES.mapillaryImages}?access_token=${encodeURIComponent(token)}&fields=id,computed_geometry,geometry,captured_at&bbox=${bbox}&limit=200`;
    const res = await fetch(url);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
    const imgs = (j.data || []).map((im) => {
      const c = (im.computed_geometry || im.geometry)?.coordinates;
      return c ? { id: im.id, d: dist([lng, lat], c), t: im.captured_at || 0 } : null;
    }).filter(Boolean);
    if (imgs.length) {
      const min = Math.min(...imgs.map((x) => x.d));
      // entre as fotos até 15 m mais longe que a mais próxima, fica a mais nova
      imgs.sort((a, b) => (a.d <= min + 15 && b.d <= min + 15 ? b.t - a.t : a.d - b.d));
      return imgs[0];
    }
  }
  return null;
}

/**
 * Abre (ou move) o visualizador no container.
 * onMove({ lngLat:[lng,lat], bearing, capturedAt }) é chamado quando a foto ou a direção mudam.
 */
export async function showStreetPhoto(container, token, lngLat, onMove) {
  await loadLib();
  const img = await nearestImage(token, lngLat);
  if (!img) return null;
  if (!viewer) {
    viewer = new mapillary.Viewer({ accessToken: token, container, component: { cover: false } });
    let last = {};
    const emit = async () => {
      try {
        const pos = await viewer.getPosition();
        const bearing = await viewer.getBearing();
        last = { ...last, lngLat: [pos.lng, pos.lat], bearing };
        onMove?.(last);
      } catch { /* viewer ainda carregando */ }
    };
    viewer.on('image', (e) => { last.capturedAt = e.image?.capturedAt; emit(); });
    viewer.on('bearing', emit);
    viewer.on('position', emit);
  }
  await viewer.moveTo(img.id);
  return img;
}

export function resizeStreetPhoto() { viewer?.resize(); }

export function closeStreetPhoto() {
  if (!viewer) return;
  viewer.remove();
  viewer = null;
}
