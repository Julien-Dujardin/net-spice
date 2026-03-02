import { Injectable } from '@angular/core';
import { CircuitService } from './circuit.service';
import { UndoRedoService } from './undo-redo.service';
import { Wire, Point, GRID, ComponentType } from '../models/circuit.model';

// ═══════════════════════════════════════════════════════════════════
//  RewireService — Clean topology-preserving rewire
//
//  Reads the current electrical connectivity (node map), deletes
//  every wire, then re-routes clean orthogonal connections that
//  restore the exact same topology with minimal wire length.
//
//  Algorithm:
//    1. Snapshot which pins belong to which net (via solveNodes).
//    2. Group pins by net name.
//    3. For each net with ≥ 2 pins, build a Minimum Spanning Tree
//       using Manhattan distance (Prim's algorithm).
//    4. Route a clean orthogonal path for every MST edge.
//    5. Replace all wires, then run cleanup + consolidation.
// ═══════════════════════════════════════════════════════════════════

/** A component pin with its absolute position and routing metadata. */
interface PinInfo {
    componentId: string;
    portKey: string;
    x: number;
    y: number;
}

@Injectable({ providedIn: 'root' })
export class RewireService {

    constructor(
        private circuit: CircuitService,
        private undoRedo: UndoRedoService
    ) { }

    // ── Public API ───────────────────────────────────────────────

    /**
     * Delete all wires and re-create clean connections that
     * preserve the current circuit topology.
     */
    rewire(): void {
        const oldWires = [...this.circuit.wires()];
        const nets = this.buildNets();
        const newWires = this.routeAllNets(nets);

        this.circuit.wires.set(newWires);
        this.circuit.cleanupWires(true);   // single-pass: flatten, dedup, split overlaps, consolidate

        const finalWires = [...this.circuit.wires()];

        this.undoRedo.addToHistory({
            undo: () => {
                this.circuit.wires.set(oldWires);
            },
            redo: () => {
                this.circuit.wires.set(finalWires);
            },
            description: 'Rewire circuit',
        });
    }

    // ── Step 1 — Build nets ──────────────────────────────────────

    /**
     * Group every component pin by its net name.
     * Returns only nets with ≥ 2 pins (single-pin nets need no wire).
     *
     * Anchor components (GND, NET_IN, NET_OUT, NET_INOUT) define named
     * nodes implicitly — they should never be wired to each other.
     * When a net has multiple anchors, we split it into sub-nets,
     * each centered on one anchor, with regular pins assigned to
     * the nearest anchor (Manhattan distance).
     */
    private buildNets(): Map<string, PinInfo[]> {
        const nodeMap = this.circuit.nodeMap();
        const components = this.circuit.components();
        const nets = new Map<string, PinInfo[]>();

        // Anchor types: components that implicitly name a node
        const ANCHOR_TYPES: Set<string> = new Set([
            'GND', 'NET_IN', 'NET_OUT', 'NET_INOUT',
        ]);
        const anchorIds = new Set(
            components.filter(c => ANCHOR_TYPES.has(c.type)).map(c => c.id)
        );

        for (const comp of components) {
            for (const port of this.circuit.getAbsPorts(comp)) {
                const netName = nodeMap.get(`${comp.id}.${port.key}`);
                if (!netName) continue;

                let group = nets.get(netName);
                if (!group) { group = []; nets.set(netName, group); }
                group.push({
                    componentId: comp.id,
                    portKey: port.key,
                    x: port.x,
                    y: port.y,
                });
            }
        }

        // Split nets that contain multiple anchor components
        const finalNets = new Map<string, PinInfo[]>();

        for (const [name, pins] of nets) {
            const anchors = pins.filter(p => anchorIds.has(p.componentId));
            const regular = pins.filter(p => !anchorIds.has(p.componentId));

            if (anchors.length <= 1) {
                // 0 or 1 anchor: keep the net intact
                if (pins.length >= 2) finalNets.set(name, pins);
            } else {
                // Multiple anchors: split into sub-nets.
                // Each regular pin is assigned to the nearest anchor.
                // Anchors are never wired to each other.
                const subNets = anchors.map((a, i) => ({
                    key: `${name}§${i}`,
                    pins: [a] as PinInfo[],
                }));

                for (const pin of regular) {
                    let bestIdx = 0;
                    let bestDist = Infinity;
                    for (let i = 0; i < anchors.length; i++) {
                        const d = Math.abs(pin.x - anchors[i].x)
                            + Math.abs(pin.y - anchors[i].y);
                        if (d < bestDist) { bestDist = d; bestIdx = i; }
                    }
                    subNets[bestIdx].pins.push(pin);
                }

                for (const sub of subNets) {
                    if (sub.pins.length >= 2) finalNets.set(sub.key, sub.pins);
                }
            }
        }

        return finalNets;
    }

