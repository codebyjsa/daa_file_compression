import {
  type MapNode,
  type MapEdge,
  computeEuclideanKm,
  getEffectiveEdgeWeight,
  weightToMinutes,
} from './graphTypes.ts';

export type ShortestPathAlgo =
  | 'dijkstra'
  | 'astar'
  | 'bidirectional'
  | 'greedy-bfs'
  | 'bellman-ford';

export interface RouteLeg {
  stepNumber: number;
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  edgeId: string;
  roadName: string;
  physicalKm: number;
  effectiveKm: number;
  trafficLevel: 1 | 2 | 3;
  minutes: number;
}

export interface ExploredEdgeStep {
  edgeId: string;
  fromId: string;
  toId: string;
  waveOrigin: 'forward' | 'backward';
}

export interface SearchWaveStep {
  stepIndex: number;
  currentNodeId: string;
  currentNodeName: string;
  visitedNodeIds: string[];
  frontierNodeIds: string[];
  gScore: number;
  fScore: number;
  description: string;
}

export interface ShortestPathResult {
  algorithm: ShortestPathAlgo;
  reachable: boolean;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  legs: RouteLeg[];
  totalPhysicalKm: number;
  totalEffectiveKm: number;
  estimatedMinutes: number;
  visitedOrder: string[];
  exploredEdges: ExploredEdgeStep[];
  waveSteps: SearchWaveStep[];
  nodesExplored: number;
  relaxationOps: number;
  executionTimeMs: number;
  meetingNodeId?: string;
}

interface AdjacencyEntry {
  neighborId: string;
  edge: MapEdge;
  weight: number;
}

function buildAdjacencyList(
  nodes: MapNode[],
  edges: MapEdge[]
): Map<string, AdjacencyEntry[]> {
  const adj = new Map<string, AdjacencyEntry[]>();
  for (const n of nodes) {
    adj.set(n.id, []);
  }
  for (const edge of edges) {
    if (edge.blocked) continue;
    const w = getEffectiveEdgeWeight(edge);
    if (!Number.isFinite(w)) continue;
    adj.get(edge.from)?.push({ neighborId: edge.to, edge, weight: w });
    adj.get(edge.to)?.push({ neighborId: edge.from, edge, weight: w });
  }
  return adj;
}

function buildLegsFromNodeSequence(
  nodes: MapNode[],
  pathNodeIds: string[],
  pathEdges: MapEdge[]
): {
  reachable: boolean;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  legs: RouteLeg[];
  totalPhysicalKm: number;
  totalEffectiveKm: number;
  estimatedMinutes: number;
} {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const legs: RouteLeg[] = [];
  let totalPhysicalKm = 0;
  let totalEffectiveKm = 0;

  for (let i = 0; i < pathEdges.length; i++) {
    const uId = pathNodeIds[i];
    const vId = pathNodeIds[i + 1];
    const edge = pathEdges[i];
    const effKm = getEffectiveEdgeWeight(edge);
    const mins = weightToMinutes(effKm);

    totalPhysicalKm += edge.baseDistanceKm;
    totalEffectiveKm += effKm;

    legs.push({
      stepNumber: i + 1,
      fromNodeId: uId,
      fromNodeName: nodeMap.get(uId)?.name ?? uId,
      toNodeId: vId,
      toNodeName: nodeMap.get(vId)?.name ?? vId,
      edgeId: edge.id,
      roadName: edge.roadName,
      physicalKm: Number(edge.baseDistanceKm.toFixed(2)),
      effectiveKm: Number(effKm.toFixed(2)),
      trafficLevel: edge.trafficLevel,
      minutes: mins,
    });
  }

  return {
    reachable: true,
    pathNodeIds,
    pathEdgeIds: pathEdges.map((e) => e.id),
    legs,
    totalPhysicalKm: Number(totalPhysicalKm.toFixed(2)),
    totalEffectiveKm: Number(totalEffectiveKm.toFixed(2)),
    estimatedMinutes: weightToMinutes(totalEffectiveKm),
  };
}

