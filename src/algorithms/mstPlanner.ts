import {
  type MapNode,
  type MapEdge,
  getEffectiveEdgeWeight,
} from './graphTypes.ts';

export type MSTAlgo = 'kruskal' | 'prim';

export interface MSTStep {
  stepNumber: number;
  edgeId: string;
  roadName: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  weightKm: number;
  action: 'accepted' | 'rejected-cycle';
  reason: string;
}

export interface MSTResult {
  algorithm: MSTAlgo;
  isConnected: boolean;
  selectedEdgeIds: string[];
  selectedEdges: MapEdge[];
  totalCableKm: number;
  totalNetworkRoadKm: number;
  cableSavedKm: number;
  cableSavedPercent: number;
  steps: MSTStep[];
  comparisons: number;
  executionTimeMs: number;
}

/**
 * Disjoint Set (Union-Find) with Path Compression & Union by Rank for Kruskal's MST.
 */
class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  constructor(nodeIds: string[]) {
    for (const id of nodeIds) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  public find(id: string): string {
    const p = this.parent.get(id)!;
    if (p !== id) {
      const root = this.find(p);
      this.parent.set(id, root);
      return root;
    }
    return id;
  }

  public union(a: string, b: string): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false; // Already in same component (would form a cycle!)

    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;

    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
    return true;
  }
}

/**
 * 1. Kruskal's Algorithm for Minimum Spanning Tree
 * Time Complexity: O(E log E) using Disjoint Set Union-Find
 */
export function runKruskalMST(
  nodes: MapNode[],
  edges: MapEdge[]
): MSTResult {
  const startTime = performance.now();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const activeEdges = edges.filter((e) => !e.blocked);

  const totalNetworkRoadKm = Number(
    activeEdges.reduce((acc, e) => acc + getEffectiveEdgeWeight(e), 0).toFixed(2)
  );

  let comparisons = 0;
  const sortedEdges = [...activeEdges].sort((a, b) => {
    comparisons++;
    const wa = getEffectiveEdgeWeight(a);
    const wb = getEffectiveEdgeWeight(b);
    if (wa !== wb) return wa - wb;
    return a.id.localeCompare(b.id);
  });

  const dsu = new DisjointSet(nodes.map((n) => n.id));
  const selectedEdges: MapEdge[] = [];
  const selectedEdgeIds: string[] = [];
  const steps: MSTStep[] = [];
  let totalCableKm = 0;

  for (const edge of sortedEdges) {
    comparisons++;
    const w = getEffectiveEdgeWeight(edge);
    const uName = nodeMap.get(edge.from)?.name ?? edge.from;
    const vName = nodeMap.get(edge.to)?.name ?? edge.to;

    if (dsu.union(edge.from, edge.to)) {
      selectedEdges.push(edge);
      selectedEdgeIds.push(edge.id);
      totalCableKm += w;
      steps.push({
        stepNumber: steps.length + 1,
        edgeId: edge.id,
        roadName: edge.roadName,
        fromId: edge.from,
        fromName: uName,
        toId: edge.to,
        toName: vName,
        weightKm: w,
        action: 'accepted',
        reason: `Union(${uName}, ${vName}) merges two disjoint components without creating a cycle.`,
      });

      if (selectedEdges.length === nodes.length - 1) {
        break;
      }
    } else {
      steps.push({
        stepNumber: steps.length + 1,
        edgeId: edge.id,
        roadName: edge.roadName,
        fromId: edge.from,
        fromName: uName,
        toId: edge.to,
        toName: vName,
        weightKm: w,
        action: 'rejected-cycle',
        reason: `Skipped: '${uName}' and '${vName}' are already connected in the same component (would form a cycle).`,
      });
    }
  }

  totalCableKm = Number(totalCableKm.toFixed(2));
  const cableSavedKm = Math.max(
    0,
    Number((totalNetworkRoadKm - totalCableKm).toFixed(2))
  );
  const cableSavedPercent =
    totalNetworkRoadKm > 0
      ? Number(((cableSavedKm / totalNetworkRoadKm) * 100).toFixed(1))
      : 0;

  return {
    algorithm: 'kruskal',
    isConnected: selectedEdges.length === Math.max(0, nodes.length - 1),
    selectedEdgeIds,
    selectedEdges,
    totalCableKm,
    totalNetworkRoadKm,
    cableSavedKm,
    cableSavedPercent,
    steps,
    comparisons,
    executionTimeMs: Math.max(0.01, performance.now() - startTime),
  };
}

