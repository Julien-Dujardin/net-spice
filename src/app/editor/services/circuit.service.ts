import { Injectable, signal, computed } from '@angular/core';
import {
    CircuitComponent, Wire, ComponentType, ComponentProps, Point,
    RelativePort, AbsolutePort, PortRef, ProbeNode, MultiColData,
    GRID, PROBE_COLORS, COMPONENT_DEFAULTS,
    SimConfig, DEFAULT_SIM_CONFIG,
} from '../models/circuit.model';
import {
    isLibraryComponent, getGenericDef, getSpecificDef, buildCustomModelDirective,
    GenericComponentDef,
} from '../models/component-library';
import { NetlistError } from './error.service';
import { UndoRedoService } from './undo-redo.service';

// ═══════════════════════════════════════════════════════════════════
//  CircuitService — LTspice-style wiring
//
//  Key principles:
//  1. Wires are pure geometry (polylines of grid-snapped points).
//  2. Connections are determined by coordinate coincidence — no
//     explicit from/to references between wires and components.
//  3. Junction dots are **computed** (not stored) wherever 3+
//     segment-endpoints or pins share the same grid point.
//  4. Components placed pin-to-pin are automatically connected.
// ═══════════════════════════════════════════════════════════════════

@Injectable({ providedIn: 'root' })
export class CircuitService {
    private idCounter = 1;
    private _inCleanup = false;

    constructor(private undoRedo: UndoRedoService) { }

    /** Simulation configuration */
    readonly simConfig = signal<SimConfig>({ ...DEFAULT_SIM_CONFIG });

    // ── State ─────────────────────────────────────────────────────

    readonly components = signal<CircuitComponent[]>([]);
    readonly wires = signal<Wire[]>([]);
    readonly autoCleanup = true;

    /**
     * When a specific part is chosen from the library menu, this signal
     * holds the part definition so that the next placed component gets
     * its model/partNumber props set automatically.
     */
    readonly pendingSpecificPart = signal<import('../models/component-library').SpecificComponentDef | null>(null);

    // ── Computed ──────────────────────────────────────────────────

    readonly nodeMap = computed(() =>
        this.solveNodes(this.components(), this.wires()));

    readonly probeNodes = computed(() =>
        this.getProbeNodes(this.components(), this.nodeMap()));

    /** Points where a junction dot should be drawn (≥ 3 connections). */
    readonly junctionPoints = computed(() =>
        this.computeJunctions(this.components(), this.wires()));

    // ── Utility ──────────────────────────────────────────────────

    snap(v: number): number {
        return Math.round(v / GRID) * GRID;
    }

    /** Grid-point key for coordinate lookups. */
    private gk(x: number, y: number): string {
        return `${x},${y}`;
    }

    /** Deep-snapshot the current wires array (for snapshot-based undo/redo). */
    private snapshotWires(): Wire[] {
        return this.wires().map(w => ({ ...w, points: w.points.map(p => ({ ...p })) }));
    }

    /**
     * Find a wire by geometry when the ID has become stale (e.g. after cleanup
     * renamed it).  Tries exact endpoint match first, then midpoint proximity.
     */
    findWireByGeometry(points: Point[]): string | null {
        if (points.length < 2) return null;
        const p0 = points[0], p1 = points[points.length - 1];
        // Exact endpoint match
        const exact = this.wires().find(w => {
            if (w.points.length < 2) return false;
            const a = w.points[0], b = w.points[w.points.length - 1];
            return (a.x === p0.x && a.y === p0.y && b.x === p1.x && b.y === p1.y) ||
                (a.x === p1.x && a.y === p1.y && b.x === p0.x && b.y === p0.y);
        });
        if (exact) return exact.id;
        // Midpoint proximity fallback
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const seg = this.findWireSegmentNear(midX, midY, 5);
        return seg?.wireId ?? null;
    }

    parseSpiceVal(s: string): number {
        if (!s) return 0;
        s = String(s).trim().toLowerCase();
        const map: Record<string, number> = {
            k: 1e3, meg: 1e6, g: 1e9, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
        };
        for (const [sf, mult] of Object.entries(map)) {
            if (s.endsWith(sf)) return parseFloat(s) * mult;
        }
        return parseFloat(s) || 0;
    }

    // ── Component CRUD ───────────────────────────────────────────

    makeComp(type: ComponentType, x: number, y: number): CircuitComponent {
        const id = type + this.idCounter++;
        const defaults = COMPONENT_DEFAULTS[type] || {};
        const props: ComponentProps = { ...defaults };

        // If a specific part was selected from the library, apply its overrides
        const pending = this.pendingSpecificPart();
        if (pending && pending.genericKey === type) {
            props.model = pending.modelName;
            props.partNumber = pending.partNumber;
            if (pending.propsOverride) {
                Object.assign(props, pending.propsOverride);
            }
            this.pendingSpecificPart.set(null);
        }

        return {
            id, type,
            x: this.snap(x),
            y: this.snap(y),
            rotation: 0,
            props,
        };
    }

    addComponent(comp: CircuitComponent, addToHistory = true): void {
        this._addComponent(comp);
        if (addToHistory) {
            this.undoRedo.addToHistory({
                undo: () => this._removeComponent(comp.id),
                redo: () => this._addComponent(comp),
                description: `Add ${comp.type}`,
            });
        }
    }

    private _addComponent(comp: CircuitComponent): void {
        this.components.update(cs => [...cs, comp]);
    }

    removeComponent(id: string, addToHistory = true): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const wiresBefore = this.snapshotWires();

        this._removeComponent(id);

