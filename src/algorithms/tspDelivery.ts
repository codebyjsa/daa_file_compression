import {
  type MapNode,
  type MapEdge,
  weightToMinutes,
} from './graphTypes.ts';
import {
  runDijkstra,
  type ShortestPathResult,
  type RouteLeg,
} from './shortestPath.ts';

export type TSPAlgo = 'held-karp-dp' | 'greedy-nn';

export interface DeliveryTourResult {
  algorithm: TSPAlgo;
  reachable: boolean;
  orderedStopIds: string[]; // [depot, stop1, stop2, ..., depot (if roundTrip)]
  fullPathNodeIds: string[];
  fullPathEdgeIds: string[];
  legs: RouteLeg[];
  totalPhysicalKm: number;
  totalEffectiveKm: number;
  estimatedMinutes: number;
  statesEvaluated: number;
  executionTimeMs: number;
}

export interface TSPComparisonOutput {
  heldKarpDP: DeliveryTourResult;
  greedyNN: DeliveryTourResult;
  distanceSavedKm: number;
  minutesSaved: number;
}

/**
 * Precomputes all-pairs shortest paths among [depot, ...stops] using Dijkstra.
 */
function buildPairwiseMatrix(
  nodes: MapNode[],
  edges: MapEdge[],
  keyNodeIds: string[]
): Map<string, Map<string, ShortestPathResult>> {
  const matrix = new Map<string, Map<string, ShortestPathResult>>();
  for (const u of keyNodeIds) {
    const row = new Map<string, ShortestPathResult>();
    for (const v of keyNodeIds) {
      if (u !== v) {
        row.set(v, runDijkstra(nodes, edges, u, v));
      }
    }
    matrix.set(u, row);
  }
  return matrix;
}

function stitchTourFromOrder(
  algorithm: TSPAlgo,
  orderedStopIds: string[],
  pairwise: Map<string, Map<string, ShortestPathResult>>,
  statesEvaluated: number,
  executionTimeMs: number
): DeliveryTourResult {
  const fullPathNodeIds: string[] = [];
  const fullPathEdgeIds: string[] = [];
  const legs: RouteLeg[] = [];
  let totalPhysicalKm = 0;
  let totalEffectiveKm = 0;
  let stepCounter = 1;

  for (let i = 0; i < orderedStopIds.length - 1; i++) {
    const u = orderedStopIds[i];
    const v = orderedStopIds[i + 1];
    const sp = pairwise.get(u)?.get(v);

    if (!sp || !sp.reachable) {
      return {
        algorithm,
        reachable: false,
        orderedStopIds: [],
        fullPathNodeIds: [],
        fullPathEdgeIds: [],
        legs: [],
        totalPhysicalKm: 0,
        totalEffectiveKm: 0,
        estimatedMinutes: 0,
        statesEvaluated,
        executionTimeMs,
      };
    }

    if (i === 0) {
      fullPathNodeIds.push(...sp.pathNodeIds);
    } else {
      fullPathNodeIds.push(...sp.pathNodeIds.slice(1));
    }

    fullPathEdgeIds.push(...sp.pathEdgeIds);
    totalPhysicalKm += sp.totalPhysicalKm;
    totalEffectiveKm += sp.totalEffectiveKm;

    for (const leg of sp.legs) {
      legs.push({
        ...leg,
        stepNumber: stepCounter++,
      });
    }
  }

  return {
    algorithm,
    reachable: true,
    orderedStopIds,
    fullPathNodeIds,
    fullPathEdgeIds,
    legs,
    totalPhysicalKm: Number(totalPhysicalKm.toFixed(2)),
    totalEffectiveKm: Number(totalEffectiveKm.toFixed(2)),
    estimatedMinutes: weightToMinutes(totalEffectiveKm),
    statesEvaluated,
    executionTimeMs,
  };
}

/**
 * 1. Exact Held-Karp Bitmask Dynamic Programming TSP Solver
 * Time Complexity: O(2^k * k^2) where k = number of delivery stops
 */
