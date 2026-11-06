import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_PRESETS,
  NEW_DELHI_PRESET,
  NYC_MANHATTAN_PRESET,
  PARIS_ETOILE_PRESET,
  BENGALURU_GRID_PRESET,
} from '../presets.ts';
import { computeEuclideanKm } from '../graphTypes.ts';
import {
  runDijkstra,
  runAStar,
  runBidirectionalSearch,
  runGreedyBestFirst,
  runBellmanFord,
  compareShortestPathAlgorithms,
} from '../shortestPath.ts';
import {
  solveTSPHeldKarp,
  solveTSPGreedy,
  compareMultiStopTSP,
} from '../tspDelivery.ts';
import { runKruskalMST, runPrimMST } from '../mstPlanner.ts';
import {
  addCustomNodeToNetwork,
  buildSpanningNetworkForLocations,
} from '../osmLoader.ts';

describe('RoutePulse — Real-Map Street-Wave & DAA Graph Algorithms Suite', () => {
  it('generates 4 high-density real city street networks (750+ intersections & 1,400+ streets each) with admissible edge weights', () => {
    assert.equal(MAP_PRESETS.length, 4);

    for (const preset of MAP_PRESETS) {
      assert.ok(
        preset.nodes.length >= 750,
        `${preset.id} should have >= 750 intersections, got ${preset.nodes.length}`
      );
      assert.ok(
        preset.edges.length >= 1400,
        `${preset.id} should have >= 1400 street segments, got ${preset.edges.length}`
      );

      const nodeMap = new Map(preset.nodes.map((n) => [n.id, n]));
      for (const edge of preset.edges) {
        const u = nodeMap.get(edge.from);
        const v = nodeMap.get(edge.to);
        assert.ok(u && v, `Edge ${edge.id} references valid nodes`);
        const euclid = computeEuclideanKm(u!, v!);
        assert.ok(
          edge.baseDistanceKm >= euclid,
          `Edge ${edge.id} baseDistanceKm (${edge.baseDistanceKm}) must be >= Euclidean (${euclid})`
        );
      }
    }
  });

  it('finds identical optimal route cost across Dijkstra, A*, Bidirectional Search, and Bellman-Ford on New Delhi & NYC', () => {
    for (const preset of [NEW_DELHI_PRESET, NYC_MANHATTAN_PRESET]) {
      const { nodes, edges, defaultStartId, defaultEndId } = preset;
      const cmp = compareShortestPathAlgorithms(
        nodes,
        edges,
        defaultStartId,
        defaultEndId
      );

      assert.equal(cmp.dijkstra.reachable, true);
      assert.equal(cmp.astar.reachable, true);
      assert.equal(cmp.bidirectional.reachable, true);
      assert.equal(cmp.greedyBfs.reachable, true);
      assert.equal(cmp.bellmanFord.reachable, true);

      // Exact optimal cost agreement
      assert.equal(cmp.dijkstra.totalEffectiveKm, cmp.astar.totalEffectiveKm);
      assert.equal(
        cmp.dijkstra.totalEffectiveKm,
        cmp.bidirectional.totalEffectiveKm
      );
      assert.equal(
        cmp.dijkstra.totalEffectiveKm,
        cmp.bellmanFord.totalEffectiveKm
      );

      // A* heuristic pruning explores fewer streets than Dijkstra's 360° wave
      assert.ok(
        cmp.astar.exploredEdges.length < cmp.dijkstra.exploredEdges.length,
        `Expected A* (${cmp.astar.exploredEdges.length} streets) < Dijkstra (${cmp.dijkstra.exploredEdges.length} streets)`
      );

      // Bidirectional search records both forward and backward wave edges
      const hasForward = cmp.bidirectional.exploredEdges.some(
        (e) => e.waveOrigin === 'forward'
      );
      const hasBackward = cmp.bidirectional.exploredEdges.some(
        (e) => e.waveOrigin === 'backward'
      );
      assert.equal(hasForward, true);
      assert.equal(hasBackward, true);
      assert.ok(cmp.bidirectional.meetingNodeId);
    }
  });

  it('dynamically reroutes around blocked streets and heavy traffic congestion', () => {
    const { nodes, edges, defaultStartId, defaultEndId } = PARIS_ETOILE_PRESET;
    const baseRoute = runAStar(nodes, edges, defaultStartId, defaultEndId);
    assert.equal(baseRoute.reachable, true);
    assert.ok(baseRoute.pathEdgeIds.length > 2);

    // Block an edge in the middle of the optimal route
    const blockedEdgeId =
      baseRoute.pathEdgeIds[Math.floor(baseRoute.pathEdgeIds.length / 2)];
    const modifiedEdges = edges.map((e) =>
      e.id === blockedEdgeId ? { ...e, blocked: true } : e
    );

    const detourRoute = runAStar(
      nodes,
      modifiedEdges,
      defaultStartId,
      defaultEndId
    );
    const detourDijkstra = runDijkstra(
      nodes,
      modifiedEdges,
      defaultStartId,
      defaultEndId
    );
    const detourBidir = runBidirectionalSearch(
      nodes,
      modifiedEdges,
      defaultStartId,
      defaultEndId
    );

    assert.equal(detourRoute.reachable, true);
    assert.ok(!detourRoute.pathEdgeIds.includes(blockedEdgeId));
    assert.equal(detourRoute.totalEffectiveKm, detourDijkstra.totalEffectiveKm);
    assert.equal(detourRoute.totalEffectiveKm, detourBidir.totalEffectiveKm);
    assert.ok(detourRoute.totalEffectiveKm >= baseRoute.totalEffectiveKm);

    // Also verify Greedy Best-First and Bellman-Ford still find valid paths
    const greedyRes = runGreedyBestFirst(
      nodes,
      modifiedEdges,
      defaultStartId,
      defaultEndId
    );
    const bfRes = runBellmanFord(
      nodes,
      modifiedEdges,
      defaultStartId,
      defaultEndId
    );
    assert.equal(greedyRes.reachable, true);
    assert.equal(bfRes.totalEffectiveKm, detourRoute.totalEffectiveKm);
  });

  it('solves Multi-Stop Delivery TSP with Held-Karp Bitmask DP beating or matching Greedy Nearest-Neighbor', () => {
    const { nodes, edges, defaultStartId, defaultDeliveryStopIds } =
      BENGALURU_GRID_PRESET;
    const stops = defaultDeliveryStopIds.slice(0, 6);

    const comparison = compareMultiStopTSP(
      nodes,
      edges,
      defaultStartId,
      stops,
      true
    );

    assert.equal(comparison.heldKarpDP.reachable, true);
    assert.equal(comparison.greedyNN.reachable, true);
    assert.ok(
      comparison.heldKarpDP.totalEffectiveKm <=
        comparison.greedyNN.totalEffectiveKm,
      `Held-Karp DP (${comparison.heldKarpDP.totalEffectiveKm} km) must be <= Greedy NN (${comparison.greedyNN.totalEffectiveKm} km)`
    );

    // Verify open tour (returnToDepot = false)
    const openDP = solveTSPHeldKarp(nodes, edges, defaultStartId, stops, false);
    const openGreedy = solveTSPGreedy(
      nodes,
      edges,
      defaultStartId,
      stops,
      false
    );
    assert.equal(openDP.reachable, true);
    assert.ok(openDP.totalEffectiveKm <= openGreedy.totalEffectiveKm);
  });

  it('computes identical Minimum Spanning Tree cost using Kruskal (Union-Find) and Prim across 800+ city intersections', () => {
    for (const preset of [NEW_DELHI_PRESET, NYC_MANHATTAN_PRESET]) {
      const kruskal = runKruskalMST(preset.nodes, preset.edges);
      const prim = runPrimMST(
        preset.nodes,
        preset.edges,
        preset.defaultStartId
      );

      assert.equal(kruskal.isConnected, true);
      assert.equal(prim.isConnected, true);
      assert.equal(kruskal.selectedEdges.length, preset.nodes.length - 1);
      assert.equal(prim.selectedEdges.length, preset.nodes.length - 1);
      assert.equal(kruskal.totalCableKm, prim.totalCableKm);
      assert.ok(kruskal.cableSavedPercent > 35);
    }
  });

  it('allows adding custom locations at arbitrary OpenStreetMap (lat, lng) coordinates and routes to/from them optimally', () => {
    const { bbox, nodes, edges, defaultStartId } = NEW_DELHI_PRESET;
    const { newNode, updatedNodes, updatedEdges } = addCustomNodeToNetwork(
      bbox,
      nodes,
      edges,
      {
        name: 'Custom User Pin (Connaught Outer Block)',
        lat: 28.6342,
        lng: 77.2215,
        category: 'commercial',
      }
    );

    assert.ok(newNode.id.startsWith('CUSTOM-'));
    assert.equal(updatedNodes.length, nodes.length + 1);
    assert.equal(updatedEdges.length, edges.length + 4);

    const astarToCustom = runAStar(
      updatedNodes,
      updatedEdges,
      defaultStartId,
      newNode.id
    );
    const dijkstraToCustom = runDijkstra(
      updatedNodes,
      updatedEdges,
      defaultStartId,
      newNode.id
    );

    assert.equal(astarToCustom.reachable, true);
    assert.equal(
      astarToCustom.totalEffectiveKm,
      dijkstraToCustom.totalEffectiveKm
    );
    assert.equal(
      astarToCustom.pathNodeIds[astarToCustom.pathNodeIds.length - 1],
      newNode.id
    );
  });

  it('dynamically spans the street network and search wave across any distance between distant locations (e.g. Threeke to GNDEC Ludhiana)', async () => {
    const spanPreset = await buildSpanningNetworkForLocations({
      startPoint: {
        name: 'My Location (Threeke, Ludhiana)',
        lat: 30.8712,
        lng: 75.7815,
      },
      endPoint: {
        name: 'Guru Nanak Dev Engineering College',
        lat: 30.8605,
        lng: 75.8595,
      },
    });

    assert.ok(spanPreset.nodes.length >= 890);
    assert.ok(spanPreset.edges.length >= 2000);
    assert.ok(spanPreset.bbox.minLng < 75.7815);
    assert.ok(spanPreset.bbox.maxLng > 75.8595);

    const dijkstra = runDijkstra(
      spanPreset.nodes,
      spanPreset.edges,
      spanPreset.defaultStartId,
      spanPreset.defaultEndId
    );
    const astar = runAStar(
      spanPreset.nodes,
      spanPreset.edges,
      spanPreset.defaultStartId,
      spanPreset.defaultEndId
    );

    assert.equal(dijkstra.reachable, true);
    assert.equal(astar.reachable, true);
    assert.ok(dijkstra.legs.length >= 15);
    assert.ok(dijkstra.exploredEdges.length >= 300);
    assert.equal(dijkstra.totalEffectiveKm, astar.totalEffectiveKm);
  });
});
