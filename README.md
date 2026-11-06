# RoutePulse Maps — Real-Map Street-Wave Pathfinding & Smart Delivery Navigation Planner

A full-screen **Google Maps-style** interactive pathfinding, multi-stop delivery, and city infrastructure visualizer built for **Design & Analysis of Algorithms (DAA)** with **React 19, TypeScript, Vite, Tailwind CSS v4, HTML5 Canvas, and OpenStreetMap**.

> **Zero API Keys Required:** Powered by free, open **OpenStreetMap** slippy map tiles (`tile.openstreetmap.org`), **Nominatim** geocoding & reverse-geocoding, **OSRM** real road geometry routing, and **Overpass API** street networks.

---

## Key Highlights

- **Full-Bleed `100vw × 100vh` Google Maps UI (`src/components/RealMapStreetCanvas.tsx`)**:
  - Smooth Web Mercator **pan & zoom** (`zoom 11–18`), floating Google Maps directions drawer, and 3 map layer styles (**OSM Street**, **Esri Street**, and **Dark Neon**).
- **60 FPS Glowing Street-Wave Visualization**:
  - Watch search waves expand street-by-street across **800–1,000+ real city intersections** and **1,700–2,100+ street segments** at 60 FPS with active frontier sparks and glowing route beams.
- **Side-by-Side Split-Screen Algorithm Race**:
  - Race any two pathfinding algorithms head-to-head on the exact same city street network (e.g., **Dijkstra's 360° Radial Wave** vs. **A\* Heuristic Beam** vs. **Bidirectional Dual-Wave Collision**).
- **Live OpenStreetMap Search, GPS "Use My Location", & Custom Pin Drops (`src/algorithms/osmLoader.ts`)**:
  - **Use My Current Location (Live GPS)**: Detect your real coordinates via browser Geolocation (with IP fallback) and route from/to your live location.
  - **Search Any Place on Earth**: Query any city, university campus, street, or landmark via OpenStreetMap Nominatim.
  - **Right-Click Anywhere on the Map**: Open a Google Maps context menu at any `(lat, lng)` to set **Start (Pin A)**, **Destination (Pin B)**, **Delivery Stop (TSP)**, or **Add a Custom Named Location**.
  - **Dynamic Full-Span Corridor Expansion**: Automatically scales and builds a 900+ node street network (woven with real **OSRM** road geometry) across **any distance** between Origin `A` and Destination `B`.
- **Interactive Traffic & Road Blockade Paint Brush**:
  - Paint **Heavy Traffic (`2.2x`)**, **Gridlock (`4.0x`)**, or **Road Closures** across city streets, or trigger **Rush Hour** congestion to watch algorithms dynamically reroute in real time.

---

## Core DAA Graph Algorithms Implemented

### 1. Point-to-Point Shortest Path (`src/algorithms/shortestPath.ts`)
| Algorithm | Paradigm | Time Complexity | Optimality | Visual Wave Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **A\* Search** (`runAStar`) | Heuristic-Guided Best-First (`f(n) = g(n) + h(n)`) | `O((V + E) log V)` | **Optimal** (Admissible Euclidean `h(n)`) | Focused directional beam toward Destination `B` (scans 45–75% fewer streets than Dijkstra) |
| **Dijkstra's Algorithm** (`runDijkstra`) | Greedy Uniform-Cost Priority Queue | `O((V + E) log V)` | **Optimal** | Uniform 360° radial flood expanding outward in all directions |
| **Bidirectional Search** (`runBidirectionalSearch`) | Simultaneous Forward + Backward Waves | `O(b^(d/2))` | **Optimal** | Dual search waves expanding from `A` (cyan/blue) and `B` (amber/rose) until they collide in the middle |
| **Greedy Best-First** (`runGreedyBestFirst`) | Pure Heuristic Sprint (`f(n) = h(n)`) | `O(E log V)` | **Non-Optimal Heuristic** | Sprints straight toward target scanning minimal streets, demonstrating speed vs. optimality trade-offs |
| **Bellman-Ford** (`runBellmanFord`) | Dynamic Programming Edge Relaxation | `O(V · E)` | **Optimal** | Iterative `V - 1` DP relaxation passes across all active street edges |

### 2. Multi-Stop Delivery Fleet Optimization — TSP (`src/algorithms/tspDelivery.ts`)
- **Held-Karp Bitmask Dynamic Programming (`solveTSPHeldKarp`)**:
  - Computes the **globally optimal multi-stop delivery tour** across `k` stops using state `dp[mask][u]` in `O(2^k · k²)` time.
- **Greedy Nearest-Neighbor Heuristic (`solveTSPGreedy`)**:
  - Visits the nearest unvisited delivery stop at each step in `O(k²)` time and overlays a dashed comparison route on the map to show the exact distance and time saved by Dynamic Programming.

### 3. City-Wide Fiber Backbone Planner — MST (`src/algorithms/mstPlanner.ts`)
- **Kruskal's Algorithm (`runKruskalMST`)**:
  - Sorts all active streets by weight and uses a **Disjoint-Set (Union-Find)** data structure with path compression and union-by-rank in `O(E log E)` time to connect all city intersections without cycles at minimum trenching cost.
- **Prim's Algorithm (`runPrimMST`)**:
  - Grows a single Minimum Spanning Tree from the starting hub across the lightest cut edges in `O(E log V)` time.

---

## Pre-Loaded High-Density Real City Networks (`src/algorithms/cityStreetGraphs.ts`)

1. **New Delhi, India — Connaught Place & Lutyens Radial Grid** (`800+` intersections, concentric inner/middle/outer circles + 8 radial avenues + hexagonal grid)
2. **New York, USA — Midtown Manhattan & Broadway Diagonal** (`840` intersections, orthogonal avenues & cross-streets sliced diagonally by Broadway)
3. **Paris, France — Arc de Triomphe 12-Avenue Star** (`850+` intersections, Place Charles de Gaulle 12 radial Haussmann avenues)
4. **Bengaluru, India — MG Road & Indiranagar Delivery Grid** (`840` intersections, 100ft Rd, 80ft Rd, CMH Rd, and neighborhood crosses)
5. **Any City / Campus on Earth** via live OpenStreetMap search or GPS location!

---

## Project Structure

```text
src/
├── algorithms/
│   ├── graphTypes.ts         # Core MapNode, MapEdge, GeoBoundingBox & cost helpers
│   ├── cityStreetGraphs.ts   # High-density city street generators (New Delhi, NYC, Paris, Bengaluru)
│   ├── osmLoader.ts          # Live OpenStreetMap Nominatim, Overpass, OSRM & full-span network builder
│   ├── presets.ts            # City preset exports
│   ├── shortestPath.ts       # Dijkstra, A*, Bidirectional, Greedy Best-First & Bellman-Ford
│   ├── tspDelivery.ts        # Held-Karp Bitmask DP vs. Greedy Nearest-Neighbor TSP
│   ├── mstPlanner.ts         # Kruskal (Union-Find) & Prim Minimum Spanning Tree
│   └── __tests__/
│       └── routing.test.ts   # Automated Node.js test suite verifying all DAA algorithms
├── components/
│   ├── RealMapStreetCanvas.tsx # Full-screen Web Mercator slippy map + 60 FPS street-wave canvas
│   └── NavigationPlanner.tsx   # Google Maps sidebar, live search, GPS locator & split-screen race UI
├── App.tsx
└── main.tsx
```

---

## Quick Start

```bash
# Install dependencies
npm install

# Run the automated DAA algorithm unit tests (7/7 tests)
npm test

# Start the local development server
npm run dev

# Build for production
npm run build
```
