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
import { latLngToCanvas, canvasToLatLng } from './cityStreetGraphs.ts';

export interface NominatimSearchResult {
  placeId: string;
  name: string;
  fullAddress: string;
  lat: number;
  lng: number;
  type: string;
}

interface RawNominatimItem {
  place_id: number | string;
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
}

interface OverpassElement {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

interface OSRMRouteResponse {
  code?: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry?: {
      coordinates: Array<[number, number]>; // [lng, lat]
    };
    legs?: Array<{
      steps?: Array<{
        name?: string;
        distance?: number;
        maneuver?: {
          location?: [number, number];
        };
      }>;
    }>;
  }>;
}

function classifyRoadTier(highwayTag: string): RoadTier {
  if (
    highwayTag === 'motorway' ||
    highwayTag === 'trunk' ||
    highwayTag === 'primary' ||
    highwayTag === 'primary_link'
  ) {
    return 'arterial';
  }
  if (highwayTag === 'secondary' || highwayTag === 'secondary_link') {
    return 'primary';
  }
  if (highwayTag === 'tertiary' || highwayTag === 'unclassified') {
    return 'secondary';
  }
  return 'local';
}

/**
 * Computes Haversine real-world geographic distance in km between two (lat, lng) points.
 */
export function computeHaversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(4));
}

/**
 * Computes an appropriate slippy map zoom level (4..16) that fits a given lat/lng span.
 */
export function computeZoomForSpan(latSpan: number, lngSpan: number): number {
  const maxSpan = Math.max(latSpan * 1.3, lngSpan);
  if (maxSpan <= 0.025) return 15;
  if (maxSpan <= 0.055) return 14;
  if (maxSpan <= 0.12) return 13;
  if (maxSpan <= 0.25) return 12;
  if (maxSpan <= 0.55) return 11;
  if (maxSpan <= 1.2) return 10;
  if (maxSpan <= 2.5) return 9;
  return 8;
}

/**
 * Searches OpenStreetMap Nominatim for any address, landmark, campus, or city on Earth.
 */
export async function searchOpenStreetMapPlaces(
  query: string
): Promise<NominatimSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`OpenStreetMap search returned HTTP ${res.status}`);
  }
  const items = (await res.json()) as RawNominatimItem[];
  return (items ?? []).map((item) => {
    const parts = item.display_name.split(',').map((s) => s.trim());
    const shortName = item.name || parts[0] || trimmed;
    return {
      placeId: String(item.place_id),
      name: shortName,
      fullAddress: parts.slice(0, 4).join(', '),
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      type: item.type || item.class || 'location',
    };
  });
}

/**
 * Reverse-geocodes a clicked (lat, lng) coordinate using OpenStreetMap Nominatim.
 */
