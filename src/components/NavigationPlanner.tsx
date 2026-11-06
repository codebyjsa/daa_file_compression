import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Navigation,
  Truck,
  Network,
  Play,
  Pause,
  RotateCcw,
  Flame,
  Zap,
  Sparkles,
  ArrowRight,
  Columns2,
  Maximize2,
  Globe,
  Search,
  Loader2,
  MapPin,
  PlusCircle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  BarChart3,
  ListOrdered,
  Hand,
  LocateFixed,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  type MapPreset,
  type MapNode,
  type MapEdge,
  type TrafficLevel,
} from '../algorithms/graphTypes.ts';
import { MAP_PRESETS } from '../algorithms/presets.ts';
import {
  type ShortestPathAlgo,
  compareShortestPathAlgorithms,
  runShortestPathByAlgo,
} from '../algorithms/shortestPath.ts';
import { compareMultiStopTSP, type TSPAlgo } from '../algorithms/tspDelivery.ts';
import {
  runKruskalMST,
  runPrimMST,
  type MSTAlgo,
} from '../algorithms/mstPlanner.ts';
import {
  searchOpenStreetMapPlaces,
  reverseGeocodeOpenStreetMap,
  fetchStreetNetworkByCoords,
  addCustomNodeToNetwork,
  buildSpanningNetworkForLocations,
  type NominatimSearchResult,
} from '../algorithms/osmLoader.ts';
import {
  RealMapStreetCanvas,
  type MapBrushMode,
  type MapTileStyle,
} from './RealMapStreetCanvas.tsx';

type PlannerMode = 'shortest-path' | 'tsp-delivery' | 'mst-fiber';

const ALGO_META: Record<
  ShortestPathAlgo,
  {
    title: string;
    short: string;
    subtitle: string;
    complexity: string;
    isOptimal: boolean;
  }
> = {
  astar: {
    title: 'A* Search (Heuristic Beam)',
    short: 'A* Search',
    subtitle: 'f(n) = g(n) + h(n) Euclidean target beam',
    complexity: 'O((V + E) log V)',
    isOptimal: true,
  },
  dijkstra: {
    title: "Dijkstra's Algorithm (360° Radial Wave)",
    short: 'Dijkstra',
    subtitle: 'Uniform cost priority queue flood in all directions',
    complexity: 'O((V + E) log V)',
    isOptimal: true,
  },
  bidirectional: {
    title: 'Bidirectional Search (Dual-Wave Collision)',
    short: 'Bidirectional',
    subtitle: 'Simultaneous Forward (A) + Backward (B) waves',
    complexity: 'O(b^(d/2))',
    isOptimal: true,
  },
  'greedy-bfs': {
    title: 'Greedy Best-First Search (Heuristic Sprint)',
    short: 'Greedy Best-First',
    subtitle: 'f(n) = h(n) only — ultra-fast but non-optimal',
    complexity: 'O(E log V)',
    isOptimal: false,
  },
  'bellman-ford': {
    title: 'Bellman-Ford (V-1 DP Relaxation)',
    short: 'Bellman-Ford',
    subtitle: 'Dynamic Programming edge relaxation across all streets',
    complexity: 'O(V · E)',
    isOptimal: true,
  },
};

