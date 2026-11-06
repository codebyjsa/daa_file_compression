import {
  type MapPreset,
  type MapNode,
  type MapEdge,
  type GeoBoundingBox,
  type NodeCategory,
  type RoadTier,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  computeEuclideanKm,
} from './graphTypes.ts';

/**
 * Deterministic seeded PRNG (Mulberry32) so generated street networks are 100% reproducible.
 */
function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Maps canvas (x, y) in [0..960, 0..600] to geographic (lat, lng) within bbox.
 */
export function canvasToLatLng(
  x: number,
  y: number,
  bbox: GeoBoundingBox
): { lat: number; lng: number } {
  const u = x / CANVAS_WIDTH;
  const v = 1 - y / CANVAS_HEIGHT;
  const lat = Number((bbox.minLat + v * (bbox.maxLat - bbox.minLat)).toFixed(6));
  const lng = Number((bbox.minLng + u * (bbox.maxLng - bbox.minLng)).toFixed(6));
  return { lat, lng };
}

/**
 * Maps geographic (lat, lng) within bbox to canvas (x, y) in [0..960, 0..600].
 */
export function latLngToCanvas(
  lat: number,
  lng: number,
  bbox: GeoBoundingBox
): { x: number; y: number } {
  const u = (lng - bbox.minLng) / Math.max(1e-6, bbox.maxLng - bbox.minLng);
  const v = (lat - bbox.minLat) / Math.max(1e-6, bbox.maxLat - bbox.minLat);
  const x = Number((u * CANVAS_WIDTH).toFixed(1));
  const y = Number(((1 - v) * CANVAS_HEIGHT).toFixed(1));
  return { x, y };
}

interface LandmarkSpec {
  name: string;
  shortCode: string;
  category: NodeCategory;
  targetX: number;
  targetY: number;
  zone: string;
}

/**
 * Assigns named landmarks to the closest generated street intersections.
 */
function attachLandmarks(
  nodes: MapNode[],
  landmarks: LandmarkSpec[]
): { landmarkIds: string[] } {
  const usedIndices = new Set<number>();
  const landmarkIds: string[] = [];

  for (const lm of landmarks) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (usedIndices.has(i)) continue;
      const d = Math.hypot(nodes[i].x - lm.targetX, nodes[i].y - lm.targetY);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    usedIndices.add(bestIdx);
    const node = nodes[bestIdx];
    node.name = lm.name;
    node.shortCode = lm.shortCode;
    node.category = lm.category;
    node.zone = lm.zone;
    node.isLandmark = true;
    landmarkIds.push(node.id);
  }

  return { landmarkIds };
}

/**
 * Ensures 100% of nodes in a city graph belong to a single connected component
 * by bridging any isolated subcomponents at their closest geographic pair.
 */
function ensureSingleConnectedComponent(
  nodes: MapNode[],
  edges: MapEdge[],
  prefix: string
): void {
  if (nodes.length <= 1) return;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  while (true) {
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      adj.get(e.from)?.push(e.to);
      adj.get(e.to)?.push(e.from);
    }

    const visited = new Set<string>();
    const components: string[][] = [];

    for (const n of nodes) {
      if (visited.has(n.id)) continue;
      const comp: string[] = [];
      const queue = [n.id];
      visited.add(n.id);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        comp.push(curr);
        for (const nb of adj.get(curr) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      components.push(comp);
    }

    if (components.length <= 1) break;

    components.sort((a, b) => b.length - a.length);
    const mainSet = new Set(components[0]);
    const otherComp = components[1];

    let bestU: MapNode | null = null;
    let bestV: MapNode | null = null;
    let bestDist = Infinity;

    for (const uId of otherComp) {
      const u = nodeMap.get(uId)!;
      for (const vId of mainSet) {
        const v = nodeMap.get(vId)!;
        const d = Math.hypot(u.x - v.x, u.y - v.y);
        if (d < bestDist) {
          bestDist = d;
          bestU = u;
          bestV = v;
        }
      }
    }

    if (!bestU || !bestV) break;
    edges.push(
      makeStreetEdge(
        `${prefix}-BRIDGE-${edges.length + 1}`,
        bestU,
        bestV,
        'Boulevard Connector',
        'secondary',
        1.03,
        1
      )
    );
  }
}

/**
 * Helper to create a valid undirected street edge with baseDistanceKm >= Euclidean distance
 * so A*'s straight-line heuristic is strictly admissible.
 */
function makeStreetEdge(
  id: string,
  u: MapNode,
  v: MapNode,
  roadName: string,
  roadTier: RoadTier,
  curvatureFactor = 1.04,
  trafficLevel: 1 | 2 | 3 = 1
): MapEdge {
  const euclid = computeEuclideanKm(u, v);
  const baseDistanceKm = Number(
    Math.max(euclid + 0.0005, euclid * curvatureFactor).toFixed(4)
  );
  return {
    id,
    roadName,
    from: u.id,
    to: v.id,
    baseDistanceKm,
    trafficLevel,
    blocked: false,
    roadTier,
  };
}