export function solveTSPHeldKarp(
  nodes: MapNode[],
  edges: MapEdge[],
  depotId: string,
  stopIds: string[],
  returnToDepot = true
): DeliveryTourResult {
  const startTime = performance.now();
  const uniqueStops = Array.from(new Set(stopIds.filter((id) => id !== depotId)));

  if (uniqueStops.length === 0) {
    return {
      algorithm: 'held-karp-dp',
      reachable: true,
      orderedStopIds: [depotId],
      fullPathNodeIds: [depotId],
      fullPathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
      statesEvaluated: 1,
      executionTimeMs: Math.max(0.01, performance.now() - startTime),
    };
  }

  const keyNodes = [depotId, ...uniqueStops];
  const pairwise = buildPairwiseMatrix(nodes, edges, keyNodes);

  const k = uniqueStops.length;
  const totalMasks = 1 << k;

  // dp[mask][i] = minimum effective km to start at depot (0), visit subset `mask` of stops, and end at stop `i` (0..k-1)
  const dp: number[][] = Array.from({ length: totalMasks }, () =>
    new Array<number>(k).fill(Infinity)
  );
  const parent: number[][] = Array.from({ length: totalMasks }, () =>
    new Array<number>(k).fill(-1)
  );

  let statesEvaluated = 0;

  // Base cases: depot -> stop i
  for (let i = 0; i < k; i++) {
    const sp = pairwise.get(depotId)?.get(uniqueStops[i]);
    if (sp && sp.reachable) {
      dp[1 << i][i] = sp.totalEffectiveKm;
    }
    statesEvaluated++;
  }

  // Transitions over bitmasks
  for (let mask = 1; mask < totalMasks; mask++) {
    for (let u = 0; u < k; u++) {
      if ((mask & (1 << u)) === 0) continue;
      const currentCost = dp[mask][u];
      if (!Number.isFinite(currentCost)) continue;

      for (let v = 0; v < k; v++) {
        if ((mask & (1 << v)) !== 0) continue;
        statesEvaluated++;
        const nextMask = mask | (1 << v);
        const sp = pairwise.get(uniqueStops[u])?.get(uniqueStops[v]);
        const stepCost = sp && sp.reachable ? sp.totalEffectiveKm : Infinity;

        if (currentCost + stepCost < dp[nextMask][v]) {
          dp[nextMask][v] = currentCost + stepCost;
          parent[nextMask][v] = u;
        }
      }
    }
  }

  const fullMask = totalMasks - 1;
  let bestCost = Infinity;
  let lastStopIdx = -1;

  for (let u = 0; u < k; u++) {
    let cost = dp[fullMask][u];
    if (returnToDepot) {
      const backSp = pairwise.get(uniqueStops[u])?.get(depotId);
      const backCost = backSp && backSp.reachable ? backSp.totalEffectiveKm : Infinity;
      cost += backCost;
    }
    if (cost < bestCost) {
      bestCost = cost;
      lastStopIdx = u;
    }
  }

  if (!Number.isFinite(bestCost) || lastStopIdx === -1) {
    return {
      algorithm: 'held-karp-dp',
      reachable: false,
      orderedStopIds: [],
      fullPathNodeIds: [],
      fullPathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
      statesEvaluated,
      executionTimeMs: Math.max(0.01, performance.now() - startTime),
    };
  }

  // Backtrack optimal stop order
  const stopOrderIndices: number[] = [];
  let currMask = fullMask;
  let currIdx = lastStopIdx;

  while (currIdx !== -1) {
    stopOrderIndices.push(currIdx);
    const prevIdx = parent[currMask][currIdx];
    currMask ^= 1 << currIdx;
    currIdx = prevIdx;
  }
  stopOrderIndices.reverse();

  const orderedStopIds = [
    depotId,
    ...stopOrderIndices.map((idx) => uniqueStops[idx]),
    ...(returnToDepot ? [depotId] : []),
  ];

  const executionTimeMs = Math.max(0.01, performance.now() - startTime);
  return stitchTourFromOrder(
    'held-karp-dp',
    orderedStopIds,
    pairwise,
    statesEvaluated,
    executionTimeMs
  );
}

