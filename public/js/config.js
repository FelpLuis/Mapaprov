// Constantes do projetista de redes FTTH 3D (Cubatão/SP)

export const CITY = {
  name: 'Cubatão',
  uf: 'SP',
  ibge: '3513504',
  center: [-46.4253, -23.8911],
  zoom: 16,
  pitch: 62,
  bearing: -25,
  // caixa usada para limitar buscas de endereço (oeste, norte, leste, sul)
  viewbox: [-46.60, -23.76, -46.30, -23.99],
};

// Fontes externas (todas gratuitas, sem chave). Precisam estar liberadas no CSP do servidor.
export const SOURCES = {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  terrain: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  overpass: 'https://overpass-api.de/api/interpreter',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  mapillary: 'https://graph.mapillary.com/map_features',
  mapillaryImages: 'https://graph.mapillary.com/images',
  mapillaryTiles: (token) => `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${encodeURIComponent(token)}`,
  streetView: (key, lat, lng, heading) => `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&location=${lat},${lng}&fov=85&pitch=8${heading != null ? `&heading=${Math.round(heading)}` : ''}&language=pt-BR`,
  ibge: (code) => `https://servicodados.ibge.gov.br/api/v3/malhas/municipios/${code}?formato=application/vnd.geo+json&qualidade=maxima`,
};

// Tipos de elementos pontuais. h = altura (m) em que o equipamento fica no poste.
export const KINDS = {
  pop:      { label: 'POP / OLT', short: 'POP', color: '#8e44ad', key: 'P', h: 3.5 },
  ceo:      { label: 'CEO · Caixa de emenda', short: 'CEO', color: '#e67e22', key: 'E', h: 6.4 },
  cto:      { label: 'CTO · Caixa de atendimento', short: 'CTO', color: '#16a34a', key: 'C', h: 5.4 },
  poste:    { label: 'Poste', short: 'Poste', color: '#9aa5b1', key: 'O', h: 9 },
  reserva:  { label: 'Reserva técnica', short: 'Reserva', color: '#eab308', key: 'R', h: 6.9 },
  cliente:  { label: 'Cliente / ONU', short: 'Cliente', color: '#2563eb', key: 'L', h: 3 },
  marcador: { label: 'Marcador', short: 'Marcador', color: '#db2777', key: 'M', h: 0 },
};

export const KIND_ORDER = ['pop', 'ceo', 'cto', 'poste', 'reserva', 'cliente', 'marcador'];

export const CABLE_TYPES = {
  backbone:     { label: 'Backbone / Tronco', color: '#dc2626', altura: 7.3, fibras: 48 },
  distribuicao: { label: 'Distribuição', color: '#f59e0b', altura: 6.9, fibras: 12 },
  drop:         { label: 'Drop (cliente)', color: '#0ea5e9', altura: 6.3, fibras: 1 },
};

export const FIBER_COUNTS = [1, 2, 4, 6, 12, 24, 36, 48, 72, 96, 144, 288];

// Código de cores ABNT NBR 14721 (fibras e tubos loose)
export const ABNT = [
  ['Verde', '#16a34a'], ['Amarelo', '#facc15'], ['Branco', '#f8fafc'], ['Azul', '#2563eb'],
  ['Vermelho', '#dc2626'], ['Violeta', '#7c3aed'], ['Marrom', '#854d0e'], ['Rosa', '#f9a8d4'],
  ['Preto', '#111827'], ['Cinza', '#9ca3af'], ['Laranja', '#f97316'], ['Aqua', '#2dd4bf'],
];

export const SPLITTERS = ['1x2', '1x4', '1x8', '1x16', '1x32', '1x64'];
// perda típica de inserção (dB) de splitters PLC balanceados
export const SPLITTER_LOSS = { '1x2': 3.7, '1x4': 7.3, '1x8': 10.5, '1x16': 13.7, '1x32': 17.1, '1x64': 20.5 };

export const LOSS = {
  fibraDbKm: 0.35,  // 1310 nm
  fusao: 0.1,
  conector: 0.5,
  rxMin: -27,       // sensibilidade típica de ONU GPON classe B+/C+
  rxMax: -8,
};

export function defaultProps(kind) {
  switch (kind) {
    case 'pop': return { olt: '', pon: '', potenciaTx: 5, endereco: '', obs: '' };
    case 'ceo': return { modelo: '', capacidade: 24, bandejas: 2, splitters: [], fusoes: [], obs: '' };
    case 'cto': return { modelo: '', portas: 8, splitters: [{ id: 's1', tipo: '1x8' }], fusoes: [], endereco: '', obs: '' };
    case 'poste': return { numero: '', altura: 9, material: 'Concreto', proprietario: 'Concessionária', situacao: 'Existente', obs: '' };
    case 'reserva': return { metros: 20, obs: '' };
    case 'cliente': return { contrato: '', porta: '', endereco: '', obs: '' };
    default: return { obs: '' };
  }
}

export function defaultCableProps(tipo = 'distribuicao') {
  const t = CABLE_TYPES[tipo] || CABLE_TYPES.distribuicao;
  return { tipo, fibras: t.fibras, lancamento: 'aereo', altura: t.altura, reserva: 0, cor: '', modelo: '', obs: '' };
}
