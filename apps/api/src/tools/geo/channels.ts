// Straits, canals and narrow passages that the 1° water grid cannot resolve on its own. Each
// channel is an authored polyline of water points; consecutive points are joined directly and
// every point may link to nearby grid nodes with a tolerant land check. Canals are the only
// edges allowed to cross land outright.
export interface Channel {
  id: string;
  name: string;
  canal?: boolean;
  points: Array<[number, number]>; // [lng, lat]
}

export const CHANNELS: Channel[] = [
  {
    id: 'gibraltar',
    name: 'Strait of Gibraltar',
    points: [
      [-6.4, 35.9],
      [-5.9, 35.95],
      [-5.55, 35.95],
      [-5.1, 36.05],
    ],
  },
  {
    id: 'turkish_straits',
    name: 'Bosporus, Sea of Marmara and Dardanelles',
    points: [
      [29.4, 41.35],
      [29.1, 41.2],
      [29.05, 41.05],
      [28.6, 40.85],
      [27.9, 40.7],
      [27.3, 40.6],
      [26.75, 40.42],
      [26.45, 40.22],
      [26.2, 40.02],
      [25.9, 39.9],
    ],
  },
  {
    id: 'messina',
    name: 'Strait of Messina',
    points: [
      [15.6, 38.35],
      [15.63, 38.22],
      [15.62, 38.1],
      [15.7, 37.95],
    ],
  },
  {
    id: 'oresund',
    name: 'Øresund',
    points: [
      [12.55, 56.15],
      [12.68, 55.9],
      [12.72, 55.7],
      [12.8, 55.55],
      [12.95, 55.35],
    ],
  },
  {
    id: 'great_belt',
    name: 'Great Belt',
    points: [
      [10.85, 56.0],
      [10.9, 55.6],
      [10.85, 55.3],
      [10.9, 55.05],
      [10.95, 54.75],
    ],
  },
  {
    id: 'suez',
    name: 'Suez Canal',
    canal: true,
    points: [
      [32.3, 31.4],
      [32.33, 31.05],
      [32.4, 30.6],
      [32.55, 30.05],
      [32.58, 29.85],
      // Gulf of Suez, too narrow for the 1° grid to hold a node.
      [32.9, 29.3],
      [33.2, 28.7],
      [33.6, 28.1],
      [33.95, 27.6],
    ],
  },
  {
    id: 'panama',
    name: 'Panama Canal',
    canal: true,
    points: [
      [-79.95, 9.45],
      [-79.85, 9.25],
      [-79.65, 9.1],
      [-79.55, 8.95],
      [-79.5, 8.8],
    ],
  },
  {
    id: 'bab_el_mandeb',
    name: 'Bab-el-Mandeb',
    points: [
      [43.0, 13.3],
      [43.25, 12.8],
      [43.35, 12.55],
      [43.7, 12.2],
    ],
  },
  {
    id: 'hormuz',
    name: 'Strait of Hormuz',
    points: [
      [55.4, 26.75],
      [56.0, 26.6],
      [56.45, 26.55],
      [56.85, 26.0],
    ],
  },
  {
    id: 'singapore',
    name: 'Singapore Strait',
    points: [
      [102.8, 0.9],
      [103.4, 1.05],
      [103.85, 1.2],
      [104.3, 1.2],
      [104.7, 1.3],
    ],
  },
  {
    id: 'sunda',
    name: 'Sunda Strait',
    points: [
      [105.85, -5.6],
      [105.65, -5.95],
      [105.45, -6.3],
      [105.2, -6.7],
    ],
  },
  {
    id: 'lombok',
    name: 'Lombok Strait',
    points: [
      [115.8, -8.2],
      [115.75, -8.55],
      [115.7, -8.9],
      [115.7, -9.2],
    ],
  },
  {
    id: 'torres',
    name: 'Torres Strait',
    points: [
      [141.6, -10.2],
      [142.2, -10.1],
      [142.75, -10.3],
      [143.3, -10.5],
      [143.9, -10.7],
    ],
  },
  {
    id: 'tsugaru',
    name: 'Tsugaru Strait',
    points: [
      [140.0, 41.3],
      [140.6, 41.4],
      [141.1, 41.45],
      [141.6, 41.4],
    ],
  },
  {
    id: 'magellan',
    name: 'Strait of Magellan',
    points: [
      [-68.3, -52.4],
      [-69.3, -52.45],
      [-69.75, -52.55],
      [-70.05, -52.65],
      [-70.45, -52.8],
      [-70.6, -53.0],
      [-70.7, -53.2],
      [-70.75, -53.45],
      [-70.8, -53.7],
      [-71.2, -53.9],
      [-71.6, -53.85],
      [-72.0, -53.75],
      [-72.3, -53.6],
      [-72.55, -53.5],
      [-72.8, -53.4],
      [-73.05, -53.3],
      [-73.2, -53.2],
      [-73.4, -53.05],
      [-73.9, -52.9],
      [-74.5, -52.7],
      [-75.0, -52.6],
    ],
  },
  {
    id: 'juan_de_fuca',
    name: 'Strait of Juan de Fuca and Salish Sea',
    points: [
      [-124.9, 48.45],
      [-124.0, 48.35],
      [-123.3, 48.3],
      [-123.2, 48.6],
      [-123.35, 49.0],
      [-122.75, 48.05],
    ],
  },
  {
    id: 'kerch',
    name: 'Kerch Strait',
    points: [
      [36.5, 45.05],
      [36.6, 45.3],
      [36.5, 45.55],
    ],
  },
  {
    id: 'bering',
    name: 'Bering Strait',
    points: [
      [-169.3, 65.3],
      [-168.7, 65.85],
      [-168.4, 66.4],
    ],
  },
  {
    id: 'gulf_of_aqaba',
    name: 'Gulf of Aqaba',
    points: [
      [34.45, 27.85],
      [34.6, 28.2],
      [34.72, 28.65],
      [34.85, 29.1],
      [34.93, 29.45],
    ],
  },
  {
    id: 'tokyo_bay',
    name: 'Uraga Channel and Tokyo Bay',
    points: [
      [139.75, 34.9],
      [139.72, 35.2],
      [139.8, 35.45],
    ],
  },
  {
    id: 'osaka_bay',
    name: 'Kii Channel and Osaka Bay',
    points: [
      [134.95, 33.75],
      [135.1, 34.2],
      [135.25, 34.5],
    ],
  },
  {
    id: 'gulf_of_finland_east',
    name: 'Gulf of Finland, eastern end',
    points: [
      [27.0, 60.05],
      [28.2, 60.1],
      [29.3, 60.05],
      [29.9, 59.98],
    ],
  },
  {
    id: 'beagle_channel',
    name: 'Beagle Channel',
    points: [
      [-66.4, -55.05],
      [-67.2, -54.95],
      [-67.9, -54.88],
      [-68.4, -54.87],
    ],
  },
  {
    id: 'frobisher_bay',
    name: 'Frobisher Bay',
    points: [
      [-65.7, 62.3],
      [-66.8, 62.85],
      [-67.8, 63.35],
      [-68.3, 63.65],
    ],
  },
  {
    id: 'cook_inlet',
    name: 'Cook Inlet',
    points: [
      [-152.3, 59.3],
      [-151.8, 60.0],
      [-151.4, 60.6],
      [-150.9, 61.0],
      [-150.3, 61.15],
    ],
  },
  {
    id: 'chatham_strait',
    name: 'Chatham Strait and Stephens Passage',
    points: [
      [-134.6, 56.6],
      [-134.7, 57.3],
      [-134.8, 57.9],
      [-134.6, 58.2],
      [-134.5, 58.3],
    ],
  },
  {
    id: 'white_sea',
    name: 'White Sea throat and Dvina Bay',
    points: [
      [42.8, 67.6],
      [42.0, 67.0],
      [41.5, 66.5],
      [41.0, 66.1],
      [40.3, 65.8],
      [39.6, 65.3],
      [40.0, 64.9],
      [40.2, 64.8],
    ],
  },
];

