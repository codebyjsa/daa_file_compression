export type NodeCategory =
  | 'depot'
  | 'hub'
  | 'commercial'
  | 'residential'
  | 'hospital'
  | 'academic'
  | 'hostel'
  | 'gate';

export type RoadTier = 'arterial' | 'primary' | 'secondary' | 'local';

export interface MapNode {
  id: string;
  name: string;
  shortCode: string;
  category: NodeCategory;
  x: number; // Canvas coordinate (0..960)
  y: number; // Canvas coordinate (0..600)
  lat?: number;
  lng?: number;
  zone?: string;
  isLandmark?: boolean;
}

export type TrafficLevel = 1 | 2 | 3; // 1 = Clear (1.0x), 2 = Heavy (2.2x), 3 = Gridlock (4.0x)

export interface MapEdge {
  id: string;
  roadName: string;
  from: string;
  to: string;
  baseDistanceKm: number;
  trafficLevel: TrafficLevel;
  blocked: boolean;
  roadTier?: RoadTier;
}

export interface GeoBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  centerLat: number;
  centerLng: number;
  zoom: number;
}

export interface MapPreset {
  id: string;
  name: string;
  subtitle: string;
  badge: string;
  cityTag: string;
  defaultStartId: string;
  defaultEndId: string;
  defaultDeliveryStopIds: string[];
  bbox: GeoBoundingBox;
  nodes: MapNode[];
  edges: MapEdge[];
}

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 600;
export const PIXEL_TO_KM = 0.0065;

export const TRAFFIC_MULTIPLIERS: Record<TrafficLevel, number> = {
  1: 1.0,
  2: 2.2,
  3: 4.0,
};

export const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  1: 'Clear (1.0x)',
  2: 'Heavy Traffic (2.2x)',
  3: 'Gridlock (4.0x)',
};

/**
 * Computes straight-line Euclidean distance in km between two map nodes.
 * Used as the admissible heuristic h(n) in A* Search and Bidirectional A*.
 */
export function computeEuclideanKm(a: MapNode, b: MapNode): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Number((Math.hypot(dx, dy) * PIXEL_TO_KM).toFixed(4));
}

/**
 * Computes effective travel cost (in effective km) for an edge considering live traffic.
 */
export function getEffectiveEdgeWeight(edge: MapEdge): number {
  if (edge.blocked) return Infinity;
  return Number(
    (edge.baseDistanceKm * TRAFFIC_MULTIPLIERS[edge.trafficLevel]).toFixed(4)
  );
}

/**
 * Converts effective weighted distance into estimated travel minutes (assuming 32 km/h urban speed).
 */
export function weightToMinutes(effectiveKm: number): number {
  if (!Number.isFinite(effectiveKm)) return 0;
  return Number(((effectiveKm / 32) * 60).toFixed(1));
}