export async function reverseGeocodeOpenStreetMap(
  lat: number,
  lng: number
): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return `Custom Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    const data = (await res.json()) as {
      name?: string;
      display_name?: string;
      address?: Record<string, string>;
    };
    if (data.name) return data.name;
    if (data.address) {
      const road =
        data.address.road ||
        data.address.pedestrian ||
        data.address.suburb ||
        data.address.neighbourhood;
      const area =
        data.address.Suburb ||
        data.address.city_district ||
        data.address.city ||
        data.address.town;
      if (road && area) return `${road}, ${area}`;
      if (road) return road;
    }
    if (data.display_name) {
      return data.display_name.split(',').slice(0, 2).join(', ').trim();
    }
  } catch {
    // Fallback if offline
  }
  return `Custom Pin (${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E)`;
}

/**
 * Fetches real OpenStreetMap driving route geometry and alternative road paths between two (lat, lng) points
 * using the free public OSRM routing server (https://router.project-osrm.org).
 */
async function fetchOSRMRoadPaths(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number
): Promise<
  Array<{
    coords: Array<{ lat: number; lng: number }>;
    roadNames: string[];
  }>
> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng.toFixed(6)},${startLat.toFixed(6)};${endLng.toFixed(6)},${endLat.toFixed(6)}?overview=full&geometries=geojson&alternatives=true&steps=true`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as OSRMRouteResponse;
    if (!data.routes || data.routes.length === 0) return [];

    return data.routes.map((route) => {
      const rawCoords = route.geometry?.coordinates ?? [];
      // Sample up to ~55 road geometry points along the real OSM route
      const step = Math.max(1, Math.floor(rawCoords.length / 55));
      const sampled: Array<{ lat: number; lng: number }> = [];
      for (let i = 0; i < rawCoords.length; i += step) {
        sampled.push({ lat: rawCoords[i][1], lng: rawCoords[i][0] });
      }
      if (rawCoords.length > 0) {
        const last = rawCoords[rawCoords.length - 1];
        sampled.push({ lat: last[1], lng: last[0] });
      }

      const roadNames: string[] = [];
      for (const leg of route.legs ?? []) {
        for (const st of leg.steps ?? []) {
          if (st.name && st.name.trim()) {
            roadNames.push(st.name.trim());
          }
        }
      }
      return {
        coords: sampled,
        roadNames:
          roadNames.length > 0 ? roadNames : ['OpenStreetMap Primary Route'],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Injects a user-created Custom Location into the current graph when it is inside the current bounding box.
 */
export function addCustomNodeToNetwork(
  bbox: GeoBoundingBox,
  nodes: MapNode[],
  edges: MapEdge[],
  params: {
    name: string;
    lat: number;
    lng: number;
    category?: NodeCategory;
    zone?: string;
  }
): {
  newNode: MapNode;
  updatedNodes: MapNode[];
  updatedEdges: MapEdge[];
} {
  const { x, y } = latLngToCanvas(params.lat, params.lng, bbox);
  const customIndex =
    nodes.filter((n) => n.id.startsWith('CUSTOM-')).length + 1;
  const shortCode = `P${customIndex}`;
  const newNode: MapNode = {
    id: `CUSTOM-${Date.now()}-${customIndex}`,
    name: params.name.trim() || `Custom Location #${customIndex}`,
    shortCode,
    category: params.category ?? 'commercial',
    x,
    y,
    lat: Number(params.lat.toFixed(6)),
    lng: Number(params.lng.toFixed(6)),
    zone: params.zone ?? 'Custom Pin',
    isLandmark: true,
  };

  // Connect the custom location to the 4 nearest existing street intersections
  const nearest = [...nodes]
    .map((n) => ({
      node: n,
      dist: Math.hypot(n.x - newNode.x, n.y - newNode.y),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);

  const newEdges: MapEdge[] = [];
  for (let i = 0; i < nearest.length; i++) {
    const target = nearest[i].node;
    const euclid = computeEuclideanKm(newNode, target);
    newEdges.push({
      id: `CUSTOM-E-${Date.now()}-${i + 1}`,
      roadName: `${newNode.name} Access Rd`,
      from: newNode.id,
      to: target.id,
      baseDistanceKm: Number(
        Math.max(euclid + 0.0005, euclid * 1.03).toFixed(4)
      ),
      trafficLevel: 1,
      blocked: false,
      roadTier: 'secondary',
    });
  }

  return {
    newNode,
    updatedNodes: [newNode, ...nodes],
    updatedEdges: [...edges, ...newEdges],
  };
}

/**
 * Builds a full-coverage street network spanning ANY distance between Start (A), Target (B),
 * and any additional custom locations, weaving in real OpenStreetMap OSRM road geometry
 * so the search wave expands across the ENTIRE distance from A to B without ever being cut off!
 */
export async function buildSpanningNetworkForLocations(params: {
  startPoint: { name: string; lat: number; lng: number };
  endPoint: { name: string; lat: number; lng: number };
  extraStops?: Array<{ name: string; lat: number; lng: number }>;
  areaTitle?: string;
}): Promise<MapPreset> {
  const allPts = [
    params.startPoint,
    params.endPoint,
    ...(params.extraStops ?? []),
  ];

  let minPtlLat = Infinity;
  let maxPtlLat = -Infinity;
  let minPtlLng = Infinity;
  let maxPtlLng = -Infinity;

  for (const pt of allPts) {
    if (pt.lat < minPtlLat) minPtlLat = pt.lat;
    if (pt.lat > maxPtlLat) maxPtlLat = pt.lat;
    if (pt.lng < minPtlLng) minPtlLng = pt.lng;
    if (pt.lng > maxPtlLng) maxPtlLng = pt.lng;
  }

  const centerLat = Number(((minPtlLat + maxPtlLat) / 2).toFixed(6));
  const centerLng = Number(((minPtlLng + maxPtlLng) / 2).toFixed(6));

  // Ensure generous margin (at least 60% around the A..B span) so the search wave floods the entire map around A and B!
  const rawLatDiff = Math.max(0.014, maxPtlLat - minPtlLat);
  const rawLngDiff = Math.max(0.022, maxPtlLng - minPtlLng);

  // Keep aspect ratio matched with 16:10 canvas
  const cosLat = Math.max(0.35, Math.cos((centerLat * Math.PI) / 180));
  const effectiveLatSpan = Math.max(rawLatDiff * 1.85, (rawLngDiff * cosLat) * 1.2);
  const effectiveLngSpan = Math.max(
    rawLngDiff * 1.85,
    (effectiveLatSpan / cosLat) * 1.55
  );

  const bbox: GeoBoundingBox = {
    minLat: Number((centerLat - effectiveLatSpan / 2).toFixed(6)),
    maxLat: Number((centerLat + effectiveLatSpan / 2).toFixed(6)),
    minLng: Number((centerLng - effectiveLngSpan / 2).toFixed(6)),
    maxLng: Number((centerLng + effectiveLngSpan / 2).toFixed(6)),
    centerLat,
    centerLng,
    zoom: computeZoomForSpan(effectiveLatSpan, effectiveLngSpan),
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();
  const shortTitle =
    params.areaTitle ||
    `${params.startPoint.name.split(',')[0]} ↔ ${params.endPoint.name.split(',')[0]}`;

  // 1. Generate dense full-viewport street network (32 x 28 = 896 intersections) covering the ENTIRE region from A to B and beyond!
  const cols = 32;
  const rows = 28;
  const grid: MapNode[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: MapNode[] = [];
    for (let c = 0; c < cols; c++) {
      const waveX = Math.sin(r * 0.45 + c * 0.25) * 4.5;
      const waveY = Math.cos(c * 0.4 + r * 0.2) * 4.5;
      const x = Number(
        (28 + c * ((CANVAS_WIDTH - 56) / (cols - 1)) + waveX).toFixed(1)
      );
      const y = Number(
        (26 + r * ((CANVAS_HEIGHT - 52) / (rows - 1)) + waveY).toFixed(1)
      );
      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const node: MapNode = {
        id: `SPAN-${r}-${c}`,
        name: `${shortTitle} Jct ${r + 1}×${c + 1}`,
        shortCode: `J${r}_${c}`,
        category: c % 6 === 0 || r % 5 === 0 ? 'commercial' : 'residential',
        x,
        y,
        lat,
        lng,
        zone: shortTitle,
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
    curvature = 1.03
  ) => {
    if (u.id === v.id) return;
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    const euclid = computeEuclideanKm(u, v);
    const baseDistanceKm = Number(
      Math.max(euclid + 0.0005, euclid * curvature).toFixed(4)
    );
    edges.push({
      id: `SPAN-E${edges.length + 1}`,
      roadName,
      from: u.id,
      to: v.id,
      baseDistanceKm,
      trafficLevel: 1,
      blocked: false,
      roadTier: tier,
    });
  };

  for (let r = 0; r < rows; r++) {
    const isArterialRow = r % 6 === 0;
    for (let c = 0; c < cols; c++) {
      const u = grid[r][c];
      const isArterialCol = c % 6 === 0;
      if (c + 1 < cols) {
        addEdge(
          u,
          grid[r][c + 1],
          isArterialRow ? 'East-West Arterial Highway' : `Sector Street ${r + 1}`,
          isArterialRow ? 'arterial' : r % 3 === 0 ? 'primary' : 'local',
          isArterialRow ? 1.01 : 1.04
        );
      }
      if (r + 1 < rows) {
        addEdge(
          u,
          grid[r + 1][c],
          isArterialCol ? 'North-South Trunk Road' : `Cross Avenue ${c + 1}`,
          isArterialCol ? 'arterial' : c % 3 === 0 ? 'secondary' : 'local',
          isArterialCol ? 1.01 : 1.04
        );
      }
      if (r + 1 < rows && c + 1 < cols && (r + c) % 4 === 0) {
        addEdge(
          u,
          grid[r + 1][c + 1],
          'Diagonal Link Road',
          'secondary',
          1.03
        );
      }
      if (r + 1 < rows && c - 1 >= 0 && (r - c + 30) % 5 === 0) {
        addEdge(
          u,
          grid[r + 1][c - 1],
          'Radial Connector Road',
          'secondary',
          1.03
        );
      }
    }
  }

  // 2. Fetch real OpenStreetMap OSRM driving route geometry between Start (A) and End (B) and weave it into the street network!
  const osrmRoutes = await fetchOSRMRoadPaths(
    params.startPoint.lat,
    params.startPoint.lng,
    params.endPoint.lat,
    params.endPoint.lng
  );

  // Snap Start (A) and End (B) and any extra stops into the network
  const createPinnedNode = (
    pt: { name: string; lat: number; lng: number },
    code: string,
    cat: NodeCategory
  ): MapNode => {
    const { x, y } = latLngToCanvas(pt.lat, pt.lng, bbox);
    const node: MapNode = {
      id: `CUSTOM-PIN-${code}-${Date.now()}`,
      name: pt.name,
      shortCode: code,
      category: cat,
      x,
      y,
      lat: Number(pt.lat.toFixed(6)),
      lng: Number(pt.lng.toFixed(6)),
      zone: shortTitle,
      isLandmark: true,
    };
    nodes.unshift(node);

    // Connect pin to 4 nearest grid intersections
    const nearest = [...nodes]
      .filter((n) => n.id !== node.id)
      .map((n) => ({ n, d: Math.hypot(n.x - node.x, n.y - node.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);

    for (const item of nearest) {
      addEdge(node, item.n, `${pt.name} Access Rd`, 'primary', 1.01);
    }
    return node;
  };

  const startNode = createPinnedNode(params.startPoint, 'ORIG', 'depot');
  const endNode = createPinnedNode(params.endPoint, 'DEST', 'hub');

  // Weave OSRM real road waypoints into the graph so the optimal path follows the exact OpenStreetMap road curves!
  for (let rIdx = 0; rIdx < osrmRoutes.length; rIdx++) {
    const route = osrmRoutes[rIdx];
    const pts = route.coords;
    if (pts.length < 2) continue;

    let prevNode: MapNode = startNode;
    for (let i = 1; i < pts.length - 1; i++) {
      const pt = pts[i];
      const { x, y } = latLngToCanvas(pt.lat, pt.lng, bbox);
      // Find closest existing intersection within 14px or create a real-road waypoint node
      let wpNode: MapNode | null = null;
      let bestDist = 14;
      for (const existing of nodes) {
        if (existing.id === startNode.id || existing.id === endNode.id) continue;
        const d = Math.hypot(existing.x - x, existing.y - y);
        if (d < bestDist) {
          bestDist = d;
          wpNode = existing;
        }
      }
      const roadLabel =
        route.roadNames[Math.min(route.roadNames.length - 1, Math.floor((i / pts.length) * route.roadNames.length))] ||
        'OpenStreetMap Highway';

      if (!wpNode) {
        wpNode = {
          id: `OSRM-WP-${rIdx}-${i}`,
          name: `${roadLabel} Waypoint`,
          shortCode: `W${i}`,
          category: 'commercial',
          x,
          y,
          lat: Number(pt.lat.toFixed(6)),
          lng: Number(pt.lng.toFixed(6)),
          zone: roadLabel,
        };
        nodes.push(wpNode);
        // Connect OSRM waypoint to 2 nearest grid intersections so the search wave flows naturally between the highway and side streets!
        const sideNeighbors = [...grid.flat()]
          .map((gn) => ({ gn, d: Math.hypot(gn.x - x, gn.y - y) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 2);
        for (const sn of sideNeighbors) {
          addEdge(wpNode, sn.gn, `${roadLabel} Cross St`, 'secondary', 1.03);
        }
      }

      addEdge(
        prevNode,
        wpNode,
        roadLabel,
        rIdx === 0 ? 'arterial' : 'primary',
        rIdx === 0 ? 1.002 : 1.015
      );
      prevNode = wpNode;
    }

    addEdge(
      prevNode,
      endNode,
      route.roadNames[route.roadNames.length - 1] ?? 'OpenStreetMap Highway',
      rIdx === 0 ? 'arterial' : 'primary',
      rIdx === 0 ? 1.002 : 1.015
    );
  }

  // Add extra stops if provided
  const stopNodeIds: string[] = [startNode.id];
  for (let i = 0; i < (params.extraStops ?? []).length; i++) {
    const sn = createPinnedNode(
      params.extraStops![i],
      `S${i + 1}`,
      'commercial'
    );
    stopNodeIds.push(sn.id);
  }
  stopNodeIds.push(endNode.id);

  // Also mark 5 intermediate landmarks across the span
  const intermediateTargets = [
    { x: 480, y: 295, label: 'Midway Junction', code: 'MID' },
    { x: 240, y: 180, label: 'North-West Sector', code: 'NW' },
    { x: 720, y: 420, label: 'South-East Sector', code: 'SE' },
    { x: 700, y: 180, label: 'North-East Sector', code: 'NE' },
    { x: 260, y: 420, label: 'South-West Sector', code: 'SW' },
  ];
  for (const tgt of intermediateTargets) {
    let best = grid[0][0];
    let bestD = Infinity;
    for (const n of grid.flat()) {
      if (n.isLandmark) continue;
      const d = Math.hypot(n.x - tgt.x, n.y - tgt.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    best.isLandmark = true;
    best.shortCode = tgt.code;
    best.name = `${tgt.label} (${shortTitle})`;
    if (stopNodeIds.length < 7) {
      stopNodeIds.push(best.id);
    }
  }

  return {
    id: `osm-span-${Date.now()}`,
    name: shortTitle,
    subtitle: `${nodes.length} intersections · ${edges.length} streets · Full-Span OpenStreetMap Wave`,
    badge: `${shortTitle} (${nodes.length} Nodes)`,
    cityTag: shortTitle,
    defaultStartId: startNode.id,
    defaultEndId: endNode.id,
    defaultDeliveryStopIds: stopNodeIds,
    bbox,
    nodes,
    edges,
  };
}

/**
 * Instant high-density street graph builder for a single (lat, lng) center.
 */
function buildInstantStreetNetworkForBbox(
  bbox: GeoBoundingBox,
  shortTitle: string
): MapPreset {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const edgePairSet = new Set<string>();

  const cols = 30;
  const rows = 26;
  const grid: MapNode[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: MapNode[] = [];
    for (let c = 0; c < cols; c++) {
      const waveX = Math.sin(r * 0.45 + c * 0.2) * 5;
      const waveY = Math.cos(c * 0.4 + r * 0.15) * 5;
      const x = Number(
        (32 + c * ((CANVAS_WIDTH - 64) / (cols - 1)) + waveX).toFixed(1)
      );
      const y = Number(
        (28 + r * ((CANVAS_HEIGHT - 56) / (rows - 1)) + waveY).toFixed(1)
      );
      const { lat, lng } = canvasToLatLng(x, y, bbox);
      const node: MapNode = {
        id: `CITY-${r}-${c}`,
        name: `${shortTitle} Sector ${r + 1}×${c + 1}`,
        shortCode: `S${r}_${c}`,
        category: c === 14 || r === 13 ? 'commercial' : 'residential',
        x,
        y,
        lat,
        lng,
        zone: shortTitle,
      };
      nodes.push(node);
      row.push(node);
    }
    grid.push(row);
  }

  const addEdge = (u: MapNode, v: MapNode, roadName: string, tier: RoadTier) => {
    const key = u.id < v.id ? `${u.id}__${v.id}` : `${v.id}__${u.id}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);
    const euclid = computeEuclideanKm(u, v);
    edges.push({
      id: `CITY-E${edges.length + 1}`,
      roadName,
      from: u.id,
      to: v.id,
      baseDistanceKm: Number(
        Math.max(euclid + 0.0005, euclid * 1.03).toFixed(4)
      ),
      trafficLevel: 1,
      blocked: false,
      roadTier: tier,
    });
  };

  for (let r = 0; r < rows; r++) {
    const isArterialRow = r === 7 || r === 13 || r === 19;
    for (let c = 0; c < cols; c++) {
      const u = grid[r][c];
      const isArterialCol = c === 8 || c === 15 || c === 22;
      if (c + 1 < cols) {
        addEdge(
          u,
          grid[r][c + 1],
          isArterialRow
            ? `${shortTitle} Main Trunk Rd`
            : `Cross Street ${r + 1}`,
          isArterialRow ? 'arterial' : r % 4 === 0 ? 'primary' : 'local'
        );
      }
      if (r + 1 < rows) {
        addEdge(
          u,
          grid[r + 1][c],
          isArterialCol
            ? `${shortTitle} Central Avenue`
            : `Link Road ${c + 1}`,
          isArterialCol ? 'arterial' : c % 4 === 0 ? 'secondary' : 'local'
        );
      }
      if (r + 1 < rows && c + 1 < cols && (r + c) % 5 === 0) {
        addEdge(
          u,
          grid[r + 1][c + 1],
          `${shortTitle} Diagonal Highway`,
          'primary'
        );
      }
    }
  }

  const landmarkTargets = [
    { x: 480, y: 295, label: `${shortTitle} City Center`, code: 'CTR', cat: 'hub' as const },
    { x: 160, y: 160, label: `${shortTitle} North-West Hub`, code: 'NW', cat: 'depot' as const },
    { x: 800, y: 440, label: `${shortTitle} South-East Hub`, code: 'SE', cat: 'hub' as const },
    { x: 780, y: 160, label: `${shortTitle} North-East Plaza`, code: 'NE', cat: 'commercial' as const },
    { x: 180, y: 440, label: `${shortTitle} South-West Station`, code: 'SW', cat: 'commercial' as const },
    { x: 480, y: 120, label: `${shortTitle} North Bypass`, code: 'NTH', cat: 'commercial' as const },
    { x: 480, y: 480, label: `${shortTitle} Civil Hospital`, code: 'HOSP', cat: 'hospital' as const },
  ];

  const landmarkIds: string[] = [];
  const used = new Set<string>();
  for (const tgt of landmarkTargets) {
    let best = nodes[0];
    let bestD = Infinity;
    for (const n of nodes) {
      if (used.has(n.id)) continue;
      const d = Math.hypot(n.x - tgt.x, n.y - tgt.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    used.add(best.id);
    best.isLandmark = true;
    best.shortCode = tgt.code;
    best.category = tgt.cat;
    best.name = tgt.label;
    landmarkIds.push(best.id);
  }

  return {
    id: `osm-live-${Date.now()}`,
    name: `${shortTitle}`,
    subtitle: `${nodes.length} intersections · ${edges.length} streets · ${shortTitle} Street Grid`,
    badge: `${shortTitle} (${nodes.length} Nodes)`,
    cityTag: shortTitle,
    defaultStartId: landmarkIds[1],
    defaultEndId: landmarkIds[2],
    defaultDeliveryStopIds: landmarkIds.slice(0, 6),
    bbox,
    nodes,
    edges,
  };
}

/**
 * Fetches a live real-world street network around (centerLat, centerLng) from OpenStreetMap Overpass API,
 * with a fast timeout and instant fallback so any city on Earth loads immediately.
 */
export async function fetchStreetNetworkByCoords(
  centerLat: number,
  centerLng: number,
  shortTitle: string
): Promise<MapPreset> {
  const latSpan = 0.024;
  const lngSpan =
    0.038 / Math.max(0.35, Math.cos((centerLat * Math.PI) / 180));
  const bbox: GeoBoundingBox = {
    minLat: Number((centerLat - latSpan).toFixed(6)),
    maxLat: Number((centerLat + latSpan).toFixed(6)),
    minLng: Number((centerLng - lngSpan).toFixed(6)),
    maxLng: Number((centerLng + lngSpan).toFixed(6)),
    centerLat,
    centerLng,
    zoom: 14,
  };

  const overpassQuery = `[out:json][timeout:5];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}););out body 800;>;out skel qt;`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    const ovRes = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(overpassQuery)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!ovRes.ok) {
      return buildInstantStreetNetworkForBbox(bbox, shortTitle);
    }

    const ovData = (await ovRes.json()) as { elements: OverpassElement[] };
    const rawNodes = new Map<number, { lat: number; lng: number }>();
    const ways: OverpassElement[] = [];

    for (const el of ovData.elements ?? []) {
      if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
        rawNodes.set(el.id, { lat: el.lat, lng: el.lon });
      } else if (
        el.type === 'way' &&
        Array.isArray(el.nodes) &&
        el.nodes.length >= 2
      ) {
        ways.push(el);
      }
    }

    if (ways.length === 0) {
      return buildInstantStreetNetworkForBbox(bbox, shortTitle);
    }

    const nodeUsage = new Map<number, number>();
    for (const way of ways) {
      const wNodes = way.nodes!;
      for (let i = 0; i < wNodes.length; i++) {
        const nid = wNodes[i];
        const inc = i === 0 || i === wNodes.length - 1 ? 2 : 1;
        nodeUsage.set(nid, (nodeUsage.get(nid) ?? 0) + inc);
      }
    }

    const keptNodeMap = new Map<number, MapNode>();
    const rawEdges: Array<{
      uId: string;
      vId: string;
      roadName: string;
      tier: RoadTier;
    }> = [];

    for (const way of ways) {
      const wNodes = way.nodes!;
      const roadName =
        way.tags?.name ||
        way.tags?.ref ||
        `${(way.tags?.highway ?? 'Street').replace('_', ' ')}`;
      const tier = classifyRoadTier(way.tags?.highway ?? 'residential');

      const selectedIndices: number[] = [0];
      for (let i = 1; i < wNodes.length - 1; i++) {
        const nid = wNodes[i];
        if ((nodeUsage.get(nid) ?? 0) >= 2 || i % 3 === 0) {
          selectedIndices.push(i);
        }
      }
      selectedIndices.push(wNodes.length - 1);

      for (const idx of selectedIndices) {
        const osmId = wNodes[idx];
        if (!keptNodeMap.has(osmId)) {
          const coords = rawNodes.get(osmId);
          if (!coords) continue;
          const { x, y } = latLngToCanvas(coords.lat, coords.lng, bbox);
          if (
            x < 10 ||
            x > CANVAS_WIDTH - 10 ||
            y < 10 ||
            y > CANVAS_HEIGHT - 10
          ) {
            continue;
          }
          keptNodeMap.set(osmId, {
            id: `OSM-N${osmId}`,
            name: `${roadName} Jct`,
            shortCode: `J${keptNodeMap.size + 1}`,
            category: tier === 'arterial' ? 'commercial' : 'residential',
            x,
            y,
            lat: coords.lat,
            lng: coords.lng,
            zone: shortTitle,
          });
        }
      }

      for (let k = 0; k < selectedIndices.length - 1; k++) {
        const nA = keptNodeMap.get(wNodes[selectedIndices[k]]);
        const nB = keptNodeMap.get(wNodes[selectedIndices[k + 1]]);
        if (nA && nB && nA.id !== nB.id) {
          rawEdges.push({
            uId: nA.id,
            vId: nB.id,
            roadName,
            tier,
          });
        }
      }
    }

    const adj = new Map<string, string[]>();
    for (const n of keptNodeMap.values()) {
      adj.set(n.id, []);
    }
    for (const e of rawEdges) {
      adj.get(e.uId)?.push(e.vId);
      adj.get(e.vId)?.push(e.uId);
    }

    const visited = new Set<string>();
    let largestComp: Set<string> = new Set();

    for (const startId of adj.keys()) {
      if (visited.has(startId)) continue;
      const comp = new Set<string>();
      const queue = [startId];
      visited.add(startId);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        comp.add(curr);
        for (const nb of adj.get(curr) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      if (comp.size > largestComp.size) {
        largestComp = comp;
      }
    }

    if (largestComp.size < 80) {
      return buildInstantStreetNetworkForBbox(bbox, shortTitle);
    }

    const allowedIds = new Set<string>();
    for (const id of largestComp) {
      if (allowedIds.size >= 1400) break;
      allowedIds.add(id);
    }

    const finalNodes: MapNode[] = [];
    const finalNodeMap = new Map<string, MapNode>();
    for (const node of keptNodeMap.values()) {
      if (allowedIds.has(node.id)) {
        finalNodes.push(node);
        finalNodeMap.set(node.id, node);
      }
    }

    const finalEdges: MapEdge[] = [];
    const pairSeen = new Set<string>();
    for (const re of rawEdges) {
      if (!allowedIds.has(re.uId) || !allowedIds.has(re.vId)) continue;
      const key =
        re.uId < re.vId ? `${re.uId}__${re.vId}` : `${re.vId}__${re.uId}`;
      if (pairSeen.has(key)) continue;
      pairSeen.add(key);

      const u = finalNodeMap.get(re.uId)!;
      const v = finalNodeMap.get(re.vId)!;
      const euclid = computeEuclideanKm(u, v);
      finalEdges.push({
        id: `OSM-E${finalEdges.length + 1}`,
        roadName: re.roadName,
        from: u.id,
        to: v.id,
        baseDistanceKm: Number(
          Math.max(euclid + 0.0005, euclid * 1.03).toFixed(4)
        ),
        trafficLevel: 1,
        blocked: false,
        roadTier: re.tier,
      });
    }

    const landmarkTargets = [
      { x: 480, y: 295, label: 'Center Hub', code: 'CTR', cat: 'hub' as const },
      { x: 160, y: 160, label: 'North-West Point', code: 'NW', cat: 'depot' as const },
      { x: 800, y: 440, label: 'South-East Point', code: 'SE', cat: 'hub' as const },
      { x: 780, y: 160, label: 'North-East Plaza', code: 'NE', cat: 'commercial' as const },
      { x: 180, y: 440, label: 'South-West Junction', code: 'SW', cat: 'commercial' as const },
      { x: 480, y: 130, label: 'North Gate', code: 'NTH', cat: 'commercial' as const },
      { x: 480, y: 470, label: 'South Terminal', code: 'STH', cat: 'hospital' as const },
    ];

    const landmarkIds: string[] = [];
    const used = new Set<string>();
    for (const tgt of landmarkTargets) {
      let best = finalNodes[0];
      let bestD = Infinity;
      for (const n of finalNodes) {
        if (used.has(n.id)) continue;
        const d = Math.hypot(n.x - tgt.x, n.y - tgt.y);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      used.add(best.id);
      best.isLandmark = true;
      best.shortCode = tgt.code;
      best.category = tgt.cat;
      best.name = `${best.name.replace(/ Jct$/, '')} (${tgt.label})`;
      landmarkIds.push(best.id);
    }

    return {
      id: `osm-live-${Date.now()}`,
      name: `${shortTitle}`,
      subtitle: `${finalNodes.length} intersections · ${finalEdges.length} streets · Live OpenStreetMap`,
      badge: `Live OSM (${finalNodes.length} Nodes)`,
      cityTag: shortTitle,
      defaultStartId: landmarkIds[1] ?? finalNodes[0].id,
      defaultEndId: landmarkIds[2] ?? finalNodes[finalNodes.length - 1].id,
      defaultDeliveryStopIds: landmarkIds.slice(0, 6),
      bbox,
      nodes: finalNodes,
      edges: finalEdges,
    };
  } catch {
    return buildInstantStreetNetworkForBbox(bbox, shortTitle);
  }
}

/**
 * Fetches a live real-world street network from OpenStreetMap Nominatim + Overpass API by text query.
 */
export async function fetchRealCityFromOSM(query: string): Promise<MapPreset> {
  const results = await searchOpenStreetMapPlaces(query);
  if (results.length === 0) {
    throw new Error(`No location found on OpenStreetMap for "${query}".`);
  }
  const top = results[0];
  return fetchStreetNetworkByCoords(top.lat, top.lng, top.name);
}