// Coastal geometries in the dataset that deliberately have no shore. Keys are dataset names.
export const EXCLUSION_REASONS: Record<string, string> = {
  Antarctica: 'No permanent population or civilian harbour; research stations only.',
  'Ashmore and Cartier Is.': 'Uninhabited reef territory without a harbour.',
  'Br. Indian Ocean Ter.': 'No civilian settlement or public harbour.',
  'Fr. S. Antarctic Lands': 'Uninhabited sub-Antarctic islands; no harbour.',
  'Heard I. and McDonald Is.': 'Uninhabited; no harbour.',
  'S. Geo. and the Is.': 'No permanent population; no public harbour.',
  'Pitcairn Is.': 'No harbour; landing by longboat only.',
  'Indian Ocean Ter.': 'Small Australian external territories; served by the Australian shores.',
  'W. Sahara':
    'The 1:50m dataset draws this Atlantic coast under Morocco (de facto boundaries); Dakhla is catalogued there.',
  'N. Cyprus':
    'Drawn by the dataset as a separate geometry; the island is served by the Cyprus shore.',
  Azerbaijan:
    'Caspian coast only; the Caspian Sea is not connected to the world ocean. Nearest ocean harbour: Batumi.',
  Kazakhstan:
    'Caspian coast only; the Caspian Sea is not connected to the world ocean. Nearest ocean harbour: Bandar Abbas.',
  Turkmenistan:
    'Caspian coast only; the Caspian Sea is not connected to the world ocean. Nearest ocean harbour: Bandar Abbas.',
};

// States with a catalogued shore that the 1:50m dataset has no polygon for (too small).
export const NOT_IN_DATASET = new Set<string>(['Tuvalu']);