/**
 * 2. Greedy Nearest-Neighbor TSP Heuristic
 * At each step, greedily selects the nearest unvisited delivery stop in O(k^2) time.
 */
export function solveTSPGreedy(
  nodes: MapNode[],
  edges: MapEdge[],
  depotId: string,
  stopIds: string[],
  returnToDepot = true
): DeliveryTourResult {
  const startTime = performance.now();
  const uniqueStops = Array.from(new Set(stopIds.filter((id) => id !== depotId)));

  if (uniqueStops.length === 0) {
    return {
      algorithm: 'greedy-nn',
      reachable: true,
      orderedStopIds: [depotId],
      fullPathNodeIds: [depotId],
      fullPathEdgeIds: [],
      legs: [],
      totalPhysicalKm: 0,
      totalEffectiveKm: 0,
      estimatedMinutes: 0,
      statesEvaluated: 1,
      executionTimeMs: Math.max(0.01, performance.now() - startTime),
    };
  }

  const keyNodes = [depotId, ...uniqueStops];
  const pairwise = buildPairwiseMatrix(nodes, edges, keyNodes);

  const unvisited = new Set(uniqueStops);
  const orderedStopIds: string[] = [depotId];
  let currentId = depotId;
  let statesEvaluated = 0;

  while (unvisited.size > 0) {
    let nearestId: string | null = null;
    let nearestCost = Infinity;

    for (const candId of unvisited) {
      statesEvaluated++;
      const sp = pairwise.get(currentId)?.get(candId);
      const cost = sp && sp.reachable ? sp.totalEffectiveKm : Infinity;
      if (cost < nearestCost) {
        nearestCost = cost;
        nearestId = candId;
      }
    }

    if (!nearestId || !Number.isFinite(nearestCost)) {
      return {
        algorithm: 'greedy-nn',
        reachable: false,
        orderedStopIds: [],
        fullPathNodeIds: [],
        fullPathEdgeIds: [],
        legs: [],
        totalPhysicalKm: 0,
        totalEffectiveKm: 0,
        estimatedMinutes: 0,
        statesEvaluated,
        executionTimeMs: Math.max(0.01, performance.now() - startTime),
      };
    }

    orderedStopIds.push(nearestId);
    unvisited.delete(nearestId);
    currentId = nearestId;
  }

  if (returnToDepot) {
    orderedStopIds.push(depotId);
  }

  const executionTimeMs = Math.max(0.01, performance.now() - startTime);
  return stitchTourFromOrder(
    'greedy-nn',
    orderedStopIds,
    pairwise,
    statesEvaluated,
    executionTimeMs
  );
}

export function compareMultiStopTSP(
  nodes: MapNode[],
  edges: MapEdge[],
  depotId: string,
  stopIds: string[],
  returnToDepot = true
): TSPComparisonOutput {
  const heldKarpDP = solveTSPHeldKarp(nodes, edges, depotId, stopIds, returnToDepot);
  const greedyNN = solveTSPGreedy(nodes, edges, depotId, stopIds, returnToDepot);

  const distanceSavedKm =
    heldKarpDP.reachable && greedyNN.reachable
      ? Math.max(0, Number((greedyNN.totalEffectiveKm - heldKarpDP.totalEffectiveKm).toFixed(2)))
      : 0;
  const minutesSaved =
    heldKarpDP.reachable && greedyNN.reachable
      ? Math.max(0, Number((greedyNN.estimatedMinutes - heldKarpDP.estimatedMinutes).toFixed(1)))
      : 0;

  return {
    heldKarpDP,
    greedyNN,
    distanceSavedKm,
    minutesSaved,
  };
}