export const NavigationPlanner: React.FC = () => {
  const [presets, setPresets] = useState<MapPreset[]>(MAP_PRESETS);
  const [presetId, setPresetId] = useState<string>(MAP_PRESETS[0].id);
  const activePreset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? presets[0],
    [presets, presetId]
  );

  // Mutable nodes & edges so users can add custom locations anywhere on the map!
  const [nodes, setNodes] = useState<MapNode[]>(() =>
    activePreset.nodes.map((n) => ({ ...n }))
  );
  const [edges, setEdges] = useState<MapEdge[]>(() =>
    activePreset.edges.map((e) => ({ ...e }))
  );

  const [mode, setMode] = useState<PlannerMode>('shortest-path');
  const [tileStyle, setTileStyle] = useState<MapTileStyle>('osm-standard');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [showDirectionsSteps, setShowDirectionsSteps] =
    useState<boolean>(false);
  const [showBenchmarkDrawer, setShowBenchmarkDrawer] =
    useState<boolean>(false);

  // Split-Screen Race Mode toggle
  const [splitRaceMode, setSplitRaceMode] = useState<boolean>(false);
  const [leftAlgo, setLeftAlgo] = useState<ShortestPathAlgo>('dijkstra');
  const [rightAlgo, setRightAlgo] = useState<ShortestPathAlgo>('astar');

  // Single-Map Mode algorithm
  const [spAlgo, setSpAlgo] = useState<ShortestPathAlgo>('astar');
  const [startNodeId, setStartNodeId] = useState<string>(
    activePreset.defaultStartId
  );
  const [endNodeId, setEndNodeId] = useState<string>(activePreset.defaultEndId);
  const [brushMode, setBrushMode] = useState<MapBrushMode>('pan-explore');

  // Camera target when flying to a searched place or custom pin
  const [cameraTarget, setCameraTarget] = useState<{
    lat: number;
    lng: number;
    zoom?: number;
    ts: number;
  } | null>(null);

  // Live OpenStreetMap Search & Autocomplete State
  const [osmQuery, setOsmQuery] = useState<string>('');
  const [osmSuggestions, setOsmSuggestions] = useState<NominatimSearchResult[]>(
    []
  );
  const [osmLoading, setOsmLoading] = useState<boolean>(false);
  const [locatingGPS, setLocatingGPS] = useState<boolean>(false);
  const [searchFocused, setSearchFocused] = useState<boolean>(false);
  const [osmStatusMsg, setOsmStatusMsg] = useState<string | null>(null);

  // Custom Location Creator Form State (in Google Maps Sidebar)
  const [showAddCustomForm, setShowAddCustomForm] = useState<boolean>(false);
  const [customLocName, setCustomLocName] = useState<string>('');
  const [customLocRole, setCustomLocRole] = useState<
    'start' | 'end' | 'stop' | 'custom'
  >('end');

  // TSP Delivery State
  const [tspAlgo, setTspAlgo] = useState<TSPAlgo>('held-karp-dp');
  const [deliveryStops, setDeliveryStops] = useState<string[]>(
    activePreset.defaultDeliveryStopIds
  );
  const [returnToDepot, setReturnToDepot] = useState<boolean>(true);
  const [showGreedyComparisonOnMap, setShowGreedyComparisonOnMap] =
    useState<boolean>(true);

  // MST State
  const [mstAlgo, setMstAlgo] = useState<MSTAlgo>('kruskal');

  // 60 FPS Street-Wave Animation State
  const [waveProgress, setWaveProgress] = useState<number>(0);
  const [isPlayingWave, setIsPlayingWave] = useState<boolean>(true);
  const [waveSpeedMultiplier, setWaveSpeedMultiplier] = useState<number>(1.5);
  const rafRef = useRef<number | null>(null);

  const loadPreset = (newPreset: MapPreset) => {
    setPresetId(newPreset.id);
    setNodes(newPreset.nodes.map((n) => ({ ...n })));
    setEdges(newPreset.edges.map((e) => ({ ...e })));
    setStartNodeId(newPreset.defaultStartId);
    setEndNodeId(newPreset.defaultEndId);
    setDeliveryStops(newPreset.defaultDeliveryStopIds);
    setWaveProgress(0);
    setIsPlayingWave(true);
    setCameraTarget({
      lat: newPreset.bbox.centerLat,
      lng: newPreset.bbox.centerLng,
      zoom: newPreset.bbox.zoom || 15,
      ts: Date.now(),
    });
  };

  const handlePresetChange = (newPresetId: string) => {
    const found = presets.find((p) => p.id === newPresetId);
    if (found) loadPreset(found);
  };

  // Compute Shortest Path results
  const spComparison = useMemo(
    () =>
      compareShortestPathAlgorithms(nodes, edges, startNodeId, endNodeId),
    [nodes, edges, startNodeId, endNodeId]
  );

  const activeSPResult = useMemo(
    () => runShortestPathByAlgo(spAlgo, nodes, edges, startNodeId, endNodeId),
    [spAlgo, nodes, edges, startNodeId, endNodeId]
  );

  const leftRaceResult = useMemo(
    () =>
      runShortestPathByAlgo(leftAlgo, nodes, edges, startNodeId, endNodeId),
    [leftAlgo, nodes, edges, startNodeId, endNodeId]
  );

  const rightRaceResult = useMemo(
    () =>
      runShortestPathByAlgo(rightAlgo, nodes, edges, startNodeId, endNodeId),
    [rightAlgo, nodes, edges, startNodeId, endNodeId]
  );

  // Compute TSP results
  const tspComparison = useMemo(
    () =>
      compareMultiStopTSP(
        nodes,
        edges,
        startNodeId,
        deliveryStops,
        returnToDepot
      ),
    [nodes, edges, startNodeId, deliveryStops, returnToDepot]
  );

  const activeTSPResult =
    tspAlgo === 'held-karp-dp'
      ? tspComparison.heldKarpDP
      : tspComparison.greedyNN;

  // Compute MST results
  const kruskalResult = useMemo(
    () => runKruskalMST(nodes, edges),
    [nodes, edges]
  );
  const primResult = useMemo(
    () => runPrimMST(nodes, edges, startNodeId),
    [nodes, edges, startNodeId]
  );
  const activeMSTResult = mstAlgo === 'kruskal' ? kruskalResult : primResult;

  const maxWaveEdges = useMemo(() => {
    if (mode !== 'shortest-path') return 1;
    if (splitRaceMode) {
      return Math.max(
        1,
        leftRaceResult.exploredEdges.length,
        rightRaceResult.exploredEdges.length
      );
    }
    return Math.max(1, activeSPResult.exploredEdges.length);
  }, [
    mode,
    splitRaceMode,
    leftRaceResult.exploredEdges.length,
    rightRaceResult.exploredEdges.length,
    activeSPResult.exploredEdges.length,
  ]);

  const currentTick = Math.round(waveProgress * maxWaveEdges);

  // 60 FPS requestAnimationFrame loop
  useEffect(() => {
    if (!isPlayingWave) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    let lastTime = performance.now();
    const animate = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const increment = (dt / 2.8) * waveSpeedMultiplier;
      setWaveProgress((prev) => {
        if (prev + increment >= 1) {
          setIsPlayingWave(false);
          return 1;
        }
        return prev + increment;
      });

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlayingWave, waveSpeedMultiplier]);

  const triggerWaveReplay = () => {
    setWaveProgress(0);
    setIsPlayingWave(true);
  };

  // Option C: Use My Current Location (Browser GPS with IP-geolocation fallback)
  const handleUseMyCurrentLocation = async (
    role: 'start' | 'end' | 'area' = 'start'
  ) => {
    if (locatingGPS) return;
    setLocatingGPS(true);
    setOsmStatusMsg('Detecting your current location...');

    const getCoords = (): Promise<{ lat: number; lng: number }> =>
      new Promise((resolve, reject) => {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) =>
              resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
              }),
            async () => {
              // Fallback to IP geolocation if browser permission denied or unavailable
              try {
                const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
                const data = (await res.json()) as {
                  latitude?: string;
                  longitude?: string;
                };
                if (data.latitude && data.longitude) {
                  resolve({
                    lat: parseFloat(data.latitude),
                    lng: parseFloat(data.longitude),
                  });
                  return;
                }
              } catch {
                // ignore
              }
              reject(
                new Error(
                  'Location permission denied. Please allow browser location access.'
                )
              );
            },
            { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
          );
        } else {
          reject(new Error('Geolocation is not supported by this browser.'));
        }
      });

    try {
      const { lat, lng } = await getCoords();
      const areaName = await reverseGeocodeOpenStreetMap(lat, lng);
      const myLocLabel = `My Location (${areaName})`;

      const distLat = Math.abs(lat - activePreset.bbox.centerLat);
      const distLng = Math.abs(lng - activePreset.bbox.centerLng);

      if (role === 'area' || distLat > 0.08 || distLng > 0.08) {
        setOsmStatusMsg(`Loading real street network around ${myLocLabel}...`);
        const livePreset = await fetchStreetNetworkByCoords(lat, lng, areaName);
        const { newNode, updatedNodes, updatedEdges } = addCustomNodeToNetwork(
          livePreset.bbox,
          livePreset.nodes,
          livePreset.edges,
          {
            name: myLocLabel,
            lat,
            lng,
            category: 'depot',
            zone: 'Current GPS Location',
          }
        );
        const enrichedPreset: MapPreset = {
          ...livePreset,
          nodes: updatedNodes,
          edges: updatedEdges,
          defaultStartId:
            role === 'end' ? livePreset.defaultStartId : newNode.id,
          defaultEndId: role === 'end' ? newNode.id : livePreset.defaultEndId,
        };
        setPresets((prev) => [enrichedPreset, ...prev]);
        loadPreset(enrichedPreset);
        setOsmStatusMsg(`Centered at ${myLocLabel}`);
      } else {
        await handleAddCustomLocationAtLatLng(
          lat,
          lng,
          role === 'end' ? 'end' : 'start',
          myLocLabel
        );
        setOsmStatusMsg(`Pinned ${myLocLabel}`);
      }
      setSearchFocused(false);
    } catch (err) {
      setOsmStatusMsg(
        err instanceof Error
          ? err.message
          : 'Could not detect current location.'
      );
    } finally {
      setLocatingGPS(false);
    }
  };

  // Search OpenStreetMap Nominatim for places/addresses
  const handleSearchNominatim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!osmQuery.trim() || osmLoading) return;
    setOsmLoading(true);
    setOsmStatusMsg(null);
    try {
      const results = await searchOpenStreetMapPlaces(osmQuery);
      setOsmSuggestions(results);
      if (results.length === 0) {
        setOsmStatusMsg(`No results found on OpenStreetMap for "${osmQuery}".`);
      }
    } catch (err) {
      setOsmStatusMsg(
        err instanceof Error
          ? err.message
          : 'Could not reach OpenStreetMap Nominatim.'
      );
    } finally {
      setOsmLoading(false);
    }
  };

  // Option A: Load entire street network around a searched OpenStreetMap place
  const handleLoadAreaStreetNetwork = async (place: NominatimSearchResult) => {
    setOsmLoading(true);
    setOsmStatusMsg(`Fetching real street network around ${place.name}...`);
    try {
      const livePreset = await fetchStreetNetworkByCoords(
        place.lat,
        place.lng,
        place.name
      );
      setPresets((prev) => [livePreset, ...prev]);
      loadPreset(livePreset);
      setOsmSuggestions([]);
      setOsmQuery('');
      setOsmStatusMsg(null);
    } catch (err) {
      setOsmStatusMsg(
        err instanceof Error
          ? err.message
          : 'Failed to load street graph from Overpass API.'
      );
    } finally {
      setOsmLoading(false);
    }
  };

  // Option B: Add a custom location at any (lat, lng) on the map (from clicking the map, right-clicking, or searching!)
  // Automatically expands the street network across the FULL distance between Start (A) and Target (B) when outside current bounds!
  const handleAddCustomLocationAtLatLng = async (
    lat: number,
    lng: number,
    role: 'custom' | 'start' | 'end' | 'stop',
    explicitName?: string
  ) => {
    let resolvedName = explicitName?.trim();
    if (!resolvedName) {
      resolvedName = await reverseGeocodeOpenStreetMap(lat, lng);
    }

    const bbox = activePreset.bbox;
    const latMargin = (bbox.maxLat - bbox.minLat) * 0.12;
    const lngMargin = (bbox.maxLng - bbox.minLng) * 0.12;
    const isInsideCurrentGrid =
      lat >= bbox.minLat + latMargin &&
      lat <= bbox.maxLat - latMargin &&
      lng >= bbox.minLng + lngMargin &&
      lng <= bbox.maxLng - lngMargin;

    if (!isInsideCurrentGrid) {
      // The chosen location is outside the current street grid!
      // Dynamically build a full-span street network covering BOTH Origin (A) and Target (B) across ANY distance!
      const currentStartNode =
        nodes.find((n) => n.id === startNodeId) ?? nodes[0];
      const currentEndNode =
        nodes.find((n) => n.id === endNodeId) ?? nodes[nodes.length - 1];

      const startPt =
        role === 'start'
          ? { name: resolvedName, lat, lng }
          : {
              name: currentStartNode.name,
              lat: currentStartNode.lat ?? bbox.centerLat,
              lng: currentStartNode.lng ?? bbox.centerLng,
            };

      const endPt =
        role === 'start'
          ? {
              name: currentEndNode.name,
              lat: currentEndNode.lat ?? bbox.centerLat,
              lng: currentEndNode.lng ?? bbox.centerLng,
            }
          : { name: resolvedName, lat, lng };

      setOsmLoading(true);
      setOsmStatusMsg(
        `Expanding street network across full distance: ${startPt.name.split(',')[0]} ↔ ${endPt.name.split(',')[0]}...`
      );
      try {
        const spanningPreset = await buildSpanningNetworkForLocations({
          startPoint: startPt,
          endPoint: endPt,
        });
        setPresets((prev) => [spanningPreset, ...prev]);
        loadPreset(spanningPreset);
        setOsmSuggestions([]);
        setOsmStatusMsg(null);
      } finally {
        setOsmLoading(false);
      }
      return;
    }

    const { newNode, updatedNodes, updatedEdges } = addCustomNodeToNetwork(
      activePreset.bbox,
      nodes,
      edges,
      {
        name: resolvedName,
        lat,
        lng,
        category: role === 'start' ? 'depot' : 'commercial',
        zone: 'Custom Location',
      }
    );

    setNodes(updatedNodes);
    setEdges(updatedEdges);

    if (role === 'start') {
      setStartNodeId(newNode.id);
    } else if (role === 'end') {
      setEndNodeId(newNode.id);
    } else if (role === 'stop') {
      setDeliveryStops((prev) =>
        prev.length < 9 ? [...prev, newNode.id] : prev
      );
    } else {
      setEndNodeId(newNode.id);
    }

    setCameraTarget({ lat, lng, ts: Date.now() });
    setOsmSuggestions([]);
    triggerWaveReplay();
  };

  // Interactive Node Selection
  const handleSelectNode = (nodeId: string) => {
    if (mode === 'shortest-path') {
      if (brushMode === 'pick-start') {
        if (nodeId === endNodeId) return;
        setStartNodeId(nodeId);
      } else {
        if (nodeId === startNodeId) return;
        setEndNodeId(nodeId);
      }
      triggerWaveReplay();
    } else if (mode === 'tsp-delivery') {
      if (brushMode === 'pick-start') {
        setStartNodeId(nodeId);
        setDeliveryStops((prev) => prev.filter((id) => id !== nodeId));
      } else {
        if (nodeId === startNodeId) return;
        setDeliveryStops((prev) =>
          prev.includes(nodeId)
            ? prev.filter((id) => id !== nodeId)
            : prev.length < 9
              ? [...prev, nodeId]
              : prev
        );
      }
    } else {
      setStartNodeId(nodeId);
    }
  };

  // Traffic / Blockade Brush Painting
  const handlePaintEdges = (edgeIds: string[], brush: MapBrushMode) => {
    const idSet = new Set(edgeIds);
    setEdges((prev) =>
      prev.map((edge) => {
        if (!idSet.has(edge.id)) return edge;
        if (brush === 'brush-block') return { ...edge, blocked: true };
        if (brush === 'brush-gridlock')
          return { ...edge, blocked: false, trafficLevel: 3 as TrafficLevel };
        if (brush === 'brush-heavy')
          return { ...edge, blocked: false, trafficLevel: 2 as TrafficLevel };
        if (brush === 'brush-clear')
          return { ...edge, blocked: false, trafficLevel: 1 as TrafficLevel };
        return edge;
      })
    );
  };

  const handleRandomizeRushHour = () => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const epicenters = [
      { x: 350 + Math.random() * 260, y: 180 + Math.random() * 240, r: 95 },
      { x: 220 + Math.random() * 480, y: 150 + Math.random() * 280, r: 80 },
    ];

    setEdges((prev) =>
      prev.map((e) => {
        const u = nodeMap.get(e.from);
        const v = nodeMap.get(e.to);
        if (!u || !v) return e;
        const mx = (u.x + v.x) / 2;
        const my = (u.y + v.y) / 2;
        for (const ep of epicenters) {
          const d = Math.hypot(mx - ep.x, my - ep.y);
          if (d < ep.r * 0.45) {
            return { ...e, blocked: false, trafficLevel: 3 as TrafficLevel };
          }
          if (d < ep.r) {
            return { ...e, blocked: false, trafficLevel: 2 as TrafficLevel };
          }
        }
        return { ...e, blocked: false, trafficLevel: 1 as TrafficLevel };
      })
    );
    triggerWaveReplay();
  };

  const handleResetRoads = () => {
    setEdges(activePreset.edges.map((e) => ({ ...e })));
    triggerWaveReplay();
  };

  const landmarkNodes = useMemo(
    () => nodes.filter((n) => n.isLandmark),
    [nodes]
  );

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const spChartData = useMemo(
    () => [
      {
        name: 'A* Search',
        'Streets Explored': spComparison.astar.exploredEdges.length,
        'Effective Cost (km)': spComparison.astar.totalEffectiveKm,
      },
      {
        name: 'Bidirectional',
        'Streets Explored': spComparison.bidirectional.exploredEdges.length,
        'Effective Cost (km)': spComparison.bidirectional.totalEffectiveKm,
      },
      {
        name: 'Dijkstra',
        'Streets Explored': spComparison.dijkstra.exploredEdges.length,
        'Effective Cost (km)': spComparison.dijkstra.totalEffectiveKm,
      },
      {
        name: 'Greedy BFS',
        'Streets Explored': spComparison.greedyBfs.exploredEdges.length,
        'Effective Cost (km)': spComparison.greedyBfs.totalEffectiveKm,
      },
    ],
    [spComparison]
  );

  const astarStreetSavingsPct =
    spComparison.dijkstra.exploredEdges.length > 0
      ? Math.max(
          0,
          Math.round(
            ((spComparison.dijkstra.exploredEdges.length -
              spComparison.astar.exploredEdges.length) /
              spComparison.dijkstra.exploredEdges.length) *
              100
          )
        )
      : 0;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 select-none">
      {/* =====================================================================
          1. FULL-SCREEN GOOGLE MAPS INTERACTIVE VIEWPORT (100vw x 100vh)
         ===================================================================== */}
      {mode === 'shortest-path' && splitRaceMode ? (
        <div className="grid h-full w-full grid-cols-1 lg:grid-cols-2 bg-slate-950">
          <div className="relative h-full w-full border-r border-slate-800">
            <RealMapStreetCanvas
              nodes={nodes}
              edges={edges}
              bbox={activePreset.bbox}
              startNodeId={startNodeId}
              endNodeId={endNodeId}
              exploredEdges={leftRaceResult.exploredEdges}
              waveCursor={currentTick}
              activeRouteEdgeIds={leftRaceResult.pathEdgeIds}
              meetingNodeId={leftRaceResult.meetingNodeId}
              showRouteNow={currentTick >= leftRaceResult.exploredEdges.length}
              brushMode={brushMode}
              tileStyle={tileStyle}
              onTileStyleChange={setTileStyle}
              badgeTitle={`LEFT: ${ALGO_META[leftAlgo].short}`}
              badgeSubtitle={ALGO_META[leftAlgo].subtitle}
              badgeMetrics={{
                exploredCount: leftRaceResult.exploredEdges.length,
                totalEdges: edges.length,
                routeKm: leftRaceResult.totalEffectiveKm,
                etaMin: leftRaceResult.estimatedMinutes,
                isOptimal: ALGO_META[leftAlgo].isOptimal,
              }}
              fullScreen
              externalCameraTarget={cameraTarget}
              onSelectNode={handleSelectNode}
              onAddCustomLocationAtLatLng={handleAddCustomLocationAtLatLng}
              onPaintEdges={handlePaintEdges}
            />
          </div>

          <div className="relative h-full w-full">
            <RealMapStreetCanvas
              nodes={nodes}
              edges={edges}
              bbox={activePreset.bbox}
              startNodeId={startNodeId}
              endNodeId={endNodeId}
              exploredEdges={rightRaceResult.exploredEdges}
              waveCursor={currentTick}
              activeRouteEdgeIds={rightRaceResult.pathEdgeIds}
              meetingNodeId={rightRaceResult.meetingNodeId}
              showRouteNow={currentTick >= rightRaceResult.exploredEdges.length}
              brushMode={brushMode}
              tileStyle={tileStyle}
              onTileStyleChange={setTileStyle}
              badgeTitle={`RIGHT: ${ALGO_META[rightAlgo].short}`}
              badgeSubtitle={ALGO_META[rightAlgo].subtitle}
              badgeMetrics={{
                exploredCount: rightRaceResult.exploredEdges.length,
                totalEdges: edges.length,
                routeKm: rightRaceResult.totalEffectiveKm,
                etaMin: rightRaceResult.estimatedMinutes,
                isOptimal: ALGO_META[rightAlgo].isOptimal,
              }}
              fullScreen
              externalCameraTarget={cameraTarget}
              onSelectNode={handleSelectNode}
              onAddCustomLocationAtLatLng={handleAddCustomLocationAtLatLng}
              onPaintEdges={handlePaintEdges}
            />
          </div>
        </div>
      ) : (
        <RealMapStreetCanvas
          nodes={nodes}
          edges={edges}
          bbox={activePreset.bbox}
          startNodeId={startNodeId}
          endNodeId={endNodeId}
          deliveryStopIds={mode === 'tsp-delivery' ? deliveryStops : []}
          orderedTourStopIds={
            mode === 'tsp-delivery' ? activeTSPResult.orderedStopIds : []
          }
          exploredEdges={
            mode === 'shortest-path' ? activeSPResult.exploredEdges : []
          }
          waveCursor={
            mode === 'shortest-path'
              ? Math.round(waveProgress * activeSPResult.exploredEdges.length)
              : 0
          }
          activeRouteEdgeIds={
            mode === 'shortest-path'
              ? activeSPResult.pathEdgeIds
              : mode === 'tsp-delivery'
                ? activeTSPResult.fullPathEdgeIds
                : []
          }
          secondaryRouteEdgeIds={
            mode === 'tsp-delivery' &&
            showGreedyComparisonOnMap &&
            tspAlgo === 'held-karp-dp'
              ? tspComparison.greedyNN.fullPathEdgeIds
              : []
          }
          mstEdgeIds={
            mode === 'mst-fiber' ? activeMSTResult.selectedEdgeIds : []
          }
          meetingNodeId={
            mode === 'shortest-path'
              ? activeSPResult.meetingNodeId
              : undefined
          }
          showRouteNow={mode !== 'shortest-path' || waveProgress >= 0.98}
          brushMode={brushMode}
          tileStyle={tileStyle}
          onTileStyleChange={setTileStyle}
          badgeTitle={
            mode === 'shortest-path'
              ? ALGO_META[spAlgo].title
              : mode === 'tsp-delivery'
                ? tspAlgo === 'held-karp-dp'
                  ? 'Held-Karp Bitmask DP Tour'
                  : 'Greedy Nearest-Neighbor Tour'
                : mstAlgo === 'kruskal'
                  ? "Kruskal's MST (Union-Find)"
                  : "Prim's MST (Cut Frontier)"
          }
          badgeSubtitle={activePreset.subtitle}
          badgeMetrics={
            mode === 'shortest-path'
              ? {
                  exploredCount: activeSPResult.exploredEdges.length,
                  totalEdges: edges.length,
                  routeKm: activeSPResult.totalEffectiveKm,
                  etaMin: activeSPResult.estimatedMinutes,
                  isOptimal: ALGO_META[spAlgo].isOptimal,
                }
              : undefined
          }
          fullScreen
          externalCameraTarget={cameraTarget}
          onSelectNode={handleSelectNode}
          onAddCustomLocationAtLatLng={handleAddCustomLocationAtLatLng}
          onPaintEdges={handlePaintEdges}
        />
      )}

      {/* =====================================================================
          2. GOOGLE MAPS FLOATING LEFT DIRECTIONS & SEARCH SIDEBAR
         ===================================================================== */}
      <aside
        aria-label="Google Maps Navigation & Custom Location Panel"
        className={`absolute top-3 left-3 z-30 flex flex-col max-h-[calc(100vh-24px)] w-[390px] max-w-[calc(100vw-24px)] rounded-2xl border border-slate-700/80 bg-slate-900/95 text-slate-100 shadow-2xl backdrop-blur-xl transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-[405px]'
        }`}
      >
        {/* Sidebar Collapse/Expand Handle */}
        <button
          type="button"
          onClick={() => setSidebarOpen((p) => !p)}
          aria-label={sidebarOpen ? 'Collapse side panel' : 'Expand side panel'}
          className="absolute -right-10 top-4 flex h-9 w-9 items-center justify-center rounded-r-xl border border-l-0 border-slate-700 bg-slate-900/95 text-slate-200 shadow-lg hover:bg-slate-800 cursor-pointer"
        >
          {sidebarOpen ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        {/* Scrollable Inner Sidebar Content */}
        <div className="overflow-y-auto p-4 space-y-3.5">
          {/* App Brand + OpenStreetMap Live Search Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow">
                <Navigation className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-extrabold tracking-tight text-white">
                  RoutePulse Maps
                </h1>
                <p className="text-[10px] text-slate-400">
                  OpenStreetMap Live Routing &amp; DAA Visualizer
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setBrushMode((prev) =>
                  prev === 'add-custom-pin' ? 'pan-explore' : 'add-custom-pin'
                );
                setShowAddCustomForm((prev) => !prev);
              }}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition cursor-pointer ${
                brushMode === 'add-custom-pin' || showAddCustomForm
                  ? 'bg-purple-600 text-white shadow'
                  : 'bg-purple-500/15 text-purple-300 border border-purple-500/40 hover:bg-purple-500/25'
              }`}
            >
              <PlusCircle className="h-3.5 w-3.5" />
              + Custom Location
            </button>
          </div>

          {/* Search Any OpenStreetMap Place / Address / City */}
          <form onSubmit={handleSearchNominatim} className="relative">
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="osm-global-search"
                className="block text-[11px] font-semibold text-slate-300"
              >
                Search OpenStreetMap (Any Place, Address, or City):
              </label>
              <button
                type="button"
                onClick={() => handleUseMyCurrentLocation('start')}
                disabled={locatingGPS}
                className="flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 cursor-pointer"
              >
                {locatingGPS ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <LocateFixed className="h-3 w-3 text-emerald-400" />
                )}
                Use My Location
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  id="osm-global-search"
                  name="q"
                  type="text"
                  value={osmQuery}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => {
                    // Delay slightly so clicks on dropdown buttons register cleanly
                    setTimeout(() => setSearchFocused(false), 200);
                  }}
                  onChange={(e) => setOsmQuery(e.target.value)}
                  placeholder="Search place, college, street, or choose My Location..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-8 pr-8 py-2 text-xs text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleUseMyCurrentLocation('start')}
                  disabled={locatingGPS}
                  aria-label="Use my current GPS location"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-emerald-400 hover:bg-slate-800 cursor-pointer"
                >
                  {locatingGPS ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LocateFixed className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <button
                type="submit"
                disabled={osmLoading}
                className="flex items-center gap-1 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
              >
                {osmLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  'Search'
                )}
              </button>
            </div>

            {/* Google Maps-style "My Current Location" Quick Option when Search is Focused */}
            {(searchFocused || osmSuggestions.length > 0) && (
              <div className="mt-2 rounded-xl border border-slate-700 bg-slate-950 p-1.5 shadow-2xl space-y-1.5">
                {/* Always-visible "My Current Location" row at top of search dropdown */}
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-emerald-300 flex items-center gap-1.5">
                      <LocateFixed className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      <span>My Current Location (Live GPS)</span>
                    </div>
                    {locatingGPS && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleUseMyCurrentLocation('start')}
                      className="rounded bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/30 cursor-pointer"
                    >
                      Set as Start (A)
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleUseMyCurrentLocation('end')}
                      className="rounded bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-[10px] font-bold text-rose-300 hover:bg-rose-500/30 cursor-pointer"
                    >
                      Set as Target (B)
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleUseMyCurrentLocation('area')}
                      className="rounded bg-blue-500/20 border border-blue-500/40 px-2 py-0.5 text-[10px] font-bold text-blue-300 hover:bg-blue-500/30 cursor-pointer"
                    >
                      Load My Area Map
                    </button>
                  </div>
                </div>

                {osmSuggestions.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-2 py-0.5 text-[10px] text-slate-400">
                      <span>OpenStreetMap Results (Choose action):</span>
                      <button
                        type="button"
                        onClick={() => setOsmSuggestions([])}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        Close
                      </button>
                    </div>
                    {osmSuggestions.map((item) => (
                      <div
                        key={item.placeId}
                        className="rounded-lg border border-slate-800/80 bg-slate-900/90 p-2 text-xs hover:border-slate-700"
                      >
                        <div className="font-bold text-white flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                          <span className="truncate">{item.name}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate mt-0.5">
                          {item.fullAddress}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() =>
                              handleAddCustomLocationAtLatLng(
                                item.lat,
                                item.lng,
                                'start',
                                item.name
                              )
                            }
                            className="rounded bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/30 cursor-pointer"
                          >
                            Set as Start (A)
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() =>
                              handleAddCustomLocationAtLatLng(
                                item.lat,
                                item.lng,
                                'end',
                                item.name
                              )
                            }
                            className="rounded bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-[10px] font-bold text-rose-300 hover:bg-rose-500/30 cursor-pointer"
                          >
                            Set as Target (B)
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleLoadAreaStreetNetwork(item)}
                            className="rounded bg-blue-500/20 border border-blue-500/40 px-2 py-0.5 text-[10px] font-bold text-blue-300 hover:bg-blue-500/30 cursor-pointer"
                          >
                            Load Full Area Map
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {osmStatusMsg && (
              <div
                role="status"
                aria-live="polite"
                className="mt-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-[11px] text-blue-300"
              >
                {osmStatusMsg}
              </div>
            )}
          </form>

          {/* Expandable "+ Add Custom Location" Card */}
          {showAddCustomForm && (
            <div className="rounded-xl border border-purple-500/40 bg-purple-950/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" />
                  Add Custom Location on Real Map
                </span>
                <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-200">
                  Click Map or Right-Click
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Click <strong>anywhere on the map</strong> (or right-click any
                building/street) to drop a custom pin at that exact OpenStreetMap
                coordinate and connect it to the road graph!
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!customLocName.trim()) return;
                  handleAddCustomLocationAtLatLng(
                    activePreset.bbox.centerLat +
                      (Math.random() - 0.5) * 0.008,
                    activePreset.bbox.centerLng +
                      (Math.random() - 0.5) * 0.01,
                    customLocRole,
                    customLocName
                  );
                  setCustomLocName('');
                }}
                className="space-y-2 pt-1"
              >
                <div>
                  <label
                    htmlFor="custom-loc-name"
                    className="block text-[10px] font-semibold text-slate-300 mb-0.5"
                  >
                    Or Quick-Add Named Pin in Current View:
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      id="custom-loc-name"
                      type="text"
                      value={customLocName}
                      onChange={(e) => setCustomLocName(e.target.value)}
                      placeholder="e.g., My Apartment, Client Hub..."
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
                    />
                    <select
                      value={customLocRole}
                      onChange={(e) =>
                        setCustomLocRole(
                          e.target.value as 'start' | 'end' | 'stop' | 'custom'
                        )
                      }
                      aria-label="Custom location role"
                      className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200"
                    >
                      <option value="end">As Target (B)</option>
                      <option value="start">As Start (A)</option>
                      <option value="stop">As Stop (TSP)</option>
                      <option value="custom">Just Pin</option>
                    </select>
                    <button
                      type="submit"
                      className="rounded-lg bg-purple-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-purple-500 cursor-pointer"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* Google Maps 3-Mode Selector Tabs */}
          <div
            className="grid grid-cols-3 gap-1 rounded-xl bg-slate-950 p-1 border border-slate-800"
            role="tablist"
            aria-label="Google Maps Routing Modes"
          >
            <button
              role="tab"
              type="button"
              aria-selected={mode === 'shortest-path'}
              onClick={() => setMode('shortest-path')}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg py-2 text-[11px] font-bold transition cursor-pointer ${
                mode === 'shortest-path'
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Navigation className="h-3.5 w-3.5" />
              Directions
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={mode === 'tsp-delivery'}
              onClick={() => setMode('tsp-delivery')}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg py-2 text-[11px] font-bold transition cursor-pointer ${
                mode === 'tsp-delivery'
                  ? 'bg-amber-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Truck className="h-3.5 w-3.5" />
              Multi-Stop TSP
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={mode === 'mst-fiber'}
              onClick={() => setMode('mst-fiber')}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-lg py-2 text-[11px] font-bold transition cursor-pointer ${
                mode === 'mst-fiber'
                  ? 'bg-sky-400 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Network className="h-3.5 w-3.5" />
              Fiber MST
            </button>
          </div>

          {/* Google Maps Origin (A) & Destination (B) Directions Box */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-center gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                  A
                </span>
                <div className="h-5 w-0.5 bg-slate-700" />
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-[10px] font-bold text-white">
                  B
                </span>
              </div>

              <div className="flex-1 space-y-2">
                <div>
                  <label
                    htmlFor="gmaps-origin-select"
                    className="block text-[10px] font-semibold text-emerald-400 mb-0.5"
                  >
                    Starting Point (Origin A):
                  </label>
                  <select
                    id="gmaps-origin-select"
                    value={startNodeId}
                    onChange={(e) => {
                      setStartNodeId(e.target.value);
                      triggerWaveReplay();
                    }}
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                  >
                    {landmarkNodes.map((n) => (
                      <option
                        key={n.id}
                        value={n.id}
                        disabled={n.id === endNodeId}
                      >
                        {n.id.startsWith('CUSTOM-') ? '📌 ' : `[${n.shortCode}] `}
                        {n.name}
                      </option>
                    ))}
                    {!nodeMap.get(startNodeId)?.isLandmark && (
                      <option value={startNodeId}>
                        📍 {nodeMap.get(startNodeId)?.name ?? startNodeId}
                      </option>
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="gmaps-dest-select"
                    className="block text-[10px] font-semibold text-rose-400 mb-0.5"
                  >
                    Destination (Target B):
                  </label>
                  <select
                    id="gmaps-dest-select"
                    value={endNodeId}
                    onChange={(e) => {
                      setEndNodeId(e.target.value);
                      triggerWaveReplay();
                    }}
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                  >
                    {landmarkNodes.map((n) => (
                      <option
                        key={n.id}
                        value={n.id}
                        disabled={n.id === startNodeId}
                      >
                        {n.id.startsWith('CUSTOM-') ? '📌 ' : `[${n.shortCode}] `}
                        {n.name}
                      </option>
                    ))}
                    {!nodeMap.get(endNodeId)?.isLandmark && (
                      <option value={endNodeId}>
                        🏁 {nodeMap.get(endNodeId)?.name ?? endNodeId}
                      </option>
                    )}
                  </select>
                </div>
              </div>

              {/* Swap Origin & Destination Button */}
              <button
                type="button"
                onClick={() => {
                  const temp = startNodeId;
                  setStartNodeId(endNodeId);
                  setEndNodeId(temp);
                  triggerWaveReplay();
                }}
                aria-label="Swap starting point and destination"
                className="rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
              >
                <ArrowUpDown className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-1 pt-1 border-t border-slate-800/80 text-[10px] text-slate-400">
              <span>Tip: Click or right-click anywhere on the map to set pins!</span>
            </div>
          </div>

          {/* Mode-Specific Controls & Google Maps Route Card */}
          {mode === 'shortest-path' && (
            <div className="space-y-3">
              {/* Google Maps Primary Route Summary Card */}
              <div className="rounded-xl border border-blue-500/40 bg-gradient-to-br from-blue-950/50 to-slate-950 p-3.5 shadow-lg">
                <div className="flex items-baseline justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-extrabold text-emerald-400">
                      {activeSPResult.estimatedMinutes} min
                    </span>
                    <span className="text-sm font-bold text-slate-200">
                      ({activeSPResult.totalEffectiveKm} km)
                    </span>
                  </div>
                  <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                    Fastest Route
                  </span>
                </div>

                <div className="mt-1 text-xs text-slate-300">
                  via{' '}
                  <span className="font-semibold text-white">
                    {activeSPResult.legs[0]?.roadName ?? 'City Street Grid'}
                  </span>{' '}
                  · {activeSPResult.exploredEdges.length} streets scanned by{' '}
                  <span className="font-semibold text-cyan-300">
                    {ALGO_META[spAlgo].short}
                  </span>
                </div>

                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={triggerWaveReplay}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-1.5 text-xs font-bold text-white hover:bg-blue-500 cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Replay Street Wave
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDirectionsSteps((p) => !p)}
                    className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer"
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                    Steps ({activeSPResult.legs.length})
                    {showDirectionsSteps ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                  </button>
                </div>

                {/* Expandable Turn-by-Turn Google Maps Street Steps */}
                {showDirectionsSteps && (
                  <div className="mt-3 max-h-44 overflow-y-auto border-t border-slate-800 pt-2 space-y-1.5">
                    {activeSPResult.legs.map((leg) => (
                      <div
                        key={leg.stepNumber}
                        className="flex items-center justify-between rounded-lg bg-slate-900/90 px-2.5 py-1.5 text-[11px]"
                      >
                        <div className="truncate pr-2">
                          <span className="font-mono text-slate-400 mr-1.5">
                            {leg.stepNumber}.
                          </span>
                          <span className="font-semibold text-white">
                            {leg.roadName}
                          </span>
                          <span className="text-slate-400">
                            {' '}
                            → {leg.toNodeName}
                          </span>
                        </div>
                        <span className="font-mono text-[10px] text-emerald-400 shrink-0">
                          {leg.effectiveKm} km
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Algorithm Selector OR Split-Screen Race Selector */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Pathfinding Algorithm
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSplitRaceMode((p) => !p);
                      triggerWaveReplay();
                    }}
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold border cursor-pointer ${
                      splitRaceMode
                        ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50'
                        : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    {splitRaceMode ? (
                      <>
                        <Maximize2 className="h-3 w-3" />
                        Exit Split Race
                      </>
                    ) : (
                      <>
                        <Columns2 className="h-3 w-3" />
                        Split-Screen Race
                      </>
                    )}
                  </button>
                </div>

                {splitRaceMode ? (
                  <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-950 p-2.5">
                    <div>
                      <label
                        htmlFor="left-race-select"
                        className="block text-[10px] font-bold text-cyan-400 mb-1"
                      >
                        Left Map Contender:
                      </label>
                      <select
                        id="left-race-select"
                        value={leftAlgo}
                        onChange={(e) => {
                          setLeftAlgo(e.target.value as ShortestPathAlgo);
                          triggerWaveReplay();
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"
                      >
                        {(Object.keys(ALGO_META) as ShortestPathAlgo[]).map(
                          (k) => (
                            <option key={k} value={k}>
                              {ALGO_META[k].short}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="right-race-select"
                        className="block text-[10px] font-bold text-emerald-400 mb-1"
                      >
                        Right Map Contender:
                      </label>
                      <select
                        id="right-race-select"
                        value={rightAlgo}
                        onChange={(e) => {
                          setRightAlgo(e.target.value as ShortestPathAlgo);
                          triggerWaveReplay();
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"
                      >
                        {(Object.keys(ALGO_META) as ShortestPathAlgo[]).map(
                          (k) => (
                            <option key={k} value={k}>
                              {ALGO_META[k].short}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {(Object.keys(ALGO_META) as ShortestPathAlgo[]).map((k) => {
                      const active = spAlgo === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setSpAlgo(k);
                            triggerWaveReplay();
                          }}
                          className={`w-full rounded-xl px-3 py-2 text-left border transition cursor-pointer ${
                            active
                              ? 'bg-blue-600/20 border-blue-500/60 text-white'
                              : 'bg-slate-950/70 border-slate-800/80 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold">
                              {ALGO_META[k].title}
                            </span>
                            <span className="font-mono text-[10px] text-cyan-400">
                              {ALGO_META[k].complexity}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* DAA Insight Box */}
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-2.5 text-[11px] text-slate-300 flex items-start gap-2">
                <Sparkles className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong>A* vs. Dijkstra:</strong> A* scans{' '}
                  <span className="font-bold text-emerald-300">
                    {astarStreetSavingsPct}% fewer streets
                  </span>{' '}
                  ({spComparison.astar.exploredEdges.length} vs.{' '}
                  {spComparison.dijkstra.exploredEdges.length}) for the exact
                  same {spComparison.astar.totalEffectiveKm} km optimal path!
                </div>
              </div>
            </div>
          )}

          {mode === 'tsp-delivery' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTspAlgo('held-karp-dp')}
                  className={`rounded-xl p-2.5 text-left border cursor-pointer ${
                    tspAlgo === 'held-karp-dp'
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="text-xs font-bold text-emerald-300">
                    Held-Karp DP
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    O(2^k · k²) Exact
                  </div>
                  <div className="mt-1 font-mono text-sm font-extrabold text-white">
                    {tspComparison.heldKarpDP.totalEffectiveKm} km
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setTspAlgo('greedy-nn')}
                  className={`rounded-xl p-2.5 text-left border cursor-pointer ${
                    tspAlgo === 'greedy-nn'
                      ? 'bg-amber-500/20 border-amber-500/50 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="text-xs font-bold text-amber-300">
                    Greedy Nearest
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    O(k²) Heuristic
                  </div>
                  <div className="mt-1 font-mono text-sm font-extrabold text-white">
                    {tspComparison.greedyNN.totalEffectiveKm} km
                  </div>
                </button>
              </div>

              <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
                <span>Return to Starting Depot (Round-Trip)</span>
                <input
                  type="checkbox"
                  checked={returnToDepot}
                  onChange={(e) => setReturnToDepot(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer">
                <span>Show Dashed Greedy Comparison on Map</span>
                <input
                  type="checkbox"
                  checked={showGreedyComparisonOnMap}
                  onChange={(e) =>
                    setShowGreedyComparisonOnMap(e.target.checked)
                  }
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-2.5">
                <div className="text-[11px] font-bold text-slate-400 mb-1.5">
                  Optimal Multi-Stop Sequence ({deliveryStops.length} stops):
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {activeTSPResult.orderedStopIds.map((id, i) => (
                    <React.Fragment key={`${id}-${i}`}>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-slate-200">
                        {nodeMap.get(id)?.shortCode ?? id}
                      </span>
                      {i < activeTSPResult.orderedStopIds.length - 1 && (
                        <ArrowRight className="h-3 w-3 text-slate-500" />
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode === 'mst-fiber' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMstAlgo('kruskal')}
                  className={`rounded-xl p-2.5 text-left border cursor-pointer ${
                    mstAlgo === 'kruskal'
                      ? 'bg-sky-500/20 border-sky-500/50 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="text-xs font-bold text-sky-300">
                    Kruskal&apos;s MST
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    O(E log E) Union-Find
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setMstAlgo('prim')}
                  className={`rounded-xl p-2.5 text-left border cursor-pointer ${
                    mstAlgo === 'prim'
                      ? 'bg-sky-500/20 border-sky-500/50 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="text-xs font-bold text-sky-300">
                    Prim&apos;s MST
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    O(E log V) Cut Property
                  </div>
                </button>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-1">
                <div className="text-xs text-slate-400">
                  Minimum Spanning Tree Cable Length:
                </div>
                <div className="text-xl font-extrabold text-sky-400 font-mono">
                  {activeMSTResult.totalCableKm} km
                </div>
                <div className="text-[11px] text-emerald-400">
                  Saves {activeMSTResult.cableSavedPercent}% (
                  {activeMSTResult.cableSavedKm} km) of redundant road trenching
                  across {nodes.length} locations!
                </div>
              </div>
            </div>
          )}

          {/* Toggle DAA Empirical Benchmark Chart Drawer */}
          <button
            type="button"
            onClick={() => setShowBenchmarkDrawer((p) => !p)}
            className="w-full flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <BarChart3 className="h-3.5 w-3.5 text-amber-400" />
              DAA Empirical Benchmark Chart
            </span>
            {showBenchmarkDrawer ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>

          {showBenchmarkDrawer && (
            <div className="h-44 w-full rounded-xl border border-slate-800 bg-slate-950 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={spChartData}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis type="number" stroke="#94a3b8" fontSize={10} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="#e2e8f0"
                    fontSize={10}
                    width={80}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      borderColor: '#334155',
                      borderRadius: '0.5rem',
                      fontSize: '11px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '10px' }} />
                  <Bar
                    dataKey="Streets Explored"
                    fill="#38bdf8"
                    radius={[0, 4, 4, 0]}
                  />
                  <Bar
                    dataKey="Effective Cost (km)"
                    fill="#10b981"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </aside>

      {/* =====================================================================
          3. FLOATING TOP-CENTER GOOGLE MAPS CATEGORY / CITY PILLS & MAP TOOLS
         ===================================================================== */}
      <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2 flex flex-wrap items-center justify-center gap-1.5 px-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/95 px-2.5 py-1.5 shadow-xl backdrop-blur-md">
          <Globe className="h-3.5 w-3.5 text-blue-400 ml-1" />
          {presets.slice(0, 5).map((p) => {
            const active = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePresetChange(p.id)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {p.cityTag}
              </button>
            );
          })}
        </div>

        {/* Map Interaction Tool Pills */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/95 px-2.5 py-1.5 shadow-xl backdrop-blur-md">
          <button
            type="button"
            onClick={() => setBrushMode('pan-explore')}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'pan-explore'
                ? 'bg-slate-700 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Hand className="h-3 w-3" />
            Pan / Click
          </button>
          <button
            type="button"
            onClick={() => setBrushMode('add-custom-pin')}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'add-custom-pin'
                ? 'bg-purple-600 text-white'
                : 'text-purple-300 hover:bg-slate-800'
            }`}
          >
            <MapPin className="h-3 w-3" />
            Drop Custom Pin
          </button>
          <button
            type="button"
            onClick={() => setBrushMode('pick-start')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'pick-start'
                ? 'bg-emerald-600 text-white'
                : 'text-emerald-300 hover:bg-slate-800'
            }`}
          >
            Pin A
          </button>
          <button
            type="button"
            onClick={() => setBrushMode('pick-end')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'pick-end'
                ? 'bg-rose-600 text-white'
                : 'text-rose-300 hover:bg-slate-800'
            }`}
          >
            Pin B
          </button>
          <button
            type="button"
            onClick={() => setBrushMode('brush-heavy')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'brush-heavy'
                ? 'bg-amber-500 text-slate-950 font-bold'
                : 'text-amber-300 hover:bg-slate-800'
            }`}
          >
            Traffic 2.2x
          </button>
          <button
            type="button"
            onClick={() => setBrushMode('brush-block')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
              brushMode === 'brush-block'
                ? 'bg-rose-600 text-white font-bold'
                : 'text-rose-300 hover:bg-slate-800'
            }`}
          >
            Block Road
          </button>
          <button
            type="button"
            onClick={handleRandomizeRushHour}
            className="flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/30 cursor-pointer"
          >
            <Flame className="h-3 w-3" />
            Rush Hour
          </button>
          <button
            type="button"
            onClick={handleResetRoads}
            className="flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-700 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>

      {/* =====================================================================
          4. FLOATING BOTTOM-CENTER STREET-WAVE TIMELINE PLAYER
         ===================================================================== */}
      {mode === 'shortest-path' && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-3 rounded-full border border-slate-700/80 bg-slate-900/95 px-4 py-2 shadow-2xl backdrop-blur-md">
          <button
            type="button"
            onClick={() => {
              if (waveProgress >= 1) {
                setWaveProgress(0);
                setIsPlayingWave(true);
              } else {
                setIsPlayingWave((p) => !p);
              }
            }}
            className="flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-blue-500 cursor-pointer"
          >
            {isPlayingWave ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                {waveProgress >= 1 ? 'Replay Wave' : 'Play'}
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-cyan-400" />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(waveProgress * 100)}
              onChange={(e) => {
                setIsPlayingWave(false);
                setWaveProgress(Number(e.target.value) / 100);
              }}
              aria-label="Street wave exploration progress"
              className="w-32 sm:w-44 accent-blue-500 cursor-pointer"
            />
            <span className="font-mono text-xs font-bold text-cyan-300 w-9 text-right">
              {Math.round(waveProgress * 100)}%
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1 border-l border-slate-800 pl-2">
            {[0.75, 1.5, 3].map((spd) => (
              <button
                key={spd}
                type="button"
                onClick={() => setWaveSpeedMultiplier(spd)}
                className={`rounded-full px-2 py-0.5 text-[11px] font-mono font-bold cursor-pointer ${
                  waveSpeedMultiplier === spd
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
