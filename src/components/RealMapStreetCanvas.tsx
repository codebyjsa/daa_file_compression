import React, {
  useRef,
  useEffect,
  useState,
  useMemo,
  useCallback,
} from 'react';
import {
  Plus,
  Minus,
  Compass,
  Layers,
  MapPin,
  Navigation,
  Flag,
  PackagePlus,
} from 'lucide-react';
import {
  type MapNode,
  type MapEdge,
  type GeoBoundingBox,
} from '../algorithms/graphTypes.ts';
import { canvasToLatLng } from '../algorithms/cityStreetGraphs.ts';
import { type ExploredEdgeStep } from '../algorithms/shortestPath.ts';

export type MapBrushMode =
  | 'pan-explore'
  | 'pick-start'
  | 'pick-end'
  | 'pick-stops'
  | 'add-custom-pin'
  | 'brush-heavy'
  | 'brush-gridlock'
  | 'brush-block'
  | 'brush-clear';

export type MapTileStyle = 'voyager' | 'osm-standard' | 'dark-matter';

export interface RealMapStreetCanvasProps {
  nodes: MapNode[];
  edges: MapEdge[];
  bbox: GeoBoundingBox;
  startNodeId: string;
  endNodeId: string;
  deliveryStopIds?: string[];
  orderedTourStopIds?: string[];
  exploredEdges: ExploredEdgeStep[];
  waveCursor: number;
  activeRouteEdgeIds: string[];
  secondaryRouteEdgeIds?: string[];
  mstEdgeIds?: string[];
  meetingNodeId?: string;
  showRouteNow: boolean;
  brushMode: MapBrushMode;
  tileStyle?: MapTileStyle;
  onTileStyleChange?: (style: MapTileStyle) => void;
  badgeTitle?: string;
  badgeSubtitle?: string;
  badgeMetrics?: {
    exploredCount: number;
    totalEdges: number;
    routeKm: number;
    etaMin: number;
    isOptimal?: boolean;
  };
  compact?: boolean;
  fullScreen?: boolean;
  showLandmarks?: boolean;
  externalCameraTarget?: { lat: number; lng: number; zoom?: number; ts: number } | null;
  onSelectNode?: (nodeId: string) => void;
  onAddCustomLocationAtLatLng?: (
    lat: number,
    lng: number,
    role: 'custom' | 'start' | 'end' | 'stop',
    customName?: string
  ) => void;
  onPaintEdges?: (edgeIds: string[], brush: MapBrushMode) => void;
}

const TILE_SIZE = 256;

function lngToWorldX(lng: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return ((lng + 180) / 360) * scale;
}

function latToWorldY(lat: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale
  );
}

function worldXToLng(worldX: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return (worldX / scale) * 360 - 180;
}