    // ── Step 2 — Route all nets ──────────────────────────────────

    /**
     * For every net, compute the MST and route wires along its edges.
     */
    private routeAllNets(nets: Map<string, PinInfo[]>): Wire[] {
        const allWires: Wire[] = [];
        let wireIdx = 0;

        for (const [, pins] of nets) {
            const edges = this.minimumSpanningTree(pins);

            for (const [i, j] of edges) {
                const from = pins[i];
                const to = pins[j];

                const segments = this.routeClean(from, to, wireIdx);
                allWires.push(...segments);
                wireIdx += segments.length;
            }
        }

        // Deduplicate identical segments (same endpoints, either direction)
        const seen = new Set<string>();
        return allWires.filter(w => {
            const a = w.points[0], b = w.points[1];
            const k1 = `${a.x},${a.y}-${b.x},${b.y}`;
            const k2 = `${b.x},${b.y}-${a.x},${a.y}`;
            if (seen.has(k1) || seen.has(k2)) return false;
            seen.add(k1);
            return true;
        });
    }

    // ── MST — Prim's algorithm (Manhattan distance) ──────────────

    /**
     * Returns edges as index pairs [i, j] into the pins array.
     * Uses Prim's algorithm — simple and optimal for the small
     * pin counts typical in SPICE circuits (2–6 per net).
     */
    private minimumSpanningTree(pins: PinInfo[]): [number, number][] {
        const n = pins.length;
        if (n <= 1) return [];
        if (n === 2) return [[0, 1]];

        const inTree = new Array<boolean>(n).fill(false);
        const minCost = new Array<number>(n).fill(Infinity);
        const minEdge = new Array<number>(n).fill(-1);
        const edges: [number, number][] = [];

        // Start from pin 0
        minCost[0] = 0;

        for (let step = 0; step < n; step++) {
            // Pick the cheapest vertex not yet in the tree
            let u = -1;
            for (let v = 0; v < n; v++) {
                if (!inTree[v] && (u === -1 || minCost[v] < minCost[u])) u = v;
            }

            inTree[u] = true;
            if (minEdge[u] !== -1) edges.push([minEdge[u], u]);

            // Update costs for neighbours
            for (let v = 0; v < n; v++) {
                if (inTree[v]) continue;
                const d = this.manhattan(pins[u], pins[v]);
                if (d < minCost[v]) {
                    minCost[v] = d;
                    minEdge[v] = u;
                }
            }
        }

        return edges;
    }

    private manhattan(a: PinInfo, b: PinInfo): number {
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }

    // ── Routing — single clean connection ────────────────────────

    /**
     * Route wire segments between two pins using routeSmart.
     * Returns decomposed 2-point H/V segments ready for the wire array.
     */
    private routeClean(from: PinInfo, to: PinInfo, startIdx: number): Wire[] {
        const comp = (id: string) => this.circuit.components().find(c => c.id === id);

        const fromComp = comp(from.componentId);
        const toComp = comp(to.componentId);

        const dir1 = fromComp
            ? this.circuit.getPortDirection(fromComp, from.portKey)
            : undefined;
        const dir2 = toComp
            ? this.circuit.getPortDirection(toComp, to.portKey)
            : undefined;

        const pts = this.circuit.routeSmart(
            { x: from.x, y: from.y },
            { x: to.x, y: to.y },
            dir1, dir2,
        );

        // Decompose into individual 2-point segments
        return this.decompose(pts, startIdx);
    }

    /**
     * Decompose a polyline into strict 2-point H/V segments.
     */
    private decompose(pts: Point[], startIdx: number): Wire[] {
        const snap = (v: number) => Math.round(v / GRID) * GRID;
        const segs: Wire[] = [];

        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            if (a.x === b.x && a.y === b.y) continue;

            // If diagonal, break through a bend
            if (a.x !== b.x && a.y !== b.y) {
                const mid = { x: snap(b.x), y: snap(a.y) };
                segs.push({ id: `rw${startIdx + segs.length}`, points: [a, mid] });
                segs.push({ id: `rw${startIdx + segs.length}`, points: [mid, b] });
            } else {
                segs.push({ id: `rw${startIdx + segs.length}`, points: [a, b] });
            }
        }

        return segs;
    }
}
