// Modo realista: Google Photorealistic 3D Tiles (Map Tiles API) desenhado dentro do MapLibre via deck.gl
/* global deck, DracoDecoderModule */

const VENDOR = new URL('../vendor/', import.meta.url).href;
const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

let overlay = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`não foi possível carregar ${src}`));
    document.head.appendChild(s);
  });
}

// decodificador Draco servido pelo próprio site (sem CDN externo)
const draco3d = {
  createDecoderModule: () => new Promise((resolve) => {
    DracoDecoderModule({ locateFile: (f) => `${VENDOR}draco/${f}`, onModuleLoaded: (m) => resolve(m) });
  }),
};

export function googleActive() { return !!overlay; }

/**
 * @param map  mapa MapLibre
 * @param opts { key, beforeId, onCredits(text), onError(msg) }
 */
export async function enableGoogle3D(map, { key, beforeId, onCredits, onError }) {
  if (overlay) return;
  await loadScript(`${VENDOR}deck.gl.min.js`);
  await loadScript(`${VENDOR}draco/draco_wasm_wrapper.js`);
  let lastCredits = '';
  let reported = false;
  const layer = new deck.Tile3DLayer({
    id: 'google-3d',
    data: ROOT,
    beforeId,
    loadOptions: {
      fetch: { headers: { 'X-GOOG-API-KEY': key } },
      worker: false,
      modules: { draco3d },
    },
    onTilesetLoad: (tileset) => {
      tileset.options.onTraversalComplete = (selected) => {
        const credits = new Set();
        for (const t of selected) {
          const c = t.content?.gltf?.asset?.copyright;
          if (c) for (const part of c.split(';')) if (part.trim()) credits.add(part.trim());
        }
        const text = [...credits].join('; ');
        if (text !== lastCredits) { lastCredits = text; onCredits?.(text); }
        return selected;
      };
    },
    onTileError: (_tile, url, message) => {
      if (reported) return;
      reported = true;
      onError?.(String(message || url));
    },
  });
  // erro ao abrir o tileset (chave inválida, API não ativada, cota...) chega aqui
  const onDeckError = (err) => {
    if (reported) return true;
    reported = true;
    onError?.(String(err?.message || err));
    return true;
  };
  overlay = new deck.MapboxOverlay({ interleaved: true, layers: [layer], onError: onDeckError });
  map.addControl(overlay);
}

export function disableGoogle3D(map) {
  if (!overlay) return;
  map.removeControl(overlay);
  overlay = null;
}