function worldYToLat(worldY: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const n = Math.PI - (2 * Math.PI * worldY) / scale;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function getTileUrl(style: MapTileStyle, z: number, x: number, y: number): string {
  const maxTile = Math.pow(2, z);
  const wrappedX = ((x % maxTile) + maxTile) % maxTile;
  if (style === 'voyager') {
    // Esri World Street Map (Google Maps-style crisp street map, 100% free, no API key watermark)
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${wrappedX}`;
  }
  // Both 'osm-standard' and 'dark-matter' use official OpenStreetMap tiles (100% free, no API key watermark)
  // 'dark-matter' applies a dark-mode CSS filter on the tile layer
  return `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`;
}

export const RealMapStreetCanvas: React.FC<RealMapStreetCanvasProps> = ({
  nodes,
  edges,
  bbox,
  startNodeId,
  endNodeId,
  deliveryStopIds = [],
  orderedTourStopIds = [],
  exploredEdges,
  waveCursor,
  activeRouteEdgeIds,
  secondaryRouteEdgeIds = [],
  mstEdgeIds = [],
  meetingNodeId,
  showRouteNow,
  brushMode,
  tileStyle = 'osm-standard',
  onTileStyleChange,
  badgeTitle,
  badgeSubtitle,
  badgeMetrics,
  compact = false,
  fullScreen = false,
  showLandmarks = true,
  externalCameraTarget,
  onSelectNode,
  onAddCustomLocationAtLatLng,
  onPaintEdges,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: 960,
    h: 600,
  });

  // Interactive Slippy Map Camera State (centerLat, centerLng, zoom)
  const [camera, setCamera] = useState<{
    lat: number;
    lng: number;
    zoom: number;
  }>({
    lat: bbox.centerLat,
    lng: bbox.centerLng,
    zoom: bbox.zoom || 15,
  });

  // Sync camera when preset bbox changes
  useEffect(() => {
    setCamera({
      lat: bbox.centerLat,
      lng: bbox.centerLng,
      zoom: bbox.zoom || 15,
    });
  }, [bbox.centerLat, bbox.centerLng, bbox.zoom]);

  // Sync camera when user searches and selects a specific place
  useEffect(() => {
    if (externalCameraTarget) {
      setCamera((prev) => ({
        lat: externalCameraTarget.lat,
        lng: externalCameraTarget.lng,
        zoom: externalCameraTarget.zoom ?? prev.zoom,
      }));
    }
  }, [externalCameraTarget]);

  // Observe container resize so full-screen Google Maps layout fills 100% of screen
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize({
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [hoveredNode, setHoveredNode] = useState<
    (MapNode & { sx: number; sy: number }) | null
  >(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [hoveredLatLng, setHoveredLatLng] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  // Panning / dragging state
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{
    clientX: number;
    clientY: number;
    startLat: number;
    startLng: number;
    moved: boolean;
  } | null>(null);
  const [isDraggingBrush, setIsDraggingBrush] = useState(false);

  // Google Maps Right-Click Context Menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lng: number;
  } | null>(null);
  const [customPinPrompt, setCustomPinPrompt] = useState<{
    x: number;
    y: number;
    lat: number;
    lng: number;
    name: string;
  } | null>(null);

  // Ensure every node has geographic (lat, lng)
  const geoNodes = useMemo(() => {
    return nodes.map((n) => {
      if (n.lat !== undefined && n.lng !== undefined) return n;
      const coords = canvasToLatLng(n.x, n.y, bbox);
      return { ...n, lat: coords.lat, lng: coords.lng };
    });
  }, [nodes, bbox]);

  // Project geographic (lat, lng) to current screen (x, y)
  const centerWorldX = useMemo(
    () => lngToWorldX(camera.lng, camera.zoom),
    [camera.lng, camera.zoom]
  );
  const centerWorldY = useMemo(
    () => latToWorldY(camera.lat, camera.zoom),
    [camera.lat, camera.zoom]
  );

  const latLngToScreen = useCallback(
    (lat: number, lng: number): { x: number; y: number } => {
      const wx = lngToWorldX(lng, camera.zoom);
      const wy = latToWorldY(lat, camera.zoom);
      return {
        x: viewportSize.w / 2 + (wx - centerWorldX),
        y: viewportSize.h / 2 + (wy - centerWorldY),
      };
    },
    [camera.zoom, centerWorldX, centerWorldY, viewportSize.w, viewportSize.h]
  );

  const screenToLatLng = useCallback(
    (screenX: number, screenY: number): { lat: number; lng: number } => {
      const wx = centerWorldX + (screenX - viewportSize.w / 2);
      const wy = centerWorldY + (screenY - viewportSize.h / 2);
      return {
        lat: Number(worldYToLat(wy, camera.zoom).toFixed(6)),
        lng: Number(worldXToLng(wx, camera.zoom).toFixed(6)),
      };
    },
    [camera.zoom, centerWorldX, centerWorldY, viewportSize.w, viewportSize.h]
  );

  // Precompute screen coordinates for all nodes in current frame
  const projectedNodeMap = useMemo(() => {
    const map = new Map<string, MapNode & { sx: number; sy: number }>();
    for (const n of geoNodes) {
      const { x, y } = latLngToScreen(n.lat!, n.lng!);
      map.set(n.id, { ...n, sx: x, sy: y });
    }
    return map;
  }, [geoNodes, latLngToScreen]);

  const edgeMap = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges]);

  // Compute visible OpenStreetMap slippy tiles for current viewport
  const visibleTiles = useMemo(() => {
    const z = Math.round(camera.zoom);
    const topLeftWorldX = centerWorldX - viewportSize.w / 2;
    const topLeftWorldY = centerWorldY - viewportSize.h / 2;
    const bottomRightWorldX = centerWorldX + viewportSize.w / 2;
    const bottomRightWorldY = centerWorldY + viewportSize.h / 2;

    const minTileX = Math.floor(topLeftWorldX / TILE_SIZE);
    const maxTileX = Math.floor(bottomRightWorldX / TILE_SIZE);
    const minTileY = Math.max(0, Math.floor(topLeftWorldY / TILE_SIZE));
    const maxTileY = Math.min(
      Math.pow(2, z) - 1,
      Math.floor(bottomRightWorldY / TILE_SIZE)
    );

    const tiles: Array<{
      key: string;
      url: string;
      left: number;
      top: number;
    }> = [];

    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const left = Math.round(tx * TILE_SIZE - topLeftWorldX);
        const top = Math.round(ty * TILE_SIZE - topLeftWorldY);
        tiles.push({
          key: `${tileStyle}-${z}-${tx}-${ty}`,
          url: getTileUrl(tileStyle, z, tx, ty),
          left,
          top,
        });
      }
    }
    return tiles;
  }, [camera.zoom, centerWorldX, centerWorldY, viewportSize.w, viewportSize.h, tileStyle]);

  const activeRouteSet = useMemo(
    () => new Set(activeRouteEdgeIds),
    [activeRouteEdgeIds]
  );
  const secondaryRouteSet = useMemo(
    () => new Set(secondaryRouteEdgeIds),
    [secondaryRouteEdgeIds]
  );
  const mstEdgeSet = useMemo(() => new Set(mstEdgeIds), [mstEdgeIds]);
  const deliveryStopSet = useMemo(
    () => new Set(deliveryStopIds),
    [deliveryStopIds]
  );

  const isTrafficBrush =
    brushMode === 'brush-heavy' ||
    brushMode === 'brush-gridlock' ||
    brushMode === 'brush-block' ||
    brushMode === 'brush-clear';

  const findNearestScreenNode = useCallback(
    (sx: number, sy: number, maxRadius = 26): (MapNode & { sx: number; sy: number }) | null => {
      let best: (MapNode & { sx: number; sy: number }) | null = null;
      let bestDist = maxRadius;
      for (const n of projectedNodeMap.values()) {
        const d = Math.hypot(n.sx - sx, n.sy - sy);
        if (d < bestDist) {
          bestDist = d;
          best = n;
        }
      }
      return best;
    },
    [projectedNodeMap]
  );

  const applyBrushAtScreenPoint = useCallback(
    (sx: number, sy: number) => {
      if (!onPaintEdges) return;
      const brushRadius = 34;
      const hitEdgeIds: string[] = [];
      for (const edge of edges) {
        const u = projectedNodeMap.get(edge.from);
        const v = projectedNodeMap.get(edge.to);
        if (!u || !v) continue;
        const midX = (u.sx + v.sx) / 2;
        const midY = (u.sy + v.sy) / 2;
        if (Math.hypot(midX - sx, midY - sy) <= brushRadius) {
          hitEdgeIds.push(edge.id);
        }
      }
      if (hitEdgeIds.length > 0) {
        onPaintEdges(hitEdgeIds, brushMode);
      }
    },
    [edges, projectedNodeMap, onPaintEdges, brushMode]
  );

  const getLocalScreenPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // Right-click handled by onContextMenu
    setContextMenu(null);

    const pos = getLocalScreenPos(e);
    if (isTrafficBrush) {
      setIsDraggingBrush(true);
      applyBrushAtScreenPoint(pos.x, pos.y);
      return;
    }

    // Start pan gesture (if mouse doesn't move > 5px, mouseUp treats it as a click!)
    setIsPanning(true);
    panStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startLat: camera.lat,
      startLng: camera.lng,
      moved: false,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getLocalScreenPos(e);
    setMousePos(pos);
    setHoveredLatLng(screenToLatLng(pos.x, pos.y));

    if (isDraggingBrush && isTrafficBrush) {
      applyBrushAtScreenPoint(pos.x, pos.y);
      return;
    }

    if (isPanning && panStartRef.current) {
      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;
      if (Math.hypot(dx, dy) > 4) {
        panStartRef.current.moved = true;
      }
      const startWX = lngToWorldX(panStartRef.current.startLng, camera.zoom);
      const startWY = latToWorldY(panStartRef.current.startLat, camera.zoom);
      const newLng = worldXToLng(startWX - dx, camera.zoom);
      const newLat = worldYToLat(startWY - dy, camera.zoom);
      setCamera((prev) => ({
        ...prev,
        lat: newLat,
        lng: newLng,
      }));
      return;
    }

    const nearest = findNearestScreenNode(pos.x, pos.y, 24);
    setHoveredNode(nearest);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDraggingBrush(false);

    if (isPanning && panStartRef.current) {
      const wasClick = !panStartRef.current.moved;
      setIsPanning(false);
      panStartRef.current = null;

      if (wasClick) {
        const pos = getLocalScreenPos(e);
        const coords = screenToLatLng(pos.x, pos.y);

        // If user is in "Add Custom Location" mode, open custom pin creator right where they clicked!
        if (brushMode === 'add-custom-pin') {
          setCustomPinPrompt({
            x: Math.min(viewportSize.w - 260, Math.max(20, pos.x)),
            y: Math.min(viewportSize.h - 160, Math.max(20, pos.y)),
            lat: coords.lat,
            lng: coords.lng,
            name: '',
          });
          return;
        }

        // Otherwise check if user clicked an existing intersection or wants to drop a pin anywhere on the map
        const nearest = findNearestScreenNode(pos.x, pos.y, 28);
        if (nearest && onSelectNode) {
          onSelectNode(nearest.id);
        } else if (onAddCustomLocationAtLatLng) {
          // User clicked an arbitrary spot on the OpenStreetMap -> create a custom node there and route to/from it!
          const role =
            brushMode === 'pick-start'
              ? 'start'
              : brushMode === 'pick-stops'
                ? 'stop'
                : 'end';
          onAddCustomLocationAtLatLng(coords.lat, coords.lng, role);
        }
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = getLocalScreenPos(e);
    const coords = screenToLatLng(pos.x, pos.y);
    setContextMenu({
      x: Math.min(viewportSize.w - 240, Math.max(12, pos.x)),
      y: Math.min(viewportSize.h - 210, Math.max(12, pos.y)),
      lat: coords.lat,
      lng: coords.lng,
    });
  };

  // Register non-passive wheel listener directly on canvas DOM node to avoid React passive wheel warning
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const delta = e.deltaY < 0 ? 1 : -1;
      setCamera((prev) => ({
        ...prev,
        zoom: Math.max(11, Math.min(18, prev.zoom + delta)),
      }));
    };
    canvas.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onNativeWheel);
    };
  }, []);

  const isLightMap = tileStyle === 'voyager' || tileStyle === 'osm-standard';

  // Render High-FPS Canvas Overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = viewportSize.w;
    const h = viewportSize.h;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 1. Render Active Street Graph Edges
    ctx.lineCap = 'round';
    for (const edge of edges) {
      const u = projectedNodeMap.get(edge.from);
      const v = projectedNodeMap.get(edge.to);
      if (!u || !v) continue;

      ctx.beginPath();
      ctx.moveTo(u.sx, u.sy);
      ctx.lineTo(v.sx, v.sy);

      if (edge.blocked) {
        ctx.strokeStyle = 'rgba(225, 29, 72, 0.85)';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }

      if (edge.trafficLevel === 3) {
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.72)';
        ctx.lineWidth = 3.2;
      } else if (edge.trafficLevel === 2) {
        ctx.strokeStyle = 'rgba(217, 119, 6, 0.68)';
        ctx.lineWidth = 2.8;
      } else {
        const tier = edge.roadTier ?? 'local';
        if (isLightMap) {
          ctx.strokeStyle =
            tier === 'arterial'
              ? 'rgba(59, 130, 246, 0.28)'
              : 'rgba(100, 116, 139, 0.22)';
          ctx.lineWidth = tier === 'arterial' ? 2.2 : 1.3;
        } else {
          ctx.strokeStyle =
            tier === 'arterial'
              ? 'rgba(148, 163, 184, 0.42)'
              : 'rgba(71, 85, 105, 0.34)';
          ctx.lineWidth = tier === 'arterial' ? 2.1 : 1.2;
        }
      }
      ctx.stroke();
    }

    // 2. Render Explored Street-Wave (Glowing Search Wave)
    const clampedCursor = Math.min(waveCursor, exploredEdges.length);
    const totalExplored = Math.max(1, exploredEdges.length);

    if (clampedCursor > 0) {
      for (let i = 0; i < clampedCursor; i++) {
        const step = exploredEdges[i];
        const u = projectedNodeMap.get(step.fromId);
        const v = projectedNodeMap.get(step.toId);
        if (!u || !v) continue;

        const ratio = i / totalExplored;
        ctx.beginPath();
        ctx.moveTo(u.sx, u.sy);
        ctx.lineTo(v.sx, v.sy);

        if (step.waveOrigin === 'backward') {
          const r = 244;
          const g = Math.round(63 + ratio * 115);
          const b = Math.round(94 - ratio * 60);
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
        } else {
          if (isLightMap) {
            // Deep royal blue -> indigo -> magenta on light Google Maps tiles
            const r = Math.round(14 + ratio * 154);
            const g = Math.round(116 - ratio * 55);
            const b = Math.round(233 - ratio * 10);
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.82)`;
          } else {
            const r = Math.round(34 + ratio * 165);
            const g = Math.round(211 - ratio * 115);
            const b = Math.round(238 + ratio * 12);
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.88)`;
          }
        }
        ctx.lineWidth = compact ? 2.4 : 2.9;
        ctx.stroke();
      }

      // Active Frontier Sparks
      if (clampedCursor < exploredEdges.length || !showRouteNow) {
        const frontierCount = Math.min(28, clampedCursor);
        ctx.save();
        for (
          let i = Math.max(0, clampedCursor - frontierCount);
          i < clampedCursor;
          i++
        ) {
          const step = exploredEdges[i];
          const u = projectedNodeMap.get(step.fromId);
          const v = projectedNodeMap.get(step.toId);
          if (!u || !v) continue;

          ctx.strokeStyle =
            step.waveOrigin === 'backward' ? '#f59e0b' : '#06b6d4';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(u.sx, u.sy);
          ctx.lineTo(v.sx, v.sy);
          ctx.stroke();

          ctx.fillStyle = isLightMap ? '#1d4ed8' : '#ffffff';
          ctx.beginPath();
          ctx.arc(v.sx, v.sy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 3. Render MST Fiber Backbone if active
    if (mstEdgeSet.size > 0) {
      ctx.save();
      ctx.strokeStyle = isLightMap ? '#0284c7' : '#38bdf8';
      ctx.lineWidth = 3.2;
      for (const edgeId of mstEdgeSet) {
        const edge = edgeMap.get(edgeId);
        if (!edge) continue;
        const u = projectedNodeMap.get(edge.from);
        const v = projectedNodeMap.get(edge.to);
        if (!u || !v) continue;
        ctx.beginPath();
        ctx.moveTo(u.sx, u.sy);
        ctx.lineTo(v.sx, v.sy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 4. Secondary Comparison Route (Greedy TSP)
    if (showRouteNow && secondaryRouteSet.size > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([7, 5]);
      for (const edgeId of secondaryRouteSet) {
        const edge = edgeMap.get(edgeId);
        if (!edge) continue;
        const u = projectedNodeMap.get(edge.from);
        const v = projectedNodeMap.get(edge.to);
        if (!u || !v) continue;
        ctx.beginPath();
        ctx.moveTo(u.sx, u.sy);
        ctx.lineTo(v.sx, v.sy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. Primary Google-Maps Style Route Polyline (Royal Blue / Emerald with crisp casing)
    if (showRouteNow && activeRouteSet.size > 0) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Outer casing (Google Maps dark blue/emerald border)
      ctx.strokeStyle = isLightMap ? '#1e40af' : 'rgba(16, 185, 129, 0.48)';
      ctx.lineWidth = compact ? 8 : 9.5;
      for (const edgeId of activeRouteSet) {
        const edge = edgeMap.get(edgeId);
        if (!edge) continue;
        const u = projectedNodeMap.get(edge.from);
        const v = projectedNodeMap.get(edge.to);
        if (!u || !v) continue;
        ctx.beginPath();
        ctx.moveTo(u.sx, u.sy);
        ctx.lineTo(v.sx, v.sy);
        ctx.stroke();
      }

      // Inner bright Google Maps route core
      ctx.strokeStyle = isLightMap ? '#2563eb' : '#34d399';
      ctx.lineWidth = compact ? 4.5 : 5.5;
      for (const edgeId of activeRouteSet) {
        const edge = edgeMap.get(edgeId);
        if (!edge) continue;
        const u = projectedNodeMap.get(edge.from);
        const v = projectedNodeMap.get(edge.to);
        if (!u || !v) continue;
        ctx.beginPath();
        ctx.moveTo(u.sx, u.sy);
        ctx.lineTo(v.sx, v.sy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 6. Render Landmarks & Custom User Locations
    if (showLandmarks) {
      for (const n of projectedNodeMap.values()) {
        if (!n.isLandmark) continue;
        const isCustom = n.id.startsWith('CUSTOM-');
        if (
          n.id === startNodeId ||
          n.id === endNodeId ||
          deliveryStopSet.has(n.id)
        ) {
          continue;
        }

        ctx.save();
        ctx.fillStyle = isCustom
          ? '#9333ea'
          : isLightMap
            ? '#ffffff'
            : '#0f172a';
        ctx.strokeStyle = isCustom
          ? '#ffffff'
          : isLightMap
            ? '#334155'
            : '#94a3b8';
        ctx.lineWidth = isCustom ? 2.2 : 1.6;
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, isCustom ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (!compact || isCustom) {
          ctx.font = isCustom
            ? 'bold 11px system-ui, sans-serif'
            : '600 10px system-ui, sans-serif';
          const label = isCustom ? `📌 ${n.name}` : n.shortCode;
          ctx.fillStyle = isLightMap ? '#0f172a' : '#f8fafc';
          ctx.strokeStyle = isLightMap
            ? 'rgba(255,255,255,0.9)'
            : 'rgba(15,23,42,0.9)';
          ctx.lineWidth = 3;
          ctx.strokeText(label, n.sx + 8, n.sy + 3.5);
          ctx.fillText(label, n.sx + 8, n.sy + 3.5);
        }
        ctx.restore();
      }
    }

    // 7. Render Multi-Stop Delivery Stops
    if (deliveryStopIds.length > 0) {
      for (const stopId of deliveryStopIds) {
        const node = projectedNodeMap.get(stopId);
        if (!node) continue;
        const orderIdx = orderedTourStopIds.indexOf(stopId);

        ctx.save();
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(node.sx, node.sy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          orderIdx > 0 ? String(orderIdx) : '•',
          node.sx,
          node.sy + 0.5
        );
        ctx.restore();
      }
    }

    // 8. Render Start Origin (Google Maps Green 'A' Pin) & Destination (Google Maps Red 'B' Pin)
    const startNode = projectedNodeMap.get(startNodeId);
    if (startNode) {
      ctx.save();
      ctx.fillStyle = 'rgba(22, 163, 74, 0.25)';
      ctx.beginPath();
      ctx.arc(startNode.sx, startNode.sy, 18, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#16a34a';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.arc(startNode.sx, startNode.sy, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('A', startNode.sx, startNode.sy + 0.5);
      ctx.restore();
    }

    const endNode = projectedNodeMap.get(endNodeId);
    if (endNode && endNodeId !== startNodeId) {
      ctx.save();
      ctx.fillStyle = 'rgba(225, 29, 72, 0.25)';
      ctx.beginPath();
      ctx.arc(endNode.sx, endNode.sy, 18, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e11d48';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.arc(endNode.sx, endNode.sy, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('B', endNode.sx, endNode.sy + 0.5);
      ctx.restore();
    }

    // 9. Render Hovered Node or Traffic Brush Circle
    if (isTrafficBrush && mousePos) {
      ctx.save();
      ctx.strokeStyle = '#f43f5e';
      ctx.fillStyle = 'rgba(244, 63, 94, 0.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(mousePos.x, mousePos.y, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (hoveredNode) {
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = '#60a5fa';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(hoveredNode.sx, hoveredNode.sy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }, [
    viewportSize,
    edges,
    projectedNodeMap,
    edgeMap,
    startNodeId,
    endNodeId,
    deliveryStopIds,
    deliveryStopSet,
    orderedTourStopIds,
    exploredEdges,
    waveCursor,
    activeRouteSet,
    secondaryRouteSet,
    mstEdgeSet,
    meetingNodeId,
    showRouteNow,
    hoveredNode,
    mousePos,
    isTrafficBrush,
    isLightMap,
    compact,
    showLandmarks,
  ]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden select-none ${
        fullScreen
          ? 'h-full w-full'
          : 'rounded-2xl border border-slate-700/80 shadow-2xl'
      } ${isLightMap ? 'bg-[#e5e3df]' : 'bg-[#070b14]'}`}
      style={!fullScreen ? { aspectRatio: '16 / 10' } : undefined}
    >
      {/* Layer 1: Live OpenStreetMap Slippy Tiles (Pan & Zoom synchronized, 0 API keys required) */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={
          tileStyle === 'dark-matter'
            ? {
                filter:
                  'invert(100%) hue-rotate(180deg) brightness(90%) contrast(95%)',
              }
            : undefined
        }
        aria-hidden="true"
      >
        {visibleTiles.map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: `${t.left}px`,
              top: `${t.top}px`,
              width: `${TILE_SIZE}px`,
              height: `${TILE_SIZE}px`,
              maxWidth: 'none',
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ))}
      </div>

      {/* Layer 2: Interactive 60 FPS Street-Wave & Routing Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => {
          setIsDraggingBrush(false);
          setIsPanning(false);
          setHoveredNode(null);
          setMousePos(null);
        }}
        className={`relative z-10 block h-full w-full ${
          isTrafficBrush || brushMode === 'add-custom-pin'
            ? 'cursor-crosshair'
            : isPanning
              ? 'cursor-grabbing'
              : 'cursor-grab'
        }`}
      />

      {/* Layer 3: Google Maps Right-Click Context Menu */}
      {contextMenu && (
        <div
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="absolute z-40 w-60 rounded-xl border border-slate-700 bg-slate-900/95 p-1.5 text-xs text-slate-100 shadow-2xl backdrop-blur-md"
        >
          <div className="border-b border-slate-800 px-2.5 py-1.5 font-mono text-[11px] text-slate-400">
            📍 {contextMenu.lat.toFixed(5)}, {contextMenu.lng.toFixed(5)}
          </div>
          <button
            type="button"
            onClick={() => {
              onAddCustomLocationAtLatLng?.(
                contextMenu.lat,
                contextMenu.lng,
                'start'
              );
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800 cursor-pointer"
          >
            <Navigation className="h-3.5 w-3.5 text-emerald-400" />
            Directions from here (Start A)
          </button>
          <button
            type="button"
            onClick={() => {
              onAddCustomLocationAtLatLng?.(
                contextMenu.lat,
                contextMenu.lng,
                'end'
              );
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800 cursor-pointer"
          >
            <Flag className="h-3.5 w-3.5 text-rose-400" />
            Directions to here (Destination B)
          </button>
          <button
            type="button"
            onClick={() => {
              onAddCustomLocationAtLatLng?.(
                contextMenu.lat,
                contextMenu.lng,
                'stop'
              );
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800 cursor-pointer"
          >
            <PackagePlus className="h-3.5 w-3.5 text-amber-400" />
            Add as Delivery Stop (TSP)
          </button>
          <button
            type="button"
            onClick={() => {
              setCustomPinPrompt({
                x: contextMenu.x,
                y: contextMenu.y,
                lat: contextMenu.lat,
                lng: contextMenu.lng,
                name: '',
              });
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-purple-300 hover:bg-slate-800 cursor-pointer"
          >
            <MapPin className="h-3.5 w-3.5 text-purple-400" />
            Add Custom Named Location...
          </button>
        </div>
      )}

      {/* Layer 4: Inline Custom Named Pin Popover */}
      {customPinPrompt && (
        <div
          style={{ left: customPinPrompt.x, top: customPinPrompt.y }}
          className="absolute z-40 w-64 rounded-xl border border-purple-500/50 bg-slate-900/95 p-3 text-xs text-slate-100 shadow-2xl backdrop-blur-md"
        >
          <div className="font-bold text-purple-300 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            Add Custom Map Location
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-slate-400">
            {customPinPrompt.lat.toFixed(5)}°N, {customPinPrompt.lng.toFixed(5)}°E
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onAddCustomLocationAtLatLng?.(
                customPinPrompt.lat,
                customPinPrompt.lng,
                'custom',
                customPinPrompt.name
              );
              setCustomPinPrompt(null);
            }}
            className="mt-2 space-y-2"
          >
            <label htmlFor="custom-pin-name-input" className="block text-[11px] text-slate-300">
              Location Name (optional):
            </label>
            <input
              id="custom-pin-name-input"
              type="text"
              autoFocus
              value={customPinPrompt.name}
              onChange={(e) =>
                setCustomPinPrompt({ ...customPinPrompt, name: e.target.value })
              }
              placeholder="e.g., My Home, Client Office..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white focus:border-purple-400 focus:outline-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setCustomPinPrompt(null)}
                className="rounded-lg px-2.5 py-1 text-slate-400 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-purple-600 px-3 py-1 font-bold text-white hover:bg-purple-500 cursor-pointer"
              >
                Drop Pin on Map
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Layer 5: Algorithm Badge Overlay (for Split-Screen or top-right status) */}
      {badgeTitle && (
        <div
          className={`pointer-events-none absolute ${
            fullScreen ? 'top-4 right-16' : 'top-3 left-3'
          } z-20 rounded-xl border border-slate-700/80 bg-slate-950/90 px-3.5 py-2.5 backdrop-blur-md shadow-xl`}
        >
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-xs font-extrabold tracking-wide text-white uppercase">
              {badgeTitle}
            </span>
            {badgeMetrics?.isOptimal !== undefined && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  badgeMetrics.isOptimal
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}
              >
                {badgeMetrics.isOptimal ? 'OPTIMAL' : 'HEURISTIC'}
              </span>
            )}
          </div>
          {badgeSubtitle && (
            <p className="mt-0.5 text-[11px] text-slate-400">{badgeSubtitle}</p>
          )}
          {badgeMetrics && (
            <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800/90 pt-1.5 font-mono text-[11px]">
              <div>
                <span className="text-slate-400">Streets Scanned: </span>
                <span className="font-bold text-cyan-300">
                  {Math.min(waveCursor, badgeMetrics.exploredCount)}
                </span>
                <span className="text-slate-500">
                  /{badgeMetrics.exploredCount}
                </span>
              </div>
              <div>
                <span className="text-slate-400">Route: </span>
                <span className="font-bold text-emerald-400">
                  {badgeMetrics.routeKm} km
                </span>
              </div>
              <div>
                <span className="text-slate-400">ETA: </span>
                <span className="font-bold text-amber-300">
                  {badgeMetrics.etaMin} min
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Layer 6: Google Maps Bottom-Right Floating Zoom, Compass & Layer Style Controls */}
      <div className="absolute right-3 bottom-8 z-30 flex flex-col items-end gap-2">
        {onTileStyleChange && (
          <div className="flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/95 p-1 shadow-xl backdrop-blur-md">
            <Layers className="h-3.5 w-3.5 text-cyan-400 ml-1.5 mr-0.5" />
            {(
              [
                { id: 'osm-standard', label: 'OSM Street' },
                { id: 'voyager', label: 'Esri Street' },
                { id: 'dark-matter', label: 'Dark Neon' },
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => onTileStyleChange(st.id)}
                className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition cursor-pointer ${
                  tileStyle === st.id
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900/95 shadow-xl backdrop-blur-md">
          <button
            type="button"
            onClick={() =>
              setCamera((prev) => ({
                ...prev,
                zoom: Math.min(18, prev.zoom + 1),
              }))
            }
            aria-label="Zoom in"
            className="p-2.5 text-slate-200 hover:bg-slate-800 cursor-pointer border-b border-slate-800"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              setCamera((prev) => ({
                ...prev,
                zoom: Math.max(11, prev.zoom - 1),
              }))
            }
            aria-label="Zoom out"
            className="p-2.5 text-slate-200 hover:bg-slate-800 cursor-pointer border-b border-slate-800"
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              setCamera({
                lat: bbox.centerLat,
                lng: bbox.centerLng,
                zoom: bbox.zoom || 15,
              })
            }
            aria-label="Recenter map"
            className="p-2.5 text-cyan-400 hover:bg-slate-800 cursor-pointer"
          >
            <Compass className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Layer 7: Bottom-Right Live Cursor Coordinates & OpenStreetMap Attribution */}
      <div className="pointer-events-none absolute right-3 bottom-1.5 z-20 flex items-center gap-2 rounded bg-slate-950/85 px-2.5 py-0.5 text-[10px] text-slate-300 shadow">
        {hoveredNode ? (
          <span className="font-bold text-cyan-300">
            📍 {hoveredNode.name}
          </span>
        ) : hoveredLatLng ? (
          <span className="font-mono">
            {hoveredLatLng.lat.toFixed(4)}°N, {hoveredLatLng.lng.toFixed(4)}°E
          </span>
        ) : null}
        <span>
          · Right-click anywhere to add custom location · © OpenStreetMap
        </span>
      </div>
    </div>
  );
};