/**
 * 1. NEW DELHI — Connaught Place & Lutyens Radial Street Network (~850 intersections, ~1,750 streets)
 * Iconic concentric circles + 8 radial avenues + outer Lutyens hexagonal/urban street blocks.
 */
function buildNewDelhiConnaughtPlace(): MapPreset {
  const rand = createSeededRandom(20261106);
  const bbox: GeoBoundingBox = {
    minLat: 28.6165,
    maxLat: 28.6465,
    minLng: 77.1945,
    maxLng: 77.2389,
    centerLat: 28.6315,
    centerLng: 77.2167,
    zoom: 15,
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();

  const cx = 480;
  const cy = 295;

  const addEdgeUnique = (
    u: MapNode,
    v: MapNode,
    roadName: string,
    tier: RoadTier,
    curvature = 1.04,
    traffic: 1 | 2 | 3 = 1
  ) => {
    if (u.id === v.id) return;
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    edges.push(
      makeStreetEdge(
        `ND-E${edges.length + 1}`,
        u,
        v,
        roadName,
        tier,
        curvature,
        traffic
      )
    );
  };

  // Central Rajiv Chowk hub
  const centerPos = canvasToLatLng(cx, cy, bbox);
  const centerNode: MapNode = {
    id: 'ND-N0',
    name: 'Rajiv Chowk Central Park',
    shortCode: 'CP0',
    category: 'hub',
    x: cx,
    y: cy,
    lat: centerPos.lat,
    lng: centerPos.lng,
    zone: 'Inner Circle',
  };
  nodes.push(centerNode);

  // 14 Concentric Rings x 48 Radial Spokes = 672 radial/ring intersections
  const numRings = 14;
  const numSpokes = 48;
  const ringRadii = [
    26, 46, 68, 92, 118, 146, 175, 205, 236, 268, 302, 338, 376, 418,
  ];
  const ringNodes: MapNode[][] = [];

  const radialAvenueNames: Record<number, string> = {
    0: 'Barakhamba Road',
    5: 'Tolstoy Marg',
    10: 'Janpath Avenue',
    15: 'Sansad Marg (Parliament St)',
    20: 'Baba Kharak Singh Marg',
    25: 'Panchkuian Road',
    30: 'Chelmsford Road',
    35: 'Minto Road',
  };

  const ringNames = [
    'Inner Circle (Rajiv Chowk)',
    'Middle Circle CP',
    'Outer Circle (Indira Chowk)',
    'Connaught Lane Ring',
    'Mandir Marg Loop',
    'Tolstoy - Hailey Connector',
    'Ashoka Road Boulevard',
    'Feroze Shah Ring',
    'Copernicus - Sikandra Ring',
    'Akbar Road Hexagonal Loop',
    'Shahjahan Avenue Ring',
    'Prithviraj - Tughlak Ring',
    'Lutyens Outer Boulevard',
    'Ring Road Arterial Bypass',
  ];

  for (let r = 0; r < numRings; r++) {
    const row: MapNode[] = [];
    const baseRadius = ringRadii[r];
    for (let s = 0; s < numSpokes; s++) {
      const angle = (s / numSpokes) * Math.PI * 2;
      // Slight elliptical stretch so it fills 960x600 naturally
      const jitterR = r <= 2 ? 0 : (rand() - 0.5) * 4.5;
      const jitterA = r <= 2 ? 0 : (rand() - 0.5) * 0.018;
      const rx = (baseRadius + jitterR) * 1.12;
      const ry = (baseRadius + jitterR) * 0.88;
      const x = Number((cx + Math.cos(angle + jitterA) * rx).toFixed(1));
      const y = Number((cy + Math.sin(angle + jitterA) * ry).toFixed(1));

      if (x < 24 || x > CANVAS_WIDTH - 24 || y < 24 || y > CANVAS_HEIGHT - 24) {
        continue;
      }

      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const spokeName = radialAvenueNames[s] ?? `Sector Spoke ${s + 1}`;
      const node: MapNode = {
        id: `ND-R${r}-S${s}`,
        name: `${ringNames[r]} & ${spokeName}`,
        shortCode: `R${r}S${s}`,
        category: r <= 2 ? 'commercial' : r % 3 === 0 ? 'hub' : 'residential',
        x,
        y,
        lat,
        lng,
        zone: r <= 2 ? 'Connaught Place' : 'Lutyens Delhi',
      };
      nodes.push(node);
      row.push(node);
    }
    ringNodes.push(row);
  }

  // Add outer urban grid blocks in the corners (Old Delhi North-East / Paharganj West / India Gate East / Chanakyapuri South-West)
  const gridCols = 22;
  const gridRows = 14;
  for (let gx = 0; gx < gridCols; gx++) {
    for (let gy = 0; gy < gridRows; gy++) {
      const x = Number((38 + gx * ((CANVAS_WIDTH - 76) / (gridCols - 1)) + (rand() - 0.5) * 6).toFixed(1));
      const y = Number((34 + gy * ((CANVAS_HEIGHT - 68) / (gridRows - 1)) + (rand() - 0.5) * 6).toFixed(1));
      // Only add where outside the dense inner rings to avoid overlapping inner CP
      const distFromCenter = Math.hypot((x - cx) / 1.12, (y - cy) / 0.88);
      if (distFromCenter < 245) continue;

      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const zone =
        x < cx && y < cy
          ? 'Paharganj & Sadar'
          : x >= cx && y < cy
            ? 'Mandi House & ITO'
            : x < cx && y >= cy
              ? 'Chanakyapuri & Patel Chowk'
              : 'India Gate & Khan Market';

      nodes.push({
        id: `ND-G${gx}-${gy}`,
        name: `${zone} Block ${gx + 1}×${gy + 1}`,
        shortCode: `B${gx}${gy}`,
        category: 'residential',
        x,
        y,
        lat,
        lng,
        zone,
      });
    }
  }

  // Connect center node to inner ring
  const innerRing = ringNodes[0] ?? [];
  for (let i = 0; i < innerRing.length; i += 5) {
    addEdgeUnique(
      centerNode,
      innerRing[i],
      'Rajiv Chowk Inner Radial',
      'primary',
      1.03,
      1
    );
  }

  // Connect nodes along each ring + radial spokes between consecutive rings
  for (let r = 0; r < ringNodes.length; r++) {
    const ring = ringNodes[r];
    const isMajorRing = r === 0 || r === 2 || r === 6 || r === 9 || r === 12;
    const ringTier: RoadTier =
      r === 0 || r === 2 ? 'arterial' : isMajorRing ? 'primary' : 'secondary';

    for (let i = 0; i < ring.length; i++) {
      const curr = ring[i];
      const next = ring[(i + 1) % ring.length];
      // Connect adjacent on ring if reasonably close
      if (Math.hypot(curr.x - next.x, curr.y - next.y) < 95) {
        addEdgeUnique(
          curr,
          next,
          ringNames[r],
          ringTier,
          1.03,
          r === 2 && i % 7 === 0 ? 2 : 1
        );
      }
    }
  }

  // Connect proximity street network across all nodes (k-nearest neighbor planar-like street graph)
  for (let i = 0; i < nodes.length; i++) {
    const u = nodes[i];
    const candidates: Array<{ node: MapNode; dist: number }> = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const v = nodes[j];
      const d = Math.hypot(u.x - v.x, u.y - v.y);
      if (d <= 68) {
        candidates.push({ node: v, dist: d });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const maxDeg = u.id.startsWith('ND-R') ? 4 : 4;
    for (let k = 0; k < Math.min(maxDeg, candidates.length); k++) {
      const v = candidates[k].node;
      // Determine road tier based on alignment with major radial avenues
      const angleU = Math.atan2(u.y - cy, u.x - cx);
      const isRadialArterial =
        Math.abs(Math.sin(angleU * 4)) < 0.16 && candidates[k].dist < 48;
      const tier: RoadTier = isRadialArterial
        ? 'arterial'
        : candidates[k].dist < 34
          ? 'secondary'
          : 'local';
      const roadName = isRadialArterial
        ? 'Radial Boulevard'
        : `${u.zone ?? 'Delhi'} Street`;
      addEdgeUnique(u, v, roadName, tier, 1.04, 1);
    }
  }

  const landmarks: LandmarkSpec[] = [
    {
      name: 'Paharganj Logistics Hub (New Delhi Rly Stn)',
      shortCode: 'NDLS',
      category: 'depot',
      targetX: 250,
      targetY: 110,
      zone: 'Paharganj',
    },
    {
      name: 'Connaught Place Inner Circle (Rajiv Chowk)',
      shortCode: 'CP',
      category: 'hub',
      targetX: 480,
      targetY: 295,
      zone: 'Connaught Place',
    },
    {
      name: 'India Gate Hexagon (Kartavya Path)',
      shortCode: 'IGATE',
      category: 'hub',
      targetX: 760,
      targetY: 425,
      zone: 'India Gate',
    },
    {
      name: 'Parliament House (Sansad Bhawan)',
      shortCode: 'PARL',
      category: 'commercial',
      targetX: 350,
      targetY: 430,
      zone: 'Lutyens Delhi',
    },
    {
      name: 'Mandi House Metro Interchange',
      shortCode: 'MANDI',
      category: 'hub',
      targetX: 735,
      targetY: 270,
      zone: 'Mandi House',
    },
    {
      name: 'Gole Market Roundabout',
      shortCode: 'GOLE',
      category: 'commercial',
      targetX: 260,
      targetY: 275,
      zone: 'Gole Market',
    },
    {
      name: 'RML Hospital Emergency Center',
      shortCode: 'RMLH',
      category: 'hospital',
      targetX: 215,
      targetY: 365,
      zone: 'Lutyens West',
    },
    {
      name: 'Khan Market Express Drop',
      shortCode: 'KHAN',
      category: 'commercial',
      targetX: 660,
      targetY: 535,
      zone: 'Khan Market',
    },
    {
      name: 'Barakhamba Financial Towers',
      shortCode: 'BKRD',
      category: 'commercial',
      targetX: 615,
      targetY: 265,
      zone: 'Connaught Place',
    },
    {
      name: 'Janpath Emporium Plaza',
      shortCode: 'JANP',
      category: 'commercial',
      targetX: 485,
      targetY: 415,
      zone: 'Janpath',
    },
    {
      name: 'ITO Bridge Junction',
      shortCode: 'ITO',
      category: 'gate',
      targetX: 885,
      targetY: 245,
      zone: 'ITO East',
    },
    {
      name: 'Karol Bagh / Jhandewalan Link',
      shortCode: 'JHDW',
      category: 'gate',
      targetX: 85,
      targetY: 195,
      zone: 'West Gate',
    },
  ];

  ensureSingleConnectedComponent(nodes, edges, 'ND');
  const { landmarkIds } = attachLandmarks(nodes, landmarks);

  return {
    id: 'new-delhi-cp',
    name: 'New Delhi — Connaught Place & Lutyens',
    subtitle: `${nodes.length} intersections · ${edges.length} streets · Radial Rings + Hexagonal Grid`,
    badge: 'Radial + Grid (850+ Nodes)',
    cityTag: 'New Delhi, India',
    defaultStartId: landmarkIds[11], // Karol Bagh / West Gate
    defaultEndId: landmarkIds[2], // India Gate Hexagon
    defaultDeliveryStopIds: [
      landmarkIds[0],
      landmarkIds[1],
      landmarkIds[5],
      landmarkIds[8],
      landmarkIds[9],
      landmarkIds[4],
      landmarkIds[2],
    ],
    bbox,
    nodes,
    edges,
  };
}

/**
 * 2. NEW YORK — Midtown Manhattan & Broadway Diagonal (~840 intersections, ~1,720 streets)
 * Iconic rectangular grid of Avenues & Cross-Streets sliced diagonally by Broadway.
 */
function buildNewYorkManhattan(): MapPreset {
  const rand = createSeededRandom(407580);
  const bbox: GeoBoundingBox = {
    minLat: 40.7425,
    maxLat: 40.7735,
    minLng: -74.0065,
    maxLng: -73.9645,
    centerLat: 40.758,
    centerLng: -73.9855,
    zoom: 15,
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();

  const cols = 30; // Cross-street progression / Avenues tilted slightly like real Manhattan
  const rows = 28;
  const grid: MapNode[][] = [];

  const avenueNames = [
    '12th Ave (West Side Hwy)',
    '11th Ave',
    '10th Ave',
    '9th Ave (Columbus)',
    '8th Ave (Central Park W)',
    '7th Ave',
    'Ave of the Americas (6th Ave)',
    '5th Ave',
    'Madison Ave',
    'Park Ave',
    'Lexington Ave',
    '3rd Ave',
    '2nd Ave',
    '1st Ave',
    'FDR Drive',
  ];

  for (let r = 0; r < rows; r++) {
    const rowNodes: MapNode[] = [];
    for (let c = 0; c < cols; c++) {
      // Subtle Manhattan street grid tilt + organic micro-variation
      const baseX = 36 + c * ((CANVAS_WIDTH - 72) / (cols - 1));
      const baseY = 30 + r * ((CANVAS_HEIGHT - 60) / (rows - 1));
      const tiltX = (r - rows / 2) * 0.9;
      const tiltY = (c - cols / 2) * -0.45;
      const x = Number(
        Math.max(
          20,
          Math.min(CANVAS_WIDTH - 20, baseX + tiltX + (rand() - 0.5) * 2.2)
        ).toFixed(1)
      );
      const y = Number(
        Math.max(
          20,
          Math.min(CANVAS_HEIGHT - 20, baseY + tiltY + (rand() - 0.5) * 2.2)
        ).toFixed(1)
      );

      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const stNum = 59 - r;
      const aveName =
        avenueNames[Math.min(avenueNames.length - 1, Math.floor(c / 2))];

      const node: MapNode = {
        id: `NYC-${r}-${c}`,
        name: `W/E ${stNum}th St & ${aveName}`,
        shortCode: `S${stNum}C${c}`,
        category:
          c % 6 === 0 && r % 5 === 0
            ? 'hub'
            : r < 6
              ? 'residential'
              : 'commercial',
        x,
        y,
        lat,
        lng,
        zone:
          r < 8
            ? 'Upper West / Central Park South'
            : r < 18
              ? 'Midtown / Times Square'
              : 'Chelsea & Flatiron',
      };
      nodes.push(node);
      rowNodes.push(node);
    }
    grid.push(rowNodes);
  }

  const addEdge = (
    u: MapNode,
    v: MapNode,
    roadName: string,
    tier: RoadTier,
    curvature = 1.02,
    traffic: 1 | 2 | 3 = 1
  ) => {
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    edges.push(
      makeStreetEdge(
        `NYC-E${edges.length + 1}`,
        u,
        v,
        roadName,
        tier,
        curvature,
        traffic
      )
    );
  };

  // Connect horizontal Cross-Streets & vertical Avenues
  for (let r = 0; r < rows; r++) {
    const stNum = 59 - r;
    const isMajorCrosstown =
      stNum === 57 || stNum === 42 || stNum === 34 || stNum === 23;
    for (let c = 0; c < cols; c++) {
      const u = grid[r][c];
      if (c + 1 < cols) {
        const v = grid[r][c + 1];
        addEdge(
          u,
          v,
          `${stNum}th Street`,
          isMajorCrosstown ? 'arterial' : r % 3 === 0 ? 'primary' : 'local',
          1.02,
          isMajorCrosstown && c > 8 && c < 20 ? 2 : 1
        );
      }
      if (r + 1 < rows) {
        const v = grid[r + 1][c];
        const aveName =
          avenueNames[Math.min(avenueNames.length - 1, Math.floor(c / 2))];
        const isMajorAve = c % 4 === 0 || c === 14 || c === 18;
        addEdge(
          u,
          v,
          aveName,
          isMajorAve ? 'arterial' : 'secondary',
          1.02,
          1
        );
      }
    }
  }

  // Add Broadway Diagonal slicing across Manhattan from Upper West Side (r=0, c=6) to Flatiron/Union Sq (r=27, c=22)
  for (let r = 0; r < rows - 1; r++) {
    const c1 = Math.min(cols - 2, Math.max(1, Math.round(5 + r * 0.62)));
    const c2 = Math.min(cols - 1, Math.max(1, Math.round(5 + (r + 1) * 0.62)));
    addEdge(
      grid[r][c1],
      grid[r + 1][c2],
      'Broadway Boulevard (Diagonal)',
      'arterial',
      1.01,
      1
    );
    if (c1 + 1 < cols) {
      addEdge(
        grid[r][c1 + 1],
        grid[r + 1][c2],
        'Broadway Express Connector',
        'primary',
        1.02,
        1
      );
    }
  }

  const landmarks: LandmarkSpec[] = [
    {
      name: 'Hudson Yards Fulfillment Depot',
      shortCode: 'HUDY',
      category: 'depot',
      targetX: 95,
      targetY: 360,
      zone: 'West Side',
    },
    {
      name: 'Times Square (Broadway & 42nd St)',
      shortCode: 'TSQ',
      category: 'hub',
      targetX: 410,
      targetY: 295,
      zone: 'Midtown',
    },
    {
      name: 'Grand Central Terminal (42nd & Park)',
      shortCode: 'GCT',
      category: 'hub',
      targetX: 615,
      targetY: 295,
      zone: 'Midtown East',
    },
    {
      name: 'Columbus Circle (59th & Broadway)',
      shortCode: 'COLC',
      category: 'hub',
      targetX: 290,
      targetY: 55,
      zone: 'Upper West',
    },
    {
      name: 'Penn Station & Madison Square Garden',
      shortCode: 'PENN',
      category: 'hub',
      targetX: 345,
      targetY: 420,
      zone: 'Midtown South',
    },
    {
      name: 'Empire State Building (34th & 5th Ave)',
      shortCode: 'ESB',
      category: 'commercial',
      targetX: 510,
      targetY: 415,
      zone: 'Herald Square',
    },
    {
      name: 'Rockefeller Center (50th & 5th Ave)',
      shortCode: 'ROCK',
      category: 'commercial',
      targetX: 520,
      targetY: 185,
      zone: 'Midtown Center',
    },
    {
      name: 'NYU Langone Medical Center (1st Ave)',
      shortCode: 'NYUL',
      category: 'hospital',
      targetX: 855,
      targetY: 430,
      zone: 'Kips Bay East',
    },
    {
      name: 'United Nations HQ (45th & 1st Ave)',
      shortCode: 'UNHQ',
      category: 'commercial',
      targetX: 870,
      targetY: 255,
      zone: 'Turtle Bay',
    },
    {
      name: 'Flatiron District (23rd & Broadway)',
      shortCode: 'FLAT',
      category: 'commercial',
      targetX: 595,
      targetY: 545,
      zone: 'Flatiron',
    },
  ];

  const { landmarkIds } = attachLandmarks(nodes, landmarks);

  return {
    id: 'nyc-manhattan',
    name: 'New York — Midtown Manhattan & Broadway',
    subtitle: `${nodes.length} intersections · ${edges.length} streets · Orthogonal Grid + Broadway Diagonal`,
    badge: 'Manhattan Grid (840 Nodes)',
    cityTag: 'New York, USA',
    defaultStartId: landmarkIds[0], // Hudson Yards
    defaultEndId: landmarkIds[8], // UN HQ East Side
    defaultDeliveryStopIds: [
      landmarkIds[0],
      landmarkIds[3],
      landmarkIds[6],
      landmarkIds[1],
      landmarkIds[2],
      landmarkIds[5],
      landmarkIds[9],
    ],
    bbox,
    nodes,
    edges,
  };
}

/**
 * 3. PARIS — Place Charles de Gaulle / Arc de Triomphe 12-Avenue Star (~830 intersections, ~1,710 streets)
 * 12 grand Haussmann avenues radiating from the Arc de Triomphe + dense Parisian street blocks.
 */
function buildParisEtoile(): MapPreset {
  const rand = createSeededRandom(488738);
  const bbox: GeoBoundingBox = {
    minLat: 48.8608,
    maxLat: 48.8868,
    minLng: 2.273,
    maxLng: 2.317,
    centerLat: 48.8738,
    centerLng: 2.295,
    zoom: 15,
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();

  const cx = 465;
  const cy = 295;

  const addEdge = (
    u: MapNode,
    v: MapNode,
    roadName: string,
    tier: RoadTier,
    curvature = 1.03
  ) => {
    if (u.id === v.id) return;
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    edges.push(
      makeStreetEdge(`PAR-E${edges.length + 1}`, u, v, roadName, tier, curvature)
    );
  };

  const centerCoords = canvasToLatLng(cx, cy, bbox);
  const arcNode: MapNode = {
    id: 'PAR-ARC',
    name: 'Arc de Triomphe (Place Charles de Gaulle)',
    shortCode: 'ARC',
    category: 'hub',
    x: cx,
    y: cy,
    lat: centerCoords.lat,
    lng: centerCoords.lng,
    zone: 'Place de l’Étoile',
  };
  nodes.push(arcNode);

  const twelveAvenues = [
    'Avenue des Champs-Élysées',
    'Avenue Marceau',
    'Avenue d’Iéna',
    'Avenue Kléber',
    'Avenue Victor Hugo',
    'Avenue Foch',
    'Avenue de la Grande Armée',
    'Avenue Carnot',
    'Avenue Mac-Mahon',
    'Avenue de Wagram',
    'Avenue Hoche',
    'Avenue de Friedland',
  ];

  // 13 concentric Haussmann rings x 54 angular divisions
  const numRings = 13;
  const numSpokes = 54;
  const ringNodes: MapNode[][] = [];

  for (let r = 0; r < numRings; r++) {
    const radius = 28 + r * 31;
    const ring: MapNode[] = [];
    for (let s = 0; s < numSpokes; s++) {
      const angle = (s / numSpokes) * Math.PI * 2;
      const isGrandAvenue = s % 4 === 0;
      const jitter = isGrandAvenue ? 0 : (rand() - 0.5) * 5;
      const x = Number((cx + Math.cos(angle) * (radius * 1.15 + jitter)).toFixed(1));
      const y = Number((cy + Math.sin(angle) * (radius * 0.9 + jitter)).toFixed(1));
      if (x < 22 || x > CANVAS_WIDTH - 22 || y < 22 || y > CANVAS_HEIGHT - 22) {
        continue;
      }
      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const aveIdx = Math.floor(s / 4) % 12;
      const node: MapNode = {
        id: `PAR-R${r}-S${s}`,
        name: isGrandAvenue
          ? `${twelveAvenues[aveIdx]} (Sec ${r + 1})`
          : `Rue Haussmann Block ${r + 1}-${s + 1}`,
        shortCode: `P${r}_${s}`,
        category: isGrandAvenue ? 'commercial' : 'residential',
        x,
        y,
        lat,
        lng,
        zone: '8th / 16th / 17th Arr.',
      };
      nodes.push(node);
      ring.push(node);
    }
    ringNodes.push(ring);
  }

  // Fill outer corners with Parisian street intersections
  for (let gx = 0; gx < 20; gx++) {
    for (let gy = 0; gy < 13; gy++) {
      const x = Number((35 + gx * 46 + (rand() - 0.5) * 7).toFixed(1));
      const y = Number((35 + gy * 44 + (rand() - 0.5) * 7).toFixed(1));
      const d = Math.hypot((x - cx) / 1.15, (y - cy) / 0.9);
      if (d < 290) continue;
      const { lat, lng } = canvasToLatLng(x, y, bbox);
      nodes.push({
        id: `PAR-G${gx}-${gy}`,
        name: `Boulevard Périphérique Block ${gx}-${gy}`,
        shortCode: `BP${gx}${gy}`,
        category: 'residential',
        x,
        y,
        lat,
        lng,
        zone: 'Outer Arrondissements',
      });
    }
  }

  // Connect Arc de Triomphe to the 12 Grand Avenues on Ring 0
  for (let i = 0; i < (ringNodes[0]?.length ?? 0); i += 4) {
    addEdge(arcNode, ringNodes[0][i], twelveAvenues[(i / 4) % 12], 'arterial', 1.01);
  }

  // Connect nearest neighbors to form the 12-avenue star + Haussmann blocks
  for (let i = 0; i < nodes.length; i++) {
    const u = nodes[i];
    const candidates: Array<{ node: MapNode; dist: number }> = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const v = nodes[j];
      const d = Math.hypot(u.x - v.x, u.y - v.y);
      if (d <= 65) candidates.push({ node: v, dist: d });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    for (let k = 0; k < Math.min(4, candidates.length); k++) {
      const v = candidates[k].node;
      const isAvenue =
        u.name.startsWith('Avenue') && v.name.startsWith('Avenue');
      addEdge(
        u,
        v,
        isAvenue ? u.name.split(' (')[0] : 'Rue de Paris',
        isAvenue ? 'arterial' : candidates[k].dist < 33 ? 'secondary' : 'local',
        1.03
      );
    }
  }

  const landmarks: LandmarkSpec[] = [
    {
      name: 'Porte Maillot Logistics Hub',
      shortCode: 'PMAI',
      category: 'depot',
      targetX: 115,
      targetY: 185,
      zone: 'Neuilly / Maillot',
    },
    {
      name: 'Arc de Triomphe (Place de l’Étoile)',
      shortCode: 'ETOI',
      category: 'hub',
      targetX: 465,
      targetY: 295,
      zone: 'Place de l’Étoile',
    },
    {
      name: 'Rond-Point des Champs-Élysées',
      shortCode: 'CHAM',
      category: 'commercial',
      targetX: 790,
      targetY: 425,
      zone: '8th Arrondissement',
    },
    {
      name: 'Place du Trocadéro',
      shortCode: 'TROC',
      category: 'hub',
      targetX: 315,
      targetY: 515,
      zone: '16th Arrondissement',
    },
    {
      name: 'Parc Monceau Boulevard',
      shortCode: 'MONC',
      category: 'commercial',
      targetX: 735,
      targetY: 135,
      zone: '8th Arrondissement',
    },
    {
      name: 'Place des Ternes Market',
      shortCode: 'TERN',
      category: 'commercial',
      targetX: 555,
      targetY: 145,
      zone: '17th Arrondissement',
    },
    {
      name: 'Hôpital Beaujon / Bichat Link',
      shortCode: 'HOSP',
      category: 'hospital',
      targetX: 845,
      targetY: 95,
      zone: '17th North',
    },
    {
      name: 'Pont de l’Alma (Seine Crossing)',
      shortCode: 'ALMA',
      category: 'gate',
      targetX: 585,
      targetY: 535,
      zone: 'Seine Riverfront',
    },
  ];

  ensureSingleConnectedComponent(nodes, edges, 'PAR');
  const { landmarkIds } = attachLandmarks(nodes, landmarks);

  return {
    id: 'paris-etoile',
    name: 'Paris — Arc de Triomphe 12-Avenue Star',
    subtitle: `${nodes.length} intersections · ${edges.length} streets · 12 Radial Haussmann Avenues`,
    badge: '12-Star Radial (830+ Nodes)',
    cityTag: 'Paris, France',
    defaultStartId: landmarkIds[0], // Porte Maillot
    defaultEndId: landmarkIds[2], // Champs-Élysées
    defaultDeliveryStopIds: [
      landmarkIds[0],
      landmarkIds[5],
      landmarkIds[4],
      landmarkIds[1],
      landmarkIds[2],
      landmarkIds[7],
      landmarkIds[3],
    ],
    bbox,
    nodes,
    edges,
  };
}

/**
 * 4. BENGALURU — MG Road & Indiranagar High-Density Delivery Grid (~840 intersections, ~1,690 streets)
 */
function buildBengaluruGrid(): MapPreset {
  const rand = createSeededRandom(129716);
  const bbox: GeoBoundingBox = {
    minLat: 12.9576,
    maxLat: 12.9856,
    minLng: 77.6192,
    maxLng: 77.6632,
    centerLat: 12.9716,
    centerLng: 77.6412,
    zoom: 15,
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();

  const cols = 30;
  const rows = 28;
  const grid: MapNode[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: MapNode[] = [];
    for (let c = 0; c < cols; c++) {
      // Organic neighborhood block warp (Ulsoor / Indiranagar / Domlur / MG Road)
      const waveX = Math.sin(r * 0.35) * 5 + (rand() - 0.5) * 4;
      const waveY = Math.cos(c * 0.3) * 5 + (rand() - 0.5) * 4;
      const x = Number(
        (34 + c * ((CANVAS_WIDTH - 68) / (cols - 1)) + waveX).toFixed(1)
      );
      const y = Number(
        (30 + r * ((CANVAS_HEIGHT - 60) / (rows - 1)) + waveY).toFixed(1)
      );
      const { lat, lng } = canvasToLatLng(x, y, bbox);

      const node: MapNode = {
        id: `BLR-${r}-${c}`,
        name: `${r + 1}th Cross & ${c + 1}th Main Rd`,
        shortCode: `C${r}M${c}`,
        category: c === 18 || r === 12 ? 'commercial' : 'residential',
        x,
        y,
        lat,
        lng,
        zone:
          c < 10
            ? 'MG Road & Ulsoor'
            : r < 14
              ? 'Indiranagar 100ft Grid'
              : 'Domlur & Old Airport Rd',
      };
      nodes.push(node);
      row.push(node);
    }
    grid.push(row);
  }

  const addEdge = (
    u: MapNode,
    v: MapNode,
    roadName: string,
    tier: RoadTier,
    traffic: 1 | 2 | 3 = 1
  ) => {
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    edges.push(
      makeStreetEdge(`BLR-E${edges.length + 1}`, u, v, roadName, tier, 1.03, traffic)
    );
  };

  for (let r = 0; r < rows; r++) {
    const isCMHOrOldAirport = r === 9 || r === 21;
    for (let c = 0; c < cols; c++) {
      const u = grid[r][c];
      const is100FtOr80Ft = c === 11 || c === 20;
      if (c + 1 < cols) {
        addEdge(
          u,
          grid[r][c + 1],
          r === 9
            ? 'CMH Road (Purple Line Corridor)'
            : r === 21
              ? 'Old Airport Road Arterial'
              : `${r + 1}th Cross Road`,
          isCMHOrOldAirport ? 'arterial' : r % 4 === 0 ? 'primary' : 'local',
          isCMHOrOldAirport && c > 8 && c < 18 ? 2 : 1
        );
      }
      if (r + 1 < rows) {
        addEdge(
          u,
          grid[r + 1][c],
          c === 20
            ? '100 Feet Road Indiranagar'
            : c === 11
              ? '80 Feet Road'
              : `${c + 1}th Main Road`,
          is100FtOr80Ft ? 'arterial' : c % 5 === 0 ? 'secondary' : 'local',
          1
        );
      }
      // Diagonal shortcuts along Old Madras Road / Intermediate Ring Road
      if (r + 1 < rows && c + 1 < cols && (r + c) % 7 === 0) {
        addEdge(
          u,
          grid[r + 1][c + 1],
          'Link Road Shortcut',
          'secondary',
          1
        );
      }
    }
  }

  const landmarks: LandmarkSpec[] = [
    {
      name: 'MG Road Trinity Dark-Store Depot',
      shortCode: 'MGRD',
      category: 'depot',
      targetX: 115,
      targetY: 285,
      zone: 'MG Road',
    },
    {
      name: 'Indiranagar Metro & CMH Junction',
      shortCode: 'IMET',
      category: 'hub',
      targetX: 560,
      targetY: 205,
      zone: 'Indiranagar',
    },
    {
      name: '100 Feet Road & 12th Main Plaza',
      shortCode: '100F',
      category: 'commercial',
      targetX: 645,
      targetY: 335,
      zone: 'Indiranagar South',
    },
    {
      name: 'Manipal Hospital (Old Airport Rd)',
      shortCode: 'MANI',
      category: 'hospital',
      targetX: 790,
      targetY: 465,
      zone: 'Old Airport Road',
    },
    {
      name: 'Domlur Flyover Tech Park',
      shortCode: 'DOML',
      category: 'hub',
      targetX: 545,
      targetY: 485,
      zone: 'Domlur',
    },
    {
      name: 'Ulsoor Lake North Gate',
      shortCode: 'ULSR',
      category: 'hub',
      targetX: 245,
      targetY: 115,
      zone: 'Ulsoor',
    },
    {
      name: 'Bagmane Tech Park Backgate',
      shortCode: 'BAGM',
      category: 'academic',
      targetX: 865,
      targetY: 135,
      zone: 'CV Raman Nagar',
    },
  ];

  const { landmarkIds } = attachLandmarks(nodes, landmarks);

  return {
    id: 'bengaluru-grid',
    name: 'Bengaluru — MG Road & Indiranagar Grid',
    subtitle: `${nodes.length} intersections · ${edges.length} streets · 100ft Rd + Neighborhood Crosses`,
    badge: 'Delivery Grid (840 Nodes)',
    cityTag: 'Bengaluru, India',
    defaultStartId: landmarkIds[0], // MG Road Depot
    defaultEndId: landmarkIds[6], // Bagmane Tech Park
    defaultDeliveryStopIds: [
      landmarkIds[0],
      landmarkIds[5],
      landmarkIds[1],
      landmarkIds[2],
      landmarkIds[4],
      landmarkIds[3],
      landmarkIds[6],
    ],
    bbox,
    nodes,
    edges,
  };
}

export const CITY_STREET_PRESETS: MapPreset[] = [
  buildNewDelhiConnaughtPlace(),
  buildNewYorkManhattan(),
  buildParisEtoile(),
  buildBengaluruGrid(),
];