function reconstructRoute(
  nodes: MapNode[],
  startId: string,
  endId: string,
  prevNode: Map<string, string>,
  prevEdge: Map<string, MapEdge>
) {
  if (startId === endId) {
    return {
      reachable: true,
      pathNodeIds: [startId],
      pathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
    };
  }

  if (!prevNode.has(endId)) {
    return {
      reachable: false,
      pathNodeIds: [],
      pathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
    };
  }

  const pathNodeIds: string[] = [];
  const pathEdges: MapEdge[] = [];
  let curr: string | undefined = endId;

  while (curr !== undefined) {
    pathNodeIds.push(curr);
    const edge = prevEdge.get(curr);
    if (edge) pathEdges.push(edge);
    if (curr === startId) break;
    curr = prevNode.get(curr);
  }

  pathNodeIds.reverse();
  pathEdges.reverse();

  return buildLegsFromNodeSequence(nodes, pathNodeIds, pathEdges);
}

/**
 * 1. Dijkstra's Algorithm — Radial 360° Uniform Cost Search Wave
 * Time Complexity: O((V + E) log V)
 */
export function runDijkstra(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  const startTime = performance.now();
  const adj = buildAdjacencyList(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const dist = new Map<string, number>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, MapEdge>();
  const visited = new Set<string>();
  const visitedOrder: string[] = [];
  const exploredEdges: ExploredEdgeStep[] = [];
  const waveSteps: SearchWaveStep[] = [];

  for (const n of nodes) {
    dist.set(n.id, Infinity);
  }
  dist.set(startId, 0);

  const pq: Array<{ id: string; d: number }> = [{ id: startId, d: 0 }];
  let relaxationOps = 0;
  const recordDetailedWaves = nodes.length <= 120;

  while (pq.length > 0) {
    pq.sort((a, b) => a.d - b.d);
    const current = pq.shift()!;
    if (visited.has(current.id)) continue;

    visited.add(current.id);
    visitedOrder.push(current.id);

    const incomingEdge = prevEdge.get(current.id);
    const incomingFrom = prevNode.get(current.id);
    if (incomingEdge && incomingFrom) {
      exploredEdges.push({
        edgeId: incomingEdge.id,
        fromId: incomingFrom,
        toId: current.id,
        waveOrigin: 'forward',
      });
    }

    if (recordDetailedWaves || visitedOrder.length % 15 === 1 || current.id === endId) {
      const currNode = nodeMap.get(current.id);
      waveSteps.push({
        stepIndex: waveSteps.length + 1,
        currentNodeId: current.id,
        currentNodeName: currNode?.name ?? current.id,
        visitedNodeIds: recordDetailedWaves ? [...visitedOrder] : [],
        frontierNodeIds: recordDetailedWaves ? pq.map((item) => item.id) : [],
        gScore: Number(current.d.toFixed(2)),
        fScore: Number(current.d.toFixed(2)),
        description: `Dijkstra settles '${currNode?.name ?? current.id}' at g = ${current.d.toFixed(2)} km.`,
      });
    }

    if (current.id === endId) break;

    const neighbors = adj.get(current.id) ?? [];
    for (const { neighborId, edge, weight } of neighbors) {
      if (visited.has(neighborId)) continue;
      relaxationOps++;
      const alt = current.d + weight;
      if (alt < (dist.get(neighborId) ?? Infinity)) {
        dist.set(neighborId, alt);
        prevNode.set(neighborId, current.id);
        prevEdge.set(neighborId, edge);
        pq.push({ id: neighborId, d: alt });
      }
    }
  }

  const route = reconstructRoute(nodes, startId, endId, prevNode, prevEdge);
  const executionTimeMs = Math.max(0.01, performance.now() - startTime);

  return {
    algorithm: 'dijkstra',
    ...route,
    visitedOrder,
    exploredEdges,
    waveSteps,
    nodesExplored: visitedOrder.length,
    relaxationOps,
    executionTimeMs,
  };
}

/**
 * 2. A* Search Algorithm — Heuristic-Guided Directional Beam: f(n) = g(n) + h(n)
 * Guaranteed optimal path when h(n) <= physical road distance.
 */
export function runAStar(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  const startTime = performance.now();
  const adj = buildAdjacencyList(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const targetNode = nodeMap.get(endId);

  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, MapEdge>();
  const closedSet = new Set<string>();
  const visitedOrder: string[] = [];
  const exploredEdges: ExploredEdgeStep[] = [];
  const waveSteps: SearchWaveStep[] = [];

  for (const n of nodes) {
    gScore.set(n.id, Infinity);
    fScore.set(n.id, Infinity);
  }

  const startNode = nodeMap.get(startId);
  const hStart =
    startNode && targetNode ? computeEuclideanKm(startNode, targetNode) : 0;

  gScore.set(startId, 0);
  fScore.set(startId, hStart);

  const openQueue: Array<{ id: string; f: number; g: number }> = [
    { id: startId, f: hStart, g: 0 },
  ];
  let relaxationOps = 0;
  const recordDetailedWaves = nodes.length <= 120;

  while (openQueue.length > 0) {
    openQueue.sort((a, b) => a.f - b.f);
    const current = openQueue.shift()!;
    if (closedSet.has(current.id)) continue;

    closedSet.add(current.id);
    visitedOrder.push(current.id);

    const incomingEdge = prevEdge.get(current.id);
    const incomingFrom = prevNode.get(current.id);
    if (incomingEdge && incomingFrom) {
      exploredEdges.push({
        edgeId: incomingEdge.id,
        fromId: incomingFrom,
        toId: current.id,
        waveOrigin: 'forward',
      });
    }

    if (recordDetailedWaves || visitedOrder.length % 15 === 1 || current.id === endId) {
      const currNode = nodeMap.get(current.id);
      waveSteps.push({
        stepIndex: waveSteps.length + 1,
        currentNodeId: current.id,
        currentNodeName: currNode?.name ?? current.id,
        visitedNodeIds: recordDetailedWaves ? [...visitedOrder] : [],
        frontierNodeIds: recordDetailedWaves ? openQueue.map((item) => item.id) : [],
        gScore: Number(current.g.toFixed(2)),
        fScore: Number(current.f.toFixed(2)),
        description: `A* expands '${currNode?.name ?? current.id}' with f = g(${current.g.toFixed(2)}) + h(${(current.f - current.g).toFixed(2)}) = ${current.f.toFixed(2)} km.`,
      });
    }

    if (current.id === endId) break;

    const neighbors = adj.get(current.id) ?? [];
    for (const { neighborId, edge, weight } of neighbors) {
      if (closedSet.has(neighborId)) continue;
      relaxationOps++;
      const tentativeG = current.g + weight;

      if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
        const nbNode = nodeMap.get(neighborId);
        const hVal =
          nbNode && targetNode ? computeEuclideanKm(nbNode, targetNode) : 0;
        const totalF = tentativeG + hVal;

        prevNode.set(neighborId, current.id);
        prevEdge.set(neighborId, edge);
        gScore.set(neighborId, tentativeG);
        fScore.set(neighborId, totalF);
        openQueue.push({ id: neighborId, f: totalF, g: tentativeG });
      }
    }
  }

  const route = reconstructRoute(nodes, startId, endId, prevNode, prevEdge);
  const executionTimeMs = Math.max(0.01, performance.now() - startTime);

  return {
    algorithm: 'astar',
    ...route,
    visitedOrder,
    exploredEdges,
    waveSteps,
    nodesExplored: visitedOrder.length,
    relaxationOps,
    executionTimeMs,
  };
}

/**
 * 3. Bidirectional Search (Simultaneous Forward + Backward Dijkstra Waves)
 * Launches two search waves simultaneously — one from Start (cyan) and one from Destination (amber/magenta) —
 * until the two frontiers collide in the middle with guaranteed optimal path cost!
 */
export function runBidirectionalSearch(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  const startTime = performance.now();
  const adj = buildAdjacencyList(nodes, edges);

  if (startId === endId) {
    return {
      algorithm: 'bidirectional',
      reachable: true,
      pathNodeIds: [startId],
      pathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
      visitedOrder: [startId],
      exploredEdges: [],
      waveSteps: [],
      nodesExplored: 1,
      relaxationOps: 0,
      executionTimeMs: 0.02,
      meetingNodeId: startId,
    };
  }

  const distF = new Map<string, number>();
  const distB = new Map<string, number>();
  const prevNodeF = new Map<string, string>();
  const prevEdgeF = new Map<string, MapEdge>();
  const prevNodeB = new Map<string, string>();
  const prevEdgeB = new Map<string, MapEdge>();

  const visitedF = new Set<string>();
  const visitedB = new Set<string>();
  const visitedOrder: string[] = [];
  const exploredEdges: ExploredEdgeStep[] = [];

  for (const n of nodes) {
    distF.set(n.id, Infinity);
    distB.set(n.id, Infinity);
  }
  distF.set(startId, 0);
  distB.set(endId, 0);

  const pqF: Array<{ id: string; d: number }> = [{ id: startId, d: 0 }];
  const pqB: Array<{ id: string; d: number }> = [{ id: endId, d: 0 }];

  let bestMu = Infinity;
  let meetingNodeId: string | undefined;
  let relaxationOps = 0;

  while (pqF.length > 0 && pqB.length > 0) {
    pqF.sort((a, b) => a.d - b.d);
    pqB.sort((a, b) => a.d - b.d);

    const topF = pqF[0].d;
    const topB = pqB[0].d;
    if (topF + topB >= bestMu) {
      break;
    }

    // Expand whichever frontier currently has smaller minimum distance
    if (topF <= topB) {
      const curr = pqF.shift()!;
      if (visitedF.has(curr.id)) continue;
      visitedF.add(curr.id);
      visitedOrder.push(curr.id);

      const inEdge = prevEdgeF.get(curr.id);
      const inFrom = prevNodeF.get(curr.id);
      if (inEdge && inFrom) {
        exploredEdges.push({
          edgeId: inEdge.id,
          fromId: inFrom,
          toId: curr.id,
          waveOrigin: 'forward',
        });
      }

      for (const { neighborId, edge, weight } of adj.get(curr.id) ?? []) {
        relaxationOps++;
        const alt = curr.d + weight;
        if (alt < (distF.get(neighborId) ?? Infinity)) {
          distF.set(neighborId, alt);
          prevNodeF.set(neighborId, curr.id);
          prevEdgeF.set(neighborId, edge);
          pqF.push({ id: neighborId, d: alt });
        }
        const bCost = distB.get(neighborId) ?? Infinity;
        if (curr.d + weight + bCost < bestMu) {
          bestMu = curr.d + weight + bCost;
          if (!prevNodeF.has(neighborId) || alt <= (distF.get(neighborId) ?? Infinity)) {
            prevNodeF.set(neighborId, curr.id);
            prevEdgeF.set(neighborId, edge);
            distF.set(neighborId, alt);
          }
          meetingNodeId = neighborId;
        }
      }
    } else {
      const curr = pqB.shift()!;
      if (visitedB.has(curr.id)) continue;
      visitedB.add(curr.id);
      visitedOrder.push(curr.id);

      const inEdge = prevEdgeB.get(curr.id);
      const inFrom = prevNodeB.get(curr.id);
      if (inEdge && inFrom) {
        exploredEdges.push({
          edgeId: inEdge.id,
          fromId: inFrom,
          toId: curr.id,
          waveOrigin: 'backward',
        });
      }

      for (const { neighborId, edge, weight } of adj.get(curr.id) ?? []) {
        relaxationOps++;
        const alt = curr.d + weight;
        if (alt < (distB.get(neighborId) ?? Infinity)) {
          distB.set(neighborId, alt);
          prevNodeB.set(neighborId, curr.id);
          prevEdgeB.set(neighborId, edge);
          pqB.push({ id: neighborId, d: alt });
        }
        const fCost = distF.get(neighborId) ?? Infinity;
        if (curr.d + weight + fCost < bestMu) {
          bestMu = curr.d + weight + fCost;
          if (!prevNodeB.has(neighborId) || alt <= (distB.get(neighborId) ?? Infinity)) {
            prevNodeB.set(neighborId, curr.id);
            prevEdgeB.set(neighborId, edge);
            distB.set(neighborId, alt);
          }
          meetingNodeId = neighborId;
        }
      }
    }
  }

  if (!meetingNodeId || !Number.isFinite(bestMu)) {
    return {
      algorithm: 'bidirectional',
      reachable: false,
      pathNodeIds: [],
      pathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
      visitedOrder,
      exploredEdges,
      waveSteps: [],
      nodesExplored: visitedOrder.length,
      relaxationOps,
      executionTimeMs: Math.max(0.01, performance.now() - startTime),
    };
  }

  // Reconstruct start -> meetingNodeId -> endId
  const fNodes: string[] = [];
  const fEdges: MapEdge[] = [];
  let cF: string | undefined = meetingNodeId;
  while (cF !== undefined) {
    fNodes.push(cF);
    if (cF === startId) break;
    const e = prevEdgeF.get(cF);
    if (e) fEdges.push(e);
    cF = prevNodeF.get(cF);
  }
  fNodes.reverse();
  fEdges.reverse();

  const bNodes: string[] = [];
  const bEdges: MapEdge[] = [];
  let cB: string | undefined = meetingNodeId;
  while (cB !== undefined && cB !== endId) {
    const e = prevEdgeB.get(cB);
    const nextB = prevNodeB.get(cB);
    if (!e || !nextB) break;
    bEdges.push(e);
    bNodes.push(nextB);
    cB = nextB;
  }

  const fullPathNodes = [...fNodes, ...bNodes];
  const fullPathEdges = [...fEdges, ...bEdges];
  const route = buildLegsFromNodeSequence(nodes, fullPathNodes, fullPathEdges);

  return {
    algorithm: 'bidirectional',
    ...route,
    visitedOrder,
    exploredEdges,
    waveSteps: [],
    nodesExplored: visitedOrder.length,
    relaxationOps,
    executionTimeMs: Math.max(0.01, performance.now() - startTime),
    meetingNodeId,
  };
}

/**
 * 4. Greedy Best-First Search — Pure Heuristic Sprint: f(n) = h(n)
 * Explores the fewest streets by sprinting straight toward the target, but sacrifices optimality!
 */
export function runGreedyBestFirst(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  const startTime = performance.now();
  const adj = buildAdjacencyList(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const targetNode = nodeMap.get(endId);

  const visited = new Set<string>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, MapEdge>();
  const visitedOrder: string[] = [];
  const exploredEdges: ExploredEdgeStep[] = [];

  const startNode = nodeMap.get(startId);
  const hStart =
    startNode && targetNode ? computeEuclideanKm(startNode, targetNode) : 0;

  const openQueue: Array<{ id: string; h: number }> = [{ id: startId, h: hStart }];
  let relaxationOps = 0;

  while (openQueue.length > 0) {
    openQueue.sort((a, b) => a.h - b.h);
    const current = openQueue.shift()!;
    if (visited.has(current.id)) continue;

    visited.add(current.id);
    visitedOrder.push(current.id);

    const inEdge = prevEdge.get(current.id);
    const inFrom = prevNode.get(current.id);
    if (inEdge && inFrom) {
      exploredEdges.push({
        edgeId: inEdge.id,
        fromId: inFrom,
        toId: current.id,
        waveOrigin: 'forward',
      });
    }

    if (current.id === endId) break;

    for (const { neighborId, edge } of adj.get(current.id) ?? []) {
      if (visited.has(neighborId)) continue;
      relaxationOps++;
      if (!prevNode.has(neighborId)) {
        prevNode.set(neighborId, current.id);
        prevEdge.set(neighborId, edge);
        const nbNode = nodeMap.get(neighborId);
        const hVal =
          nbNode && targetNode ? computeEuclideanKm(nbNode, targetNode) : 0;
        openQueue.push({ id: neighborId, h: hVal });
      }
    }
  }

  const route = reconstructRoute(nodes, startId, endId, prevNode, prevEdge);
  return {
    algorithm: 'greedy-bfs',
    ...route,
    visitedOrder,
    exploredEdges,
    waveSteps: [],
    nodesExplored: visitedOrder.length,
    relaxationOps,
    executionTimeMs: Math.max(0.01, performance.now() - startTime),
  };
}

/**
 * 5. Bellman-Ford Algorithm (Dynamic Programming Edge Relaxation over V - 1 Passes)
 * Time Complexity: O(V * E)
 */
export function runBellmanFord(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  const startTime = performance.now();
  const dist = new Map<string, number>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, MapEdge>();
  const visitedSet = new Set<string>([startId]);
  const visitedOrder: string[] = [startId];
  const exploredEdges: ExploredEdgeStep[] = [];
  const exploredEdgeIds = new Set<string>();
  const waveSteps: SearchWaveStep[] = [];

  for (const n of nodes) {
    dist.set(n.id, Infinity);
  }
  dist.set(startId, 0);

  let relaxationOps = 0;
  const V = nodes.length;

  for (let pass = 1; pass < V; pass++) {
    let anyUpdated = false;

    for (const edge of edges) {
      if (edge.blocked) continue;
      const w = getEffectiveEdgeWeight(edge);
      if (!Number.isFinite(w)) continue;

      const pairs: Array<[string, string]> = [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ];

      for (const [u, v] of pairs) {
        relaxationOps++;
        const du = dist.get(u) ?? Infinity;
        const dv = dist.get(v) ?? Infinity;
        if (du + w < dv) {
          dist.set(v, du + w);
          prevNode.set(v, u);
          prevEdge.set(v, edge);
          anyUpdated = true;
          if (!visitedSet.has(v)) {
            visitedSet.add(v);
            visitedOrder.push(v);
          }
          if (!exploredEdgeIds.has(edge.id)) {
            exploredEdgeIds.add(edge.id);
            exploredEdges.push({
              edgeId: edge.id,
              fromId: u,
              toId: v,
              waveOrigin: 'forward',
            });
          }
        }
      }
    }

    waveSteps.push({
      stepIndex: pass,
      currentNodeId: visitedOrder[visitedOrder.length - 1] ?? startId,
      currentNodeName: `DP Pass #${pass}`,
      visitedNodeIds: [],
      frontierNodeIds: [],
      gScore: Number((dist.get(endId) ?? 0).toFixed(2)),
      fScore: Number((dist.get(endId) ?? 0).toFixed(2)),
      description: `Bellman-Ford Pass ${pass}/${V - 1}: Relaxed all active edges (${relaxationOps} checks so far).`,
    });

    if (!anyUpdated) break;
  }

  const route = reconstructRoute(nodes, startId, endId, prevNode, prevEdge);
  const executionTimeMs = Math.max(0.01, performance.now() - startTime);

  return {
    algorithm: 'bellman-ford',
    ...route,
    visitedOrder,
    exploredEdges,
    waveSteps,
    nodesExplored: visitedOrder.length,
    relaxationOps,
    executionTimeMs,
  };
}

export function runShortestPathByAlgo(
  algo: ShortestPathAlgo,
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): ShortestPathResult {
  switch (algo) {
    case 'dijkstra':
      return runDijkstra(nodes, edges, startId, endId);
    case 'astar':
      return runAStar(nodes, edges, startId, endId);
    case 'bidirectional':
      return runBidirectionalSearch(nodes, edges, startId, endId);
    case 'greedy-bfs':
      return runGreedyBestFirst(nodes, edges, startId, endId);
    case 'bellman-ford':
      return runBellmanFord(nodes, edges, startId, endId);
  }
}

export function compareShortestPathAlgorithms(
  nodes: MapNode[],
  edges: MapEdge[],
  startId: string,
  endId: string
): {
  dijkstra: ShortestPathResult;
  astar: ShortestPathResult;
  bidirectional: ShortestPathResult;
  greedyBfs: ShortestPathResult;
  bellmanFord: ShortestPathResult;
} {
  return {
    dijkstra: runDijkstra(nodes, edges, startId, endId),
    astar: runAStar(nodes, edges, startId, endId),
    bidirectional: runBidirectionalSearch(nodes, edges, startId, endId),
    greedyBfs: runGreedyBestFirst(nodes, edges, startId, endId),
    bellmanFord: runBellmanFord(nodes, edges, startId, endId),
  };
}