        if (addToHistory) {
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => {
                    this.components.update(cs => [...cs, comp]);
                    this.wires.set(wiresBefore);
                },
                redo: () => {
                    this.components.update(cs => cs.filter(c => c.id !== id));
                    this.wires.set(wiresAfter);
                },
                description: `Delete ${comp.type}`,
            });
        }
    }

    private _removeComponent(id: string): void {
        const comp = this.components().find(c => c.id === id);
        if (comp) {
            const pinSet = new Set(
                this.getAbsPorts(comp).map(p => this.gk(p.x, p.y))
            );
            this.wires.update(ws => ws.filter(w => {
                const first = w.points[0];
                const last = w.points[w.points.length - 1];
                return !pinSet.has(this.gk(first.x, first.y)) &&
                    !pinSet.has(this.gk(last.x, last.y));
            }));
        }
        this.components.update(cs => cs.filter(c => c.id !== id));
        this.afterWireMutation();
    }

    updateComponentProps(id: string, key: string, value: string, addToHistory = true): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const oldValue = (comp.props as any)[key] || '';
        if (oldValue === value) return;

        this._updateComponentProps(id, key, value);

        if (addToHistory) {
            this.undoRedo.addToHistory({
                undo: () => this._updateComponentProps(id, key, oldValue),
                redo: () => this._updateComponentProps(id, key, value),
                description: `Update ${key}`,
            });
        }
    }

    private _updateComponentProps(id: string, key: string, value: string): void {
        this.components.update(cs => cs.map(c =>
            c.id === id ? { ...c, props: { ...c.props, [key]: value } } : c
        ));
    }

    /** Move a component **and** drag attached wire endpoints along. */
    moveComponent(id: string, x: number, y: number, addToHistory = true): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const sx = this.snap(x);
        const sy = this.snap(y);
        const dx = sx - comp.x;
        const dy = sy - comp.y;
        if (dx === 0 && dy === 0) return;

        const oldX = comp.x;
        const oldY = comp.y;
        const wiresBefore = this.snapshotWires();

        this._moveComponent(id, x, y);

        if (addToHistory) {
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => {
                    this.components.update(cs =>
                        cs.map(c => c.id === id ? { ...c, x: oldX, y: oldY } : c)
                    );
                    this.wires.set(wiresBefore);
                },
                redo: () => {
                    this.components.update(cs =>
                        cs.map(c => c.id === id ? { ...c, x: sx, y: sy } : c)
                    );
                    this.wires.set(wiresAfter);
                },
                description: 'Move component',
            });
        }
    }

    private _moveComponent(id: string, x: number, y: number): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const sx = this.snap(x);
        const sy = this.snap(y);
        const dx = sx - comp.x;
        const dy = sy - comp.y;
        if (dx === 0 && dy === 0) return;

        const oldPins = new Set(
            this.getAbsPorts(comp).map(p => this.gk(p.x, p.y))
        );

        this.components.update(cs =>
            cs.map(c => c.id === id ? { ...c, x: sx, y: sy } : c)
        );

        // Drag wire vertices that sat on old pin positions and fix orthogonality
        this.wires.update(ws => ws.map(w => {
            let touched = false;
            const pts = w.points.map(pt => {
                if (oldPins.has(this.gk(pt.x, pt.y))) {
                    touched = true;
                    return { x: pt.x + dx, y: pt.y + dy };
                }
                return pt;
            });
            return touched ? { ...w, points: this.ensureOrthogonal(pts) } : w;
        }));
        this.afterWireMutation();
    }

    /** Rotate a component and relocate attached wire vertices. */
    rotateComponent(id: string, addToHistory = true): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const oldRotation = comp.rotation;
        const wiresBefore = this.snapshotWires();

        this._rotateComponent(id);

        if (addToHistory) {
            const newRotation = (oldRotation + 90) % 360;
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => {
                    this.components.update(cs =>
                        cs.map(c => c.id === id ? { ...c, rotation: oldRotation } : c)
                    );
                    this.wires.set(wiresBefore);
                },
                redo: () => {
                    this.components.update(cs =>
                        cs.map(c => c.id === id ? { ...c, rotation: newRotation } : c)
                    );
                    this.wires.set(wiresAfter);
                },
                description: 'Rotate component',
            });
        }
    }

    private _rotateComponent(id: string): void {
        const comp = this.components().find(c => c.id === id);
        if (!comp) return;

        const oldPins = this.getAbsPorts(comp);
        const rotated = { ...comp, rotation: (comp.rotation + 90) % 360 };
        const newPins = this.getAbsPorts(rotated);

        const pinMap = new Map<string, Point>();
        for (let i = 0; i < oldPins.length; i++) {
            pinMap.set(
                this.gk(oldPins[i].x, oldPins[i].y),
                { x: newPins[i].x, y: newPins[i].y },
            );
        }

        this.components.update(cs =>
            cs.map(c => c.id === id ? rotated : c)
        );

        this.wires.update(ws => ws.map(w => {
            let touched = false;
            const pts = w.points.map(pt => {
                const np = pinMap.get(this.gk(pt.x, pt.y));
                if (np) { touched = true; return { ...np }; }
                return pt;
            });
            return touched ? { ...w, points: this.ensureOrthogonal(pts) } : w;
        }));
        this.afterWireMutation();
    }

    // ── Batch (multi-selection) operations ────────────────────────

    /**
     * Move a set of components and wire segments by (dx, dy).
     * Wire endpoints that sit on a selected component's pin OR belong
     * to a selected wire are moved together.  Single undo/redo entry.
     */
    moveSelection(
        compIds: ReadonlySet<string>,
        wireIds: ReadonlySet<string>,
        dx: number, dy: number,
        addToHistory = true,
    ): void {
        dx = this.snap(dx);
        dy = this.snap(dy);
        if (dx === 0 && dy === 0) return;

        const compsBefore = this.components().map(c => ({ ...c }));
        const wiresBefore = this.snapshotWires();

        // Collect all pin keys for the selected components (before move)
        const selectedPinKeys = new Set<string>();
        for (const c of this.components()) {
            if (!compIds.has(c.id)) continue;
            for (const p of this.getAbsPorts(c)) {
                selectedPinKeys.add(this.gk(p.x, p.y));
            }
        }

        // Move components
        this.components.update(cs => cs.map(c => {
            if (!compIds.has(c.id)) return c;
            return { ...c, x: this.snap(c.x + dx), y: this.snap(c.y + dy) };
        }));

        // Move wires: selected wires move entirely; other wires only
        // have their endpoints dragged if they touch a selected pin.
        this.wires.update(ws => ws.map(w => {
            if (wireIds.has(w.id)) {
                return {
                    ...w,
                    points: w.points.map(p => ({
                        x: this.snap(p.x + dx),
                        y: this.snap(p.y + dy),
                    })),
                };
            }
            let touched = false;
            const pts = w.points.map(pt => {
                if (selectedPinKeys.has(this.gk(pt.x, pt.y))) {
                    touched = true;
                    return { x: pt.x + dx, y: pt.y + dy };
                }
                return pt;
            });
            return touched ? { ...w, points: this.ensureOrthogonal(pts) } : w;
        }));

        this.afterWireMutation();

        if (addToHistory) {
            const compsAfter = this.components().map(c => ({ ...c }));
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => {
                    this.components.set(compsBefore);
                    this.wires.set(wiresBefore);
                },
                redo: () => {
                    this.components.set(compsAfter);
                    this.wires.set(wiresAfter);
                },
                description: 'Move selection',
            });
        }
    }

    /**
     * Delete a set of components + wire segments in one undo entry.
     */
    removeSelection(
        compIds: ReadonlySet<string>,
        wireIds: ReadonlySet<string>,
        addToHistory = true,
    ): void {
        if (compIds.size === 0 && wireIds.size === 0) return;

        const compsBefore = this.components().map(c => ({ ...c, props: { ...c.props } }));
        const wiresBefore = this.snapshotWires();

        // Remove selected wires first
        if (wireIds.size > 0) {
            this.wires.update(ws => ws.filter(w => !wireIds.has(w.id)));
        }

        // Remove selected components (and their attached wires)
        for (const cid of compIds) {
            this._removeComponent(cid);
        }

        if (addToHistory) {
            const compsAfter = this.components().map(c => ({ ...c, props: { ...c.props } }));
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => {
                    this.components.set(compsBefore);
                    this.wires.set(wiresBefore);
                },
                redo: () => {
                    this.components.set(compsAfter);
                    this.wires.set(wiresAfter);
                },
                description: 'Delete selection',
            });
        }
    }

    // ── Wire helpers ──────────────────────────────────────────────

    /**
     * Decompose a polyline into individual straight (2-point) segments.
     * This is the canonical form: every wire is a single H or V line.
     */
    private decomposeToSegments(pts: Point[], idPrefix: string): Wire[] {
        const simplified = this.simplify(pts);
        const segs: Wire[] = [];
        for (let i = 0; i < simplified.length - 1; i++) {
            const a = simplified[i], b = simplified[i + 1];
            if (a.x === b.x && a.y === b.y) continue;
            segs.push({ id: idPrefix + '_' + i, points: [a, b] });
        }
        return segs;
    }

    // ── Array-based helpers (pure functions, no signal read/write) ──

    /** Decompose all wires into strict 2-point H/V segments. */
    private flattenArray(ws: Wire[]): Wire[] {
        const out: Wire[] = [];
        for (const w of ws) {
            if (w.points.length > 2) {
                out.push(...this.decomposeToSegments(w.points, w.id));
            } else if (
                w.points.length === 2 &&
                w.points[0].x !== w.points[1].x &&
                w.points[0].y !== w.points[1].y
            ) {
                const a = w.points[0], b = w.points[1];
                out.push(
                    { id: w.id + '_h', points: [a, { x: b.x, y: a.y }] },
                    { id: w.id + '_v', points: [{ x: b.x, y: a.y }, b] },
                );
            } else {
                out.push(w);
            }
        }
        return out;
    }

    /** Snap all wire points to grid. */
    private snapArray(ws: Wire[]): Wire[] {
        return ws.map(w => ({
            ...w,
            points: w.points.map(p => ({ x: this.snap(p.x), y: this.snap(p.y) })),
        }));
    }

    /** Remove zero-length or degenerate wires. */
    private removeZeroLength(ws: Wire[]): Wire[] {
        return ws.filter(w =>
            w.points.length >= 2 &&
            (w.points[0].x !== w.points[1].x || w.points[0].y !== w.points[1].y)
        );
    }

    /** Remove exact duplicate segments (same two endpoints, either direction). */
    private dedup(ws: Wire[]): Wire[] {
        const seen = new Set<string>();
        return ws.filter(w => {
            if (w.points.length !== 2) return true;
            const a = w.points[0], b = w.points[1];
            const k1 = `${a.x},${a.y}-${b.x},${b.y}`;
            const k2 = `${b.x},${b.y}-${a.x},${a.y}`;
            if (seen.has(k1) || seen.has(k2)) return false;
            seen.add(k1);
            return true;
        });
    }

    /** Merge collinear 2-point segments at non-junction points. */
    private consolidateArray(ws: Wire[]): Wire[] {
        ws = ws.map(w => ({ ...w, points: [...w.points] }));
        let changed = true;
        while (changed) {
            changed = false;
            const endpointCount = new Map<string, number>();
            const inc = (x: number, y: number) => {
                const k = this.gk(x, y);
                endpointCount.set(k, (endpointCount.get(k) ?? 0) + 1);
            };
            for (const w of ws) { for (const p of w.points) inc(p.x, p.y); }
            for (const c of this.components()) {
                for (const p of this.getAbsPorts(c)) inc(p.x, p.y);
            }
            for (let i = 0; i < ws.length && !changed; i++) {
                for (let j = i + 1; j < ws.length && !changed; j++) {
                    const merged = this.tryMergeIfSafe(ws[i], ws[j], endpointCount);
                    if (merged) {
                        ws.splice(j, 1);
                        ws[i] = merged;
                        changed = true;
                    }
                }
            }
        }
        return ws;
    }

    // ── Wire CRUD ────────────────────────────────────────────────

    addWire(wire: Wire, addToHistory = true): void {
        if (wire.points.length < 2) return;
        const cleaned = { ...wire, points: this.simplify(wire.points) };
        if (cleaned.points.length < 2) return;

        // Decompose into individual straight (2-point) segments
        const segs = this._createWireSegments(cleaned);
        if (segs.length === 0) return;

        const wiresBefore = this.snapshotWires();

        this._addWireSegments(segs);

        if (addToHistory) {
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => this.wires.set(wiresBefore),
                redo: () => this.wires.set(wiresAfter),
                description: 'Add wire',
            });
        }
    }

    private _createWireSegments(wire: Wire): Wire[] {
        const segs: Wire[] = [];
        for (let i = 0; i < wire.points.length - 1; i++) {
            const a = wire.points[i];
            const b = wire.points[i + 1];
            if (a.x === b.x && a.y === b.y) continue;
            segs.push({ id: 'w' + Date.now() + '_' + i, points: [a, b] });
        }
        return segs;
    }

    private _addWire(wire: Wire): void {
        this.wires.update(ws => [...ws, wire]);
    }

    private _restoreWires(wires: Wire[]): void {
        this.wires.update(ws => [...ws, ...wires]);
        this.afterWireMutation();
    }

    private _addWireSegments(segs: Wire[]): void {
        this.wires.update(ws => [...ws, ...segs]);
        this.afterWireMutation();
    }

    removeWire(id: string, addToHistory = true): void {
        const target = this.wires().find(w => w.id === id);
        if (!target) return;

        const wiresBefore = this.snapshotWires();

        this._removeWire(id);

        if (addToHistory) {
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => this.wires.set(wiresBefore),
                redo: () => this.wires.set(wiresAfter),
                description: 'Delete wire',
            });
        }
    }

    private _getRemovedWires(id: string, target: Wire): Wire[] {
        if (target.points.length < 2) {
            return [target];
        }

        const a = target.points[0], b = target.points[target.points.length - 1];
        const k1 = `${a.x},${a.y}-${b.x},${b.y}`;
        const k2 = `${b.x},${b.y}-${a.x},${a.y}`;

        return this.wires().filter(w => {
            if (w.points.length !== 2) return w.id === id;
            const wa = w.points[0], wb = w.points[1];
            const wk = `${wa.x},${wa.y}-${wb.x},${wb.y}`;
            return wk === k1 || wk === k2;
        });
    }

    private _removeWire(id: string): void {
        const target = this.wires().find(w => w.id === id);
        if (!target || target.points.length < 2) {
            // Fallback: just remove by id
            this.wires.update(ws => ws.filter(w => w.id !== id));
        } else {
            // Remove the wire AND any exact duplicates (same endpoints)
            const a = target.points[0], b = target.points[target.points.length - 1];
            const k1 = `${a.x},${a.y}-${b.x},${b.y}`;
            const k2 = `${b.x},${b.y}-${a.x},${a.y}`;
            this.wires.update(ws => ws.filter(w => {
                if (w.points.length !== 2) return w.id !== id;
                const wa = w.points[0], wb = w.points[1];
                const wk = `${wa.x},${wa.y}-${wb.x},${wb.y}`;
                return wk !== k1 && wk !== k2;
            }));
        }
        this.afterWireMutation();
    }

    /**
     * Move a wire segment by a delta offset while preserving connectivity.
     * Bridge segments are added at each endpoint so that neighbouring
     * wires and component pins stay connected — the consolidation pass
     * then merges collinear bridges with their neighbours automatically.
     */
    moveWire(id: string, dx: number, dy: number, addToHistory = true): void {
        if (dx === 0 && dy === 0) return;

        const wire = this.wires().find(w => w.id === id);
        if (!wire || wire.points.length < 2) return;

        const wiresBefore = this.snapshotWires();

        this._moveWire(id, dx, dy);

        if (addToHistory) {
            const wiresAfter = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => this.wires.set(wiresBefore),
                redo: () => this.wires.set(wiresAfter),
                description: 'Move wire',
            });
        }
    }

    private _moveWire(id: string, dx: number, dy: number): Wire[] {
        const wire = this.wires().find(w => w.id === id);
        if (!wire || wire.points.length < 2) return [];

        const oldP0 = wire.points[0];
        const oldP1 = wire.points[wire.points.length - 1];
        const newP0: Point = { x: this.snap(oldP0.x + dx), y: this.snap(oldP0.y + dy) };
        const newP1: Point = { x: this.snap(oldP1.x + dx), y: this.snap(oldP1.y + dy) };

        // Only add a bridge if something else is actually connected at that point
        const hasConnectionAt = (pt: Point, excludeId: string): boolean => {
            const k = this.gk(pt.x, pt.y);
            for (const w of this.wires()) {
                if (w.id === excludeId) continue;
                for (const p of w.points) {
                    if (this.gk(p.x, p.y) === k) return true;
                }
            }
            for (const c of this.components()) {
                for (const p of this.getAbsPorts(c)) {
                    if (this.gk(p.x, p.y) === k) return true;
                }
            }
            return false;
        };

        const bridges: Wire[] = [];
        if ((oldP0.x !== newP0.x || oldP0.y !== newP0.y) && hasConnectionAt(oldP0, id)) {
            bridges.push({
                id: 'w' + Date.now() + '_b0',
                points: [{ ...oldP0 }, { ...newP0 }],
            });
        }
        if ((oldP1.x !== newP1.x || oldP1.y !== newP1.y) && hasConnectionAt(oldP1, id)) {
            bridges.push({
                id: 'w' + (Date.now() + 1) + '_b1',
                points: [{ ...oldP1 }, { ...newP1 }],
            });
        }

        // Move the wire and add bridges in one update
        this.wires.update(ws => {
            const updated = ws.map(w => {
                if (w.id !== id) return w;
                return {
                    ...w,
                    points: w.points.map(p => ({
                        x: this.snap(p.x + dx),
                        y: this.snap(p.y + dy),
                    })),
                };
            });
            return [...updated, ...bridges];
        });

        this.afterWireMutation();
        return bridges;
    }

    private _moveWireWithBridges(id: string, dx: number, dy: number, bridges: Wire[]): void {
        this.wires.update(ws => {
            const updated = ws.map(w => {
                if (w.id !== id) return w;
                return {
                    ...w,
                    points: w.points.map(p => ({
                        x: this.snap(p.x + dx),
                        y: this.snap(p.y + dy),
                    })),
                };
            });
            return [...updated, ...bridges];
        });
        this.afterWireMutation();
    }

    /** Split a wire at the given grid point, producing two wires. */
    splitWireAt(wireId: string, pt: Point): void {
        const wire = this.wires().find(w => w.id === wireId);
        if (!wire) return;

        const sp = { x: this.snap(pt.x), y: this.snap(pt.y) };
        let segIdx = -1;
        for (let i = 0; i < wire.points.length - 1; i++) {
            if (this.pointOnSegment(sp, wire.points[i], wire.points[i + 1])) {
                segIdx = i; break;
            }
        }
        if (segIdx === -1) return;

        const left: Point[] = [...wire.points.slice(0, segIdx + 1), sp];
        const right: Point[] = [sp, ...wire.points.slice(segIdx + 1)];

        const w1: Wire = { id: 'w' + Date.now(), points: this.simplify(left) };
        const w2: Wire = { id: 'w' + (Date.now() + 1), points: this.simplify(right) };

        this.wires.update(ws => {
            const rest = ws.filter(w => w.id !== wireId);
            if (w1.points.length >= 2) rest.push(w1);
            if (w2.points.length >= 2) rest.push(w2);
            return rest;
        });
        this.afterWireMutation();
    }

    // ── Query helpers ────────────────────────────────────────────

    /** Find the nearest component port within a radius. */
    findNearestPort(
        x: number, y: number, radius = 18, excludeId: string | null = null
    ): PortRef | null {
        let best: PortRef | null = null;
        let bestD = Infinity;
        for (const c of this.components()) {
            if (c.id === excludeId) continue;
            for (const port of this.getAbsPorts(c)) {
                const d = Math.hypot(x - port.x, y - port.y);
                if (d < radius && d < bestD) {
                    bestD = d;
                    best = { cid: c.id, port: port.key, x: port.x, y: port.y };
                }
            }
        }
        return best;
    }

    /** Find the nearest wire vertex (endpoint or bend). */
    findWireVertexNear(
        x: number, y: number, radius = 12, excludeWireId?: string
    ): { wireId: string; ptIdx: number; point: Point } | null {
        let best: { wireId: string; ptIdx: number; point: Point } | null = null;
        let bestD = Infinity;
        for (const w of this.wires()) {
            if (w.id === excludeWireId) continue;
            for (let i = 0; i < w.points.length; i++) {
                const d = Math.hypot(x - w.points[i].x, y - w.points[i].y);
                if (d < radius && d < bestD) {
                    bestD = d; best = { wireId: w.id, ptIdx: i, point: w.points[i] };
                }
            }
        }
        return best;
    }

    /** Find the nearest wire segment (line between two consecutive vertices). */
    findWireSegmentNear(
        x: number, y: number, radius = 10
    ): { wireId: string; segIdx: number; closest: Point } | null {
        let best: { wireId: string; segIdx: number; closest: Point } | null = null;
        let bestD = Infinity;
        for (const w of this.wires()) {
            for (let i = 0; i < w.points.length - 1; i++) {
                const cp = this.closestPointOnSeg(x, y, w.points[i], w.points[i + 1]);
                const d = Math.hypot(x - cp.x, y - cp.y);
                if (d < radius && d < bestD) {
                    bestD = d;
                    best = {
                        wireId: w.id, segIdx: i,
                        closest: { x: this.snap(cp.x), y: this.snap(cp.y) },
                    };
                }
            }
        }
        return best;
    }

    /**
     * Snap a world-coordinate to the best nearby target.
     * Priority: pin > wire vertex > wire segment > grid.
     */
    snapToTarget(x: number, y: number, excludeWireId?: string): {
        point: Point;
        type: 'pin' | 'vertex' | 'segment' | 'grid';
        detail?: any;
    } {
        const pin = this.findNearestPort(x, y, 18);
        if (pin) return { point: { x: pin.x, y: pin.y }, type: 'pin', detail: pin };

        const vtx = this.findWireVertexNear(x, y, 12, excludeWireId);
        if (vtx) return { point: vtx.point, type: 'vertex', detail: vtx };

        const seg = this.findWireSegmentNear(x, y, 10);
        if (seg) return { point: seg.closest, type: 'segment', detail: seg };

        return { point: { x: this.snap(x), y: this.snap(y) }, type: 'grid' };
    }

    // ── Ports ────────────────────────────────────────────────────

    getRelPorts(type: ComponentType): RelativePort[] {
        switch (type) {
            case 'R': return [{ key: 'p', rx: -40, ry: 0 }, { key: 'n', rx: 40, ry: 0 }];
            case 'C': return [{ key: 'p', rx: 0, ry: -40 }, { key: 'n', rx: 0, ry: 40 }];
            case 'L': return [{ key: 'p', rx: -40, ry: 0 }, { key: 'n', rx: 40, ry: 0 }];
            case 'V': return [{ key: 'p', rx: 0, ry: -40 }, { key: 'n', rx: 0, ry: 40 }];
            case 'GND': return [{ key: 'g', rx: 0, ry: -20 }];
            case 'PROBE': return [{ key: 'tip', rx: 0, ry: 20 }];
            case 'IPROBE': return [{ key: 'p', rx: -40, ry: 0 }, { key: 'n', rx: 40, ry: 0 }];
            case 'NET_IN': return [{ key: 'pin', rx: -40, ry: 0 }];
            case 'NET_OUT': return [{ key: 'pin', rx: 40, ry: 0 }];
            case 'NET_INOUT': return [{ key: 'pin', rx: -40, ry: 0 }];
            default: {
                // Look up library component
                const def = getGenericDef(type);
                if (def) return def.ports.map(p => ({ key: p.key, rx: p.rx, ry: p.ry }));
                return [];
            }
        }
    }

    getAbsPorts(comp: CircuitComponent): AbsolutePort[] {
        return this.getRelPorts(comp.type).map(p => {
            const rad = (comp.rotation * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            return {
                key: p.key,
                x: this.snap(comp.x + p.rx * cos - p.ry * sin),
                y: this.snap(comp.y + p.rx * sin + p.ry * cos),
            };
        });
    }

    getPortDirection(comp: CircuitComponent, portKey: string): { x: number; y: number } {
        const rel = this.getRelPorts(comp.type).find(p => p.key === portKey);
        if (!rel) return { x: 0, y: 0 };
        const rad = (comp.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const dx = rel.rx * cos - rel.ry * sin;
        const dy = rel.rx * sin + rel.ry * cos;
        const len = Math.sqrt(dx * dx + dy * dy);
        return len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
    }

    // ── Wire Routing ─────────────────────────────────────────────

    /**
     * Route an orthogonal L-shaped path between two grid points.
     * Returns a full polyline including start & end.
     */
    routeL(from: Point, to: Point, hFirst = true): Point[] {
        const fx = this.snap(from.x), fy = this.snap(from.y);
        const tx = this.snap(to.x), ty = this.snap(to.y);

        if (fx === tx || fy === ty) {
            return [{ x: fx, y: fy }, { x: tx, y: ty }];
        }

        const bend: Point = hFirst
            ? { x: tx, y: fy }
            : { x: fx, y: ty };

        return this.simplify([{ x: fx, y: fy }, bend, { x: tx, y: ty }]);
    }

    /**
     * Smart routing that respects port exit directions.
     * Used for the default circuit and programmatic wire creation.
     */
    routeSmart(
        from: Point, to: Point,
        dir1?: { x: number; y: number },
        dir2?: { x: number; y: number },
    ): Point[] {
        const fx = this.snap(from.x), fy = this.snap(from.y);
        const tx = this.snap(to.x), ty = this.snap(to.y);

        if (fx === tx || fy === ty) {
            return [{ x: fx, y: fy }, { x: tx, y: ty }];
        }

        const pts: Point[] = [{ x: fx, y: fy }];

        if (dir1 && dir2) {
            const h1 = Math.abs(dir1.x) > Math.abs(dir1.y);
            const h2 = Math.abs(dir2.x) > Math.abs(dir2.y);

            if (h1 && h2) {
                const midX = this.snap((fx + tx) / 2);
                pts.push({ x: midX, y: fy }, { x: midX, y: ty });
            } else if (!h1 && !h2) {
                const midY = this.snap((fy + ty) / 2);
                pts.push({ x: fx, y: midY }, { x: tx, y: midY });
            } else if (h1) {
                pts.push({ x: tx, y: fy });
            } else {
                pts.push({ x: fx, y: ty });
            }
        } else {
            if (Math.abs(tx - fx) >= Math.abs(ty - fy)) {
                pts.push({ x: tx, y: fy });
            } else {
                pts.push({ x: fx, y: ty });
            }
        }

        pts.push({ x: tx, y: ty });
        return this.simplify(pts);
    }

    // ── Node Solving (Union-Find by grid coordinate) ─────────────

    private solveNodes(
        components: CircuitComponent[],
        wires: Wire[]
    ): Map<string, string> {
        const parent: Record<string, string> = {};
        const init = (k: string) => { if (!(k in parent)) parent[k] = k; };
        const find = (k: string): string => {
            while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; }
            return k;
        };
        const union = (a: string, b: string) => { parent[find(a)] = find(b); };

        // Register every component pin
        for (const c of components) {
            for (const p of this.getAbsPorts(c)) {
                init(this.gk(p.x, p.y));
            }
        }

        // Register every wire vertex and union consecutive ones
        for (const w of wires) {
            for (let i = 0; i < w.points.length; i++) {
                const k = this.gk(w.points[i].x, w.points[i].y);
                init(k);
                if (i > 0) {
                    union(
                        this.gk(w.points[i - 1].x, w.points[i - 1].y),
                        k,
                    );
                }
            }
        }

        // Identify GND roots
        const gndRoots = new Set<string>();
        for (const c of components.filter(cc => cc.type === 'GND')) {
            const port = this.getAbsPorts(c).find(p => p.key === 'g');
            if (port) gndRoots.add(find(this.gk(port.x, port.y)));
        }

        // Identify NET label roots (named nodes)
        const netLabelRoots = new Map<string, string>(); // root -> label name
        for (const c of components.filter(cc => cc.type === 'NET_IN' || cc.type === 'NET_OUT' || cc.type === 'NET_INOUT')) {
            const label = c.props.label?.trim();
            if (!label) continue;
            const port = this.getAbsPorts(c).find(p => p.key === 'pin');
            if (port) netLabelRoots.set(find(this.gk(port.x, port.y)), label);
        }

        // Map each component-port to a human-readable node name
        const nameMap = new Map<string, string>();
        const rootNames: Record<string, string> = {};
        let nodeN = 1;

        for (const c of components) {
            for (const p of this.getAbsPorts(c)) {
                const root = find(this.gk(p.x, p.y));
                let name: string;
                if (gndRoots.has(root)) {
                    name = '0';
                } else if (netLabelRoots.has(root)) {
                    name = rootNames[root] ??= netLabelRoots.get(root)!;
                } else {
                    name = rootNames[root] ??= 'N' + nodeN++;
                }
                nameMap.set(`${c.id}.${p.key}`, name);
            }
        }

        return nameMap;
    }

    // ── Junction Points (computed, not stored) ───────────────────

    private computeJunctions(
        components: CircuitComponent[],
        wires: Wire[]
    ): Point[] {
        const counts = new Map<string, number>();
        const inc = (x: number, y: number) => {
            const k = this.gk(x, y);
            counts.set(k, (counts.get(k) ?? 0) + 1);
        };

        // Each wire *segment* contributes one endpoint-count at its start and end
        for (const w of wires) {
            for (let i = 0; i < w.points.length - 1; i++) {
                inc(w.points[i].x, w.points[i].y);
                inc(w.points[i + 1].x, w.points[i + 1].y);
            }
        }

        // Each component pin also counts
        for (const c of components) {
            for (const p of this.getAbsPorts(c)) {
                inc(p.x, p.y);
            }
        }

        const result: Point[] = [];
        counts.forEach((n, k) => {
            if (n >= 3) {
                const [x, y] = k.split(',').map(Number);
                result.push({ x, y });
            }
        });
        return result;
    }

    // ── Probe helpers ────────────────────────────────────────────

    private getProbeNodes(
        components: CircuitComponent[],
        nodeMap: Map<string, string>
    ): ProbeNode[] {
        const probes: ProbeNode[] = [];

        // Voltage probes
        const voltageProbes = components.filter(c => c.type === 'PROBE');
        voltageProbes.forEach((c, idx) => {
            const node = nodeMap.get(`${c.id}.tip`);
            const lbl = c.props.label || String.fromCharCode(65 + idx);
            const color = c.props.probeColor || PROBE_COLORS[idx % PROBE_COLORS.length];
            if (node && node !== '?') {
                probes.push({ node, label: lbl, color, type: 'voltage' });
            }
        });

        // Current probes
        const currentProbes = components.filter(c => c.type === 'IPROBE');
        currentProbes.forEach((c, idx) => {
            const pNode = nodeMap.get(`${c.id}.p`);
            const nNode = nodeMap.get(`${c.id}.n`);
            const lbl = c.props.label || 'I' + String.fromCharCode(65 + idx);
            const colorIdx = voltageProbes.length + idx;
            const color = c.props.probeColor || PROBE_COLORS[colorIdx % PROBE_COLORS.length];
            if (pNode && nNode && pNode !== '?' && nNode !== '?') {
                probes.push({ node: `V_${c.id}`, label: lbl, color, type: 'current' });
            }
        });

        return probes;
    }

    resolveProbeNode(probe: CircuitComponent): string | null {
        if (probe.type === 'IPROBE') {
            const pNode = this.nodeMap().get(`${probe.id}.p`);
            const nNode = this.nodeMap().get(`${probe.id}.n`);
            if (pNode && nNode) return `${pNode} → ${nNode}`;
            return null;
        }
        return this.nodeMap().get(`${probe.id}.tip`) || null;
    }

    /** Get the display color for a probe component (uses probeColor prop or falls back to index). */
    getProbeColor(comp: CircuitComponent): string {
        if (comp.props.probeColor) return comp.props.probeColor;
        const allProbes = this.components().filter(c => c.type === 'PROBE' || c.type === 'IPROBE');
        const idx = allProbes.indexOf(comp);
        return PROBE_COLORS[Math.max(0, idx) % PROBE_COLORS.length];
    }

    // ── Netlist Generation ───────────────────────────────────────

    private buildSpiceValue(comp: CircuitComponent): string {
        const p = comp.props;
        switch (p.waveform) {
            case 'SIN': return `SIN(${p.offset || 0} ${p.amp || 5} ${p.freq || 1000})`;
            case 'PULSE': return `PULSE(${p.pulse_v1 || 0} ${p.pulse_v2 || 5} ${p.pulse_td || 0} ${p.pulse_tr || '1u'} ${p.pulse_tf || '1u'} ${p.pulse_pw || '0.5m'} ${p.pulse_per || '1m'})`;
            case 'DC': return `DC ${p.dc || 5}`;
            case 'NOISE': return `TRNOISE(${p.amp || 1} 1u 0 0)`;
            default: return `DC ${p.dc || 0}`;
        }
    }

    /**
     * Collect the SPICE model directive needed for a library component.
     * If the component references a specific part (partNumber prop), use its model.
     * Otherwise fall back to the generic default model.
     */
    private collectModelDirective(comp: CircuitComponent, directives: Set<string>): void {
        // If spiceLine override is set, user handles the model themselves
        if (comp.props.spiceLine?.trim()) return;

        // If custom model text is provided, use it verbatim
        if (comp.props.customModel?.trim()) {
            directives.add(comp.props.customModel.trim());
            return;
        }

        // Check if a specific part was selected
        if (comp.props.partNumber) {
            const specific = getSpecificDef(comp.props.partNumber);
            if (specific) {
                directives.add(specific.spiceModel);
                return;
            }
        }

        // Check if user has edited simulation parameters
        const def = getGenericDef(comp.type);
        if (def) {
            const simParams = this.getSimParams(comp);
            if (Object.keys(simParams).length > 0) {
                const modelName = comp.props.model || def.defaultModelName || 'MOD';
                const custom = buildCustomModelDirective(def, modelName, simParams);
                if (custom) {
                    directives.add(custom);
                    return;
                }
            }
        }

        // Fall back to generic default model
        if (def?.defaultModel) {
            directives.add(def.defaultModel);
        }
    }

    /** Extract sim_* props into a Record<string, string> of SPICE params. */
    getSimParams(comp: CircuitComponent): Record<string, string> {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(comp.props)) {
            if (k.startsWith('sim_') && v) {
                params[k.slice(4)] = v as string;
            }
        }
        return params;
    }

    genNetlist(): string {
        const components = this.components();
        const nodeMap = this.nodeMap();
        const nk = (cid: string, port: string) => nodeMap.get(`${cid}.${port}`) || '?';

        let nl = '* SPICE auto-generated\n';

        // Collect model directives needed by library components
        const modelDirectives = new Set<string>();

        components.forEach(c => {
            // If spiceLine override is set, use it directly
            if (c.props.spiceLine?.trim()) {
                nl += c.props.spiceLine.trim() + '\n';
                return;
            }
            const prefix = (type: string) => c.props.name?.trim() || `${type}_${c.id}`;
            switch (c.type) {
                case 'R': nl += `${prefix('R')} ${nk(c.id, 'p')} ${nk(c.id, 'n')} ${c.props.value}\n`; break;
                case 'C': nl += `${prefix('C')} ${nk(c.id, 'p')} ${nk(c.id, 'n')} ${c.props.value}\n`; break;
                case 'L': nl += `${prefix('L')} ${nk(c.id, 'p')} ${nk(c.id, 'n')} ${c.props.value}\n`; break;
                case 'V': nl += `${prefix('V')} ${nk(c.id, 'p')} ${nk(c.id, 'n')} ${this.buildSpiceValue(c)}\n`; break;
                case 'IPROBE': nl += `${prefix('V')} ${nk(c.id, 'p')} ${nk(c.id, 'n')} 0\n`; break;

                // Diode
                case 'D': {
                    const model = c.props.model || 'DMOD';
                    nl += `${prefix('D')} ${nk(c.id, 'a')} ${nk(c.id, 'k')} ${model}\n`;
                    this.collectModelDirective(c, modelDirectives);
                    break;
                }
                // BJT (NPN / PNP) — Q name C B E model
                case 'Q_NPN':
                case 'Q_PNP': {
                    const model = c.props.model || (c.type === 'Q_NPN' ? 'NMOD' : 'PMOD');
                    nl += `${prefix('Q')} ${nk(c.id, 'c')} ${nk(c.id, 'b')} ${nk(c.id, 'e')} ${model}\n`;
                    this.collectModelDirective(c, modelDirectives);
                    break;
                }
                // MOSFET — M name D G S S model W=xx L=xx
                case 'M_NMOS':
                case 'M_PMOS': {
                    const model = c.props.model || (c.type === 'M_NMOS' ? 'NMOSMOD' : 'PMOSMOD');
                    const sNode = nk(c.id, 's');
                    const w = c.props.w || '10u';
                    const l = c.props.l || '1u';
                    nl += `${prefix('M')} ${nk(c.id, 'd')} ${nk(c.id, 'g')} ${sNode} ${sNode} ${model} W=${w} L=${l}\n`;
                    this.collectModelDirective(c, modelDirectives);
                    break;
                }
                // Op-Amp (subcircuit) — X name inp inn out vp vn modelname
                case 'OPAMP': {
                    const model = c.props.model || 'OPAMP_IDEAL';
                    nl += `${prefix('X')} ${nk(c.id, 'inp')} ${nk(c.id, 'inn')} ${nk(c.id, 'out')} ${nk(c.id, 'vp')} ${nk(c.id, 'vn')} ${model}\n`;
                    this.collectModelDirective(c, modelDirectives);
                    break;
                }
                // Ideal 3-pin Op-Amp (subcircuit, no supply) — X name inp inn out modelname
                case 'OPAMP3': {
                    const model = c.props.model || 'OPAMP3_IDEAL';
                    nl += `${prefix('X')} ${nk(c.id, 'inp')} ${nk(c.id, 'inn')} ${nk(c.id, 'out')} ${model}\n`;
                    this.collectModelDirective(c, modelDirectives);
                    break;
                }
            }
        });

        // Add model/subcircuit directives
        if (modelDirectives.size > 0) {
            nl += '\n* Model definitions\n';
            modelDirectives.forEach(d => nl += d + '\n');
        }

        // Custom directives (if any)
        const cfg = this.simConfig();
        if (cfg.customDirectives.trim()) {
            nl += cfg.customDirectives.trim() + '\n';
        }

        // Analysis directive from config
        nl += this.buildAnalysisDirective() + '\n';
        nl += '.end\n';
        return nl;
    }

    /** Build the SPICE analysis directive string from current sim config. */
    buildAnalysisDirective(): string {
        const cfg = this.simConfig();
        switch (cfg.type) {
            case 'tran': {
                const t = cfg.tran;
                let cmd = `.tran ${t.step} ${t.stopTime}`;
                if (t.startSave && t.startSave !== '0') cmd += ` ${t.startSave}`;
                if (t.uic) cmd += ' uic';
                return cmd;
            }
            case 'ac': {
                const a = cfg.ac;
                return `.ac ${a.variation} ${a.npoints} ${a.fstart} ${a.fstop}`;
            }
            case 'dc': {
                const d = cfg.dc;
                return `.dc ${d.source} ${d.start} ${d.stop} ${d.step}`;
            }
            case 'op':
                return '.op';
        }
    }

    /** Update simulation config (partial merge). */
    updateSimConfig(partial: Partial<SimConfig>): void {
        this.simConfig.set({ ...this.simConfig(), ...partial });
    }

    // ── Circuit Validation ────────────────────────────────────────

    validateCircuit(): NetlistError[] {
        const errors: NetlistError[] = [];
        const components = this.components();
        const nodeMap = this.nodeMap();
        let errIdx = 0;

        // No ground
        if (!components.some(c => c.type === 'GND')) {
            errors.push({
                id: `val_${errIdx++}`,
                severity: 'error',
                message: 'No ground (GND) in circuit',
                detail: 'Every circuit needs at least one ground node as reference.',
            });
        }

        // No source
        if (!components.some(c => c.type === 'V')) {
            errors.push({
                id: `val_${errIdx++}`,
                severity: 'warning',
                message: 'No voltage source in circuit',
            });
        }

        // Disconnected pins
        for (const c of components) {
            if (c.type === 'GND') continue;
            for (const p of this.getAbsPorts(c)) {
                const node = nodeMap.get(`${c.id}.${p.key}`);
                if (!node || node === '?') {
                    errors.push({
                        id: `val_${errIdx++}`,
                        severity: 'error',
                        message: `${c.id}: pin "${p.key}" is not connected`,
                        componentId: c.id,
                    });
                }
            }
        }

        // No probes connected
        const hasVoltageProbe = components.some(c =>
            c.type === 'PROBE' && nodeMap.get(`${c.id}.tip`) && nodeMap.get(`${c.id}.tip`) !== '?'
        );
        const hasCurrentProbe = components.some(c =>
            c.type === 'IPROBE' && nodeMap.get(`${c.id}.p`) && nodeMap.get(`${c.id}.p`) !== '?'
        );
        if (!hasVoltageProbe && !hasCurrentProbe) {
            errors.push({
                id: `val_${errIdx++}`,
                severity: 'warning',
                message: 'No probes connected — add probes to measure signals',
            });
        }

        // Check netlist for '?' nodes
        const netlist = this.genNetlist();
        const lines = netlist.split('\n');
        lines.forEach((line, idx) => {
            if (line.includes('?') && !line.startsWith('*')) {
                errors.push({
                    id: `val_nl_${errIdx++}`,
                    severity: 'error',
                    message: `Netlist line ${idx + 1}: unresolved node`,
                    line: idx + 1,
                    detail: line.trim(),
                });
            }
        });

        return errors;
    }

    // ── Helper: Cutoff frequency ─────────────────────────────────

    computeFc(): string | null {
        const components = this.components();
        const Rs = components.filter(c => c.type === 'R');
        const Cs = components.filter(c => c.type === 'C');
        if (!Rs.length || !Cs.length) return null;
        const R = this.parseSpiceVal(Rs[0].props.value || '0');
        const C = this.parseSpiceVal(Cs[0].props.value || '0');
        if (!R || !C) return null;
        const fc = 1 / (2 * Math.PI * R * C);
        return fc >= 1000 ? (fc / 1000).toFixed(2) + ' kHz' : fc.toFixed(1) + ' Hz';
    }

    // ── Geometry helpers ─────────────────────────────────────────

    /** Ensure all segments in the polyline are axis-aligned by inserting bends. */
    private ensureOrthogonal(pts: Point[]): Point[] {
        if (pts.length < 2) return pts;
        const result: Point[] = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
            const prev = result[result.length - 1];
            const cur = pts[i];
            if (prev.x !== cur.x && prev.y !== cur.y) {
                result.push({ x: cur.x, y: prev.y });
            }
            result.push(cur);
        }
        return this.simplify(result);
    }

    /**
     * Full cleanup pass — single-pass pipeline on a local array.
     * Only ONE this.wires.set() at the very end.
     *
     *  1. Flatten polylines / diagonals into 2-point H/V segments
     *  2. Snap to grid
     *  3. Remove zero-length
     *  4. Remove exact duplicates
     *  5. Split overlapping collinear segments
     *  6. Remove exact duplicates again (splits may recreate)
     *  6b. Split at T-junctions (endpoint on interior of another segment)
     *  7. (deep only) Remove orphan segments
     *  8. Consolidate collinear at non-junctions
     *  9. Final dedup safety net
     */
    cleanupWires(deep = false): void {
        let ws = this.flattenArray(this.wires());
        ws = this.snapArray(ws);
        ws = this.removeZeroLength(ws);
        ws = this.dedup(ws);
        ws = this.splitOverlappingSegments(ws);
        ws = this.dedup(ws);
        ws = this.splitAtTJunctions(ws);
        ws = this.dedup(ws);

        if (deep) {
            // Remove segments where BOTH endpoints are isolated
            const pinSet = new Set<string>();
            for (const c of this.components()) {
                for (const p of this.getAbsPorts(c)) {
                    pinSet.add(this.gk(p.x, p.y));
                }
            }
            const epCount = new Map<string, number>();
            for (const w of ws) {
                for (const p of w.points) {
                    const k = this.gk(p.x, p.y);
                    epCount.set(k, (epCount.get(k) ?? 0) + 1);
                }
            }
            ws = ws.filter(w => {
                const k0 = this.gk(w.points[0].x, w.points[0].y);
                const k1 = this.gk(w.points[1].x, w.points[1].y);
                const c0 = pinSet.has(k0) || (epCount.get(k0) ?? 0) > 1;
                const c1 = pinSet.has(k1) || (epCount.get(k1) ?? 0) > 1;
                return c0 || c1;
            });
        }

        ws = this.consolidateArray(ws);
        ws = this.dedup(ws);               // final safety net
        ws = this.removeZeroLength(ws);     // final safety net

        this.wires.set(ws);
    }

    /**
     * Deep cleanup: standard cleanup + BFS to remove wire sub-graphs
     * not reachable from any component pin.
     */
    deepCleanupWires(): void {
        const oldWires = this.snapshotWires();

        const prev = this._inCleanup;
        this._inCleanup = true;
        try {
            this.cleanupWires(true);

            let ws = this.wires();
            if (ws.length === 0) return;

            const pinKeys = new Set<string>();
            for (const c of this.components()) {
                for (const p of this.getAbsPorts(c)) {
                    pinKeys.add(this.gk(p.x, p.y));
                }
            }

            const epToWires = new Map<string, number[]>();
            for (let i = 0; i < ws.length; i++) {
                for (const p of ws[i].points) {
                    const k = this.gk(p.x, p.y);
                    let list = epToWires.get(k);
                    if (!list) { list = []; epToWires.set(k, list); }
                    list.push(i);
                }
            }

            const visited = new Array<boolean>(ws.length).fill(false);
            const keep = new Set<number>();

            for (let start = 0; start < ws.length; start++) {
                if (visited[start]) continue;
                const queue = [start];
                const group: number[] = [];
                let touchesPin = false;

                while (queue.length > 0) {
                    const idx = queue.pop()!;
                    if (visited[idx]) continue;
                    visited[idx] = true;
                    group.push(idx);

                    for (const p of ws[idx].points) {
                        const k = this.gk(p.x, p.y);
                        if (pinKeys.has(k)) touchesPin = true;
                        for (const nb of (epToWires.get(k) ?? [])) {
                            if (!visited[nb]) queue.push(nb);
                        }
                    }
                }

                if (touchesPin) {
                    for (const idx of group) keep.add(idx);
                }
            }

            const cleaned = ws.filter((_, i) => keep.has(i));
            this.wires.set(cleaned);

            const newWires = this.snapshotWires();
            this.undoRedo.addToHistory({
                undo: () => this.wires.set(oldWires),
                redo: () => this.wires.set(newWires),
                description: 'Deep cleanup wires',
            });
        } finally {
            this._inCleanup = prev;
        }
    }

    /** Called after every wire mutation — always runs full cleanup. */
    private afterWireMutation(): void {
        if (this._inCleanup) return;
        this._inCleanup = true;
        try {
            this.cleanupWires();
        } finally {
            this._inCleanup = false;
        }
    }

    /**
     * Split wires at T-junctions: if any wire endpoint (or component
     * pin) lies on the interior of another wire segment, split that
     * segment at that point.  This guarantees a proper vertex exists
     * at every T-junction so junctions are computed correctly and
     * consolidation won't merge the halves back (≥ 3 connections).
     */
    private splitAtTJunctions(ws: Wire[]): Wire[] {
        let changed = true;
        while (changed) {
            changed = false;
            // Collect all wire endpoints
            const endpoints = new Set<string>();
            for (const w of ws) {
                for (const p of w.points) endpoints.add(this.gk(p.x, p.y));
            }
            // Include component pin positions
            for (const c of this.components()) {
                for (const p of this.getAbsPorts(c)) endpoints.add(this.gk(p.x, p.y));
            }

            for (let wi = 0; wi < ws.length && !changed; wi++) {
                const w = ws[wi];
                if (w.points.length !== 2) continue;
                const a = w.points[0], b = w.points[1];
                const ka = this.gk(a.x, a.y), kb = this.gk(b.x, b.y);

                for (const epk of endpoints) {
                    if (epk === ka || epk === kb) continue;  // skip own endpoints
                    const [ex, ey] = epk.split(',').map(Number);
                    const ep = { x: ex, y: ey };
                    if (this.pointOnSegment(ep, a, b)) {
                        // Split this wire at the T-junction point
                        const w1: Wire = {
                            id: 'w' + Date.now() + '_tj' + wi + 'a',
                            points: [{ ...a }, { ...ep }],
                        };
                        const w2: Wire = {
                            id: 'w' + Date.now() + '_tj' + wi + 'b',
                            points: [{ ...ep }, { ...b }],
                        };
                        ws.splice(wi, 1, w1, w2);
                        changed = true;
                        break;
                    }
                }
            }
        }
        return ws;
    }

    /**
     * Split overlapping collinear 2-point segments.
     * Two H (or V) segments that share the same axis line and whose
     * projections overlap are broken down so no two visually stack.
     */
    private splitOverlappingSegments(ws: Wire[]): Wire[] {
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < ws.length && !changed; i++) {
                for (let j = i + 1; j < ws.length && !changed; j++) {
                    const a = ws[i], b = ws[j];
                    if (a.points.length !== 2 || b.points.length !== 2) continue;
                    const result = this.trySplitOverlap(a, b);
                    if (result) {
                        ws.splice(j, 1);
                        ws.splice(i, 1);
                        ws.push(...result);
                        changed = true;
                    }
                }
            }
        }
        return ws;
    }

    /**
     * If two 2-point segments overlap on the same axis, return the
     * non-overlapping replacement segments; otherwise null.
     */
    private trySplitOverlap(a: Wire, b: Wire): Wire[] | null {
        const a0 = a.points[0], a1 = a.points[1];
        const b0 = b.points[0], b1 = b.points[1];

        // Both horizontal on same Y?
        const bothH = a0.y === a1.y && b0.y === b1.y && a0.y === b0.y;
        // Both vertical on same X?
        const bothV = a0.x === a1.x && b0.x === b1.x && a0.x === b0.x;
        if (!bothH && !bothV) return null;

        // Project to the shared axis
        let aMin: number, aMax: number, bMin: number, bMax: number;
        const fixed = bothH ? a0.y : a0.x; // shared coordinate
        if (bothH) {
            aMin = Math.min(a0.x, a1.x); aMax = Math.max(a0.x, a1.x);
            bMin = Math.min(b0.x, b1.x); bMax = Math.max(b0.x, b1.x);
        } else {
            aMin = Math.min(a0.y, a1.y); aMax = Math.max(a0.y, a1.y);
            bMin = Math.min(b0.y, b1.y); bMax = Math.max(b0.y, b1.y);
        }

        // Check overlap (not just touching)
        if (aMax <= bMin || bMax <= aMin) return null;

        // Union of all unique coordinates
        const coords = Array.from(new Set([aMin, aMax, bMin, bMax])).sort((x, y) => x - y);

        // Build replacement segments
        const result: Wire[] = [];
        for (let k = 0; k < coords.length - 1; k++) {
            const lo = coords[k], hi = coords[k + 1];
            if (lo === hi) continue;
            const pts: Point[] = bothH
                ? [{ x: lo, y: fixed }, { x: hi, y: fixed }]
                : [{ x: fixed, y: lo }, { x: fixed, y: hi }];
            result.push({ id: 'w' + Date.now() + '_' + k + '_' + Math.random().toString(36).slice(2, 6), points: pts });
        }

        return result.length > 0 ? result : null;
    }

    /**
     * Public consolidation: read signal, consolidate, write back.
     * Used only by loadDefaultCircuit; everything else uses the
     * array-based pipeline inside cleanupWires.
     */
    consolidateWires(): void {
        this.wires.set(this.dedup(this.consolidateArray(this.wires().slice())));
    }

    /**
     * Merge two wires only if:
     *  - they are collinear and share an endpoint
     *  - the shared endpoint has exactly 2 connections (no T-junction)
     */
    private tryMergeIfSafe(
        a: Wire, b: Wire,
        endpointCount: Map<string, number>
    ): Wire | null {
        const aFirst = a.points[0], aLast = a.points[a.points.length - 1];
        const bFirst = b.points[0], bLast = b.points[b.points.length - 1];

        const candidates: { shared: Point; left: Point[]; right: Point[] }[] = [];

        if (aLast.x === bFirst.x && aLast.y === bFirst.y)
            candidates.push({ shared: aLast, left: a.points, right: b.points });
        if (aLast.x === bLast.x && aLast.y === bLast.y)
            candidates.push({ shared: aLast, left: a.points, right: [...b.points].reverse() });
        if (aFirst.x === bFirst.x && aFirst.y === bFirst.y)
            candidates.push({ shared: aFirst, left: [...a.points].reverse(), right: b.points });
        if (aFirst.x === bLast.x && aFirst.y === bLast.y)
            candidates.push({ shared: aFirst, left: b.points, right: a.points });

        for (const { shared, left, right } of candidates) {
            // Only merge if the shared point has exactly 2 connections (just these two wires)
            const k = this.gk(shared.x, shared.y);
            if ((endpointCount.get(k) ?? 0) > 2) continue;

            const combined = [...left, ...right.slice(1)];
            const simplified = this.simplify(combined);
            if (simplified.length < combined.length) {
                return { id: a.id, points: simplified };
            }
        }

        return null;
    }

    /** Remove collinear intermediate points from a polyline. */
    private simplify(pts: Point[]): Point[] {
        if (pts.length <= 2) return pts;
        const out: Point[] = [pts[0]];
        for (let i = 1; i < pts.length - 1; i++) {
            const prev = out[out.length - 1];
            const cur = pts[i];
            const nxt = pts[i + 1];
            const sameX = prev.x === cur.x && cur.x === nxt.x;
            const sameY = prev.y === cur.y && cur.y === nxt.y;
            if (!sameX && !sameY) out.push(cur);
        }
        out.push(pts[pts.length - 1]);
        return out;
    }

    /** Is point P on the axis-aligned segment A→B? */
    private pointOnSegment(p: Point, a: Point, b: Point): boolean {
        if (a.x === b.x && p.x === a.x) {
            return p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
        }
        if (a.y === b.y && p.y === a.y) {
            return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
        }
        return false;
    }

    /** Closest point on segment A→B from point P. */
    private closestPointOnSeg(px: number, py: number, a: Point, b: Point): Point {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return { x: a.x, y: a.y };
        let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * dx, y: a.y + t * dy };
    }

    // ── Project load ────────────────────────────────────────────

    /** Replace the entire circuit state from a project file. */
    loadProject(
        components: import('../models/circuit.model').CircuitComponent[],
        wires: import('../models/circuit.model').Wire[],
        simConfig: import('../models/circuit.model').SimConfig,
    ): void {
        this.undoRedo.clear();
        // Reset idCounter to avoid collisions
        let maxId = 0;
        for (const c of components) {
            const n = parseInt(c.id.replace(/\D/g, ''), 10);
            if (n > maxId) maxId = n;
        }
        for (const w of wires) {
            const n = parseInt(w.id.replace(/\D/g, ''), 10);
            if (n > maxId) maxId = n;
        }
        this.idCounter = maxId + 1;

        this.components.set(components);
        this.wires.set(wires);
        this.simConfig.set(simConfig);
    }

    // ── Default circuit ──────────────────────────────────────────

    loadDefaultCircuit(): void {
        this.idCounter = 1;
        this.undoRedo.clear(); // Clear undo/redo history when loading default circuit

        // Positions chosen so that pin endpoints align on the grid
        // with minimal L-shapes (pins are ±40 for R/C/V, ±20 for GND/PROBE):
        //   V1 @(140,200)  → p=(140,160), n=(140,240)
        //   R1 @(260,160)  → p=(220,160), n=(300,160)   — p aligns H with V1.p
        //   C1 @(380,240)  → p=(380,200), n=(380,280)
        //   G1 @(140,280)  → g=(140,260)                — aligns V with V1.n
        //   G2 @(380,320)  → g=(380,300)                — aligns V with C1.n
        //   PA @(140,120)  → tip=(140,140)               — aligns V with V1.p
        //   PB @(380,120)  → tip=(380,140)               — aligns V with C1.p
        const v1 = this.makeComp('V', 140, 200);
        v1.props.waveform = 'SIN'; v1.props.amp = '5'; v1.props.freq = '1000';
        const r1 = this.makeComp('R', 260, 160);
        const c1 = this.makeComp('C', 380, 240);
        const g1 = this.makeComp('GND', 140, 280);
        const g2 = this.makeComp('GND', 380, 320);
        const pA = this.makeComp('PROBE', 140, 120); pA.props.label = 'IN';
        const pB = this.makeComp('PROBE', 380, 120); pB.props.label = 'OUT';

        this.components.set([v1, r1, c1, g1, g2, pA, pB]);

        // Helper: route a wire between two component ports
        const wire = (
            from: CircuitComponent, fp: string,
            to: CircuitComponent, tp: string,
        ): Wire => {
            const a = this.getAbsPorts(from).find(p => p.key === fp)!;
            const b = this.getAbsPorts(to).find(p => p.key === tp)!;
            const d1 = this.getPortDirection(from, fp);
            const d2 = this.getPortDirection(to, tp);
            return {
                id: 'w' + this.idCounter++,
                points: this.routeSmart(
                    { x: a.x, y: a.y },
                    { x: b.x, y: b.y },
                    d1, d2,
                ),
            };
        };

        const rawWires = [
            wire(v1, 'p', r1, 'p'),
            wire(r1, 'n', c1, 'p'),
            wire(v1, 'n', g1, 'g'),
            wire(c1, 'n', g2, 'g'),
            wire(pA, 'tip', v1, 'p'),
            wire(pB, 'tip', c1, 'p'),
        ];
        // Decompose all initial wires into straight segments
        const segments: Wire[] = [];
        for (const w of rawWires) {
            segments.push(...this.decomposeToSegments(w.points, w.id));
        }
        this.wires.set(segments);
        this.cleanupWires();
    }

    // ── Parse multi-column wrdata output ─────────────────────────

    parseMultiCol(text: string, n: number): MultiColData {
        const x: number[] = [];
        const cols: number[][] = Array.from({ length: n }, () => []);
        text.trim().split('\n').forEach(line => {
            if (!line.trim() || line.startsWith('#')) return;
            const p = line.trim().split(/\s+/);
            if (p.length >= 2 * n) {
                x.push(parseFloat(p[0]));
                for (let i = 0; i < n; i++) cols[i].push(parseFloat(p[1 + i * 2]));
            }
        });
        return { x, cols };
    }
}