/**
 * 2. Prim's Algorithm for Minimum Spanning Tree
 * Grows a single tree from the starting node by picking the lightest cut edge in O(E log V).
 */
export function runPrimMST(
  nodes: MapNode[],
  edges: MapEdge[],
  startNodeId?: string
): MSTResult {
  const startTime = performance.now();
  if (nodes.length === 0) {
    return {
      algorithm: 'prim',
      isConnected: true,
      selectedEdgeIds: [],
      selectedEdges: [],
      totalCableKm: 0,
      totalNetworkRoadKm: 0,
      cableSavedKm: 0,
      cableSavedPercent: 0,
      steps: [],
      comparisons: 0,
      executionTimeMs: Math.max(0.01, performance.now() - startTime),
    };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const activeEdges = edges.filter((e) => !e.blocked);
  const totalNetworkRoadKm = Number(
    activeEdges.reduce((acc, e) => acc + getEffectiveEdgeWeight(e), 0).toFixed(2)
  );

  const rootId = startNodeId && nodeMap.has(startNodeId) ? startNodeId : nodes[0].id;
  const inTree = new Set<string>([rootId]);

  const adj = new Map<string, Array<{ neighborId: string; edge: MapEdge; weight: number }>>();
  for (const n of nodes) {
    adj.set(n.id, []);
  }
  for (const edge of activeEdges) {
    const w = getEffectiveEdgeWeight(edge);
    if (!Number.isFinite(w)) continue;
    adj.get(edge.from)?.push({ neighborId: edge.to, edge, weight: w });
    adj.get(edge.to)?.push({ neighborId: edge.from, edge, weight: w });
  }

  const frontier: Array<{ fromId: string; toId: string; edge: MapEdge; weight: number }> = [];
  for (const item of adj.get(rootId) ?? []) {
    frontier.push({
      fromId: rootId,
      toId: item.neighborId,
      edge: item.edge,
      weight: item.weight,
    });
  }

  const selectedEdges: MapEdge[] = [];
  const selectedEdgeIds: string[] = [];
  const steps: MSTStep[] = [];
  let totalCableKm = 0;
  let comparisons = 0;

  while (inTree.size < nodes.length && frontier.length > 0) {
    frontier.sort((a, b) => {
      comparisons++;
      if (a.weight !== b.weight) return a.weight - b.weight;
      return a.edge.id.localeCompare(b.edge.id);
    });

    const cand = frontier.shift()!;
    if (inTree.has(cand.toId)) continue;

    const bestEdge = cand.edge;
    const bestWeight = cand.weight;
    const fromId = cand.fromId;
    const toId = cand.toId;

    inTree.add(toId);
    selectedEdges.push(bestEdge);
    selectedEdgeIds.push(bestEdge.id);
    totalCableKm += bestWeight;

    for (const next of adj.get(toId) ?? []) {
      if (!inTree.has(next.neighborId)) {
        frontier.push({
          fromId: toId,
          toId: next.neighborId,
          edge: next.edge,
          weight: next.weight,
        });
      }
    }

    const uName = nodeMap.get(fromId)?.name ?? fromId;
    const vName = nodeMap.get(toId)?.name ?? toId;

    steps.push({
      stepNumber: steps.length + 1,
      edgeId: bestEdge.id,
      roadName: bestEdge.roadName,
      fromId,
      fromName: uName,
      toId,
      toName: vName,
      weightKm: bestWeight,
      action: 'accepted',
      reason: `Prim's Cut Property: '${bestEdge.roadName}' (${bestWeight} km) is the minimum-weight edge connecting tree node '${uName}' to outside node '${vName}'.`,
    });
  }

  totalCableKm = Number(totalCableKm.toFixed(2));
  const cableSavedKm = Math.max(
    0,
    Number((totalNetworkRoadKm - totalCableKm).toFixed(2))
  );
  const cableSavedPercent =
    totalNetworkRoadKm > 0
      ? Number(((cableSavedKm / totalNetworkRoadKm) * 100).toFixed(1))
      : 0;

  return {
    algorithm: 'prim',
    isConnected: selectedEdges.length === Math.max(0, nodes.length - 1),
    selectedEdgeIds,
    selectedEdges,
    totalCableKm,
    totalNetworkRoadKm,
    cableSavedKm,
    cableSavedPercent,
    steps,
    comparisons,
    executionTimeMs: Math.max(0.01, performance.now() - startTime),
  };
}

