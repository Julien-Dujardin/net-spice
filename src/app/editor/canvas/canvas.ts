import {
    Component, ElementRef, ViewChild, AfterViewInit,
    OnDestroy, NgZone, effect, output,
} from '@angular/core';
import { CircuitService } from '../services/circuit.service';
import { EditorStateService } from '../services/editor-state.service';
import { ControlsHelp } from '../controls-help/controls-help';
import {
    CircuitComponent, Wire, ComponentType, Point,
    TYPE_COLOR, PROBE_COLORS, GRID,
} from '../models/circuit.model';
import { getGenericDef } from '../models/component-library';

declare const Konva: any;

// ═══════════════════════════════════════════════════════════════════
//  Canvas – LTspice-style wire drawing
//
//  Wire interaction:
//    • Press W or click Wire button → enter wire mode
//    • Click to place the start point (snaps to pin/vertex/grid)
//    • Mouse-move shows a ghost L-shaped path
//    • Click again: if on a snap-target (pin, wire vertex, wire
//      segment) → finalize wire and stay in wire mode; otherwise →
//      place a bend and continue the current segment chain
//    • Right-click / Escape → cancel current segment
//    • Tab → toggle bend direction (H-first ↔ V-first)
//
//  Connection model:
//    • Two things at the same grid point are electrically connected
//    • Junction dots are drawn where ≥ 3 segment-endpoints meet
// ═══════════════════════════════════════════════════════════════════

@Component({
    selector: 'app-editor-canvas',
    standalone: true,
    imports: [ControlsHelp],
    templateUrl: './canvas.html',
    styleUrl: './canvas.css',
})
export class EditorCanvas implements AfterViewInit, OnDestroy {
    @ViewChild('konvaMount', { static: true }) konvaMountRef!: ElementRef<HTMLDivElement>;
    @ViewChild('canvasWrap', { static: true }) canvasWrapRef!: ElementRef<HTMLDivElement>;

    readonly resetViewRequested = output<void>();

    private stage: any;
    private compLayer: any;
    private wireLayer: any;
    private ghostLayer: any;
    private overlayLayer: any;               // box-select rectangle
    private resizeObserver!: ResizeObserver;
    private keyHandler!: (e: KeyboardEvent) => void;

    // Pan state
    private isPanning = false;
    private panStart = { x: 0, y: 0 };
    private panOrigin = { x: 0, y: 0 };

    // Box-select state
    private isBoxSelecting = false;
    private boxAnchor: Point = { x: 0, y: 0 };     // world coords
    private selectionRect: any = null;               // Konva.Rect

    // Multi-drag state
    private isMultiDragging = false;
    private multiDragStart: Point = { x: 0, y: 0 }; // world coords at drag start
    private multiDragLast: Point = { x: 0, y: 0 };  // last snapped pos

    constructor(
        private circuit: CircuitService,
        protected state: EditorStateService,
        private ngZone: NgZone,
    ) {
        effect(() => {
            this.circuit.components();
            this.circuit.wires();
            this.circuit.junctionPoints();
            this.state.selectedId();
            this.state.selectedIds();
            this.state.wireMode();
            if (this.stage) {
                this.ngZone.runOutsideAngular(() => this.redrawAll());
            }
        });
    }

    ngAfterViewInit(): void {
        this.ngZone.runOutsideAngular(() => this.initKonva());
    }

    ngOnDestroy(): void {
        this.resizeObserver?.disconnect();
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
        this.stage?.destroy();
    }

    resetView(): void {
        this.stage.scale({ x: 1, y: 1 });
        this.stage.position({ x: 0, y: 0 });
        this.stage.batchDraw();
        this.state.setZoom(100);
        this.updateGrid();
    }

    // ── Konva Init ─────────────────────────────────────────────────

    private initKonva(): void {
        const el = this.konvaMountRef.nativeElement;
        const wrap = this.canvasWrapRef.nativeElement;
        const W = wrap.clientWidth;
        const H = wrap.clientHeight;

        this.stage = new Konva.Stage({ container: el, width: W, height: H });
        this.wireLayer = new Konva.Layer();
        this.compLayer = new Konva.Layer();
        this.ghostLayer = new Konva.Layer();
        this.overlayLayer = new Konva.Layer();
        this.stage.add(this.wireLayer, this.compLayer, this.ghostLayer, this.overlayLayer);

        this.stage.on('click', (e: any) => this.onStageClick(e));
        this.stage.on('dblclick', (e: any) => this.onStageDblClick(e));
        this.stage.on('mousemove', (e: any) => this.onStageMouseMove(e));

        // Pan / box-select / multi-drag (mousedown)
        this.stage.on('mousedown', (e: any) => {
            // Pan: middle-click or alt+left-click
            if (e.evt.button === 1 || (e.evt.button === 0 && e.evt.altKey)) {
                e.evt.preventDefault();
                this.isPanning = true;
                this.panStart = { x: e.evt.clientX, y: e.evt.clientY };
                this.panOrigin = { x: this.stage.x(), y: this.stage.y() };
                wrap.style.cursor = 'grabbing';
                return;
            }

            // Left-click on empty area in select mode → box selection or multi-drag
            if (e.evt.button === 0 && !this.state.wireMode() && !this.state.placeMode()) {
                const target = e.target;
                const isStageOrBackground = target === this.stage || target?.getClassName?.() === 'Stage';
                if (!isStageOrBackground) return;

                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);

                // If clicked inside the existing multi-selection bounding box → start multi-drag
                // Otherwise → start box selection
                this.isBoxSelecting = true;
                this.boxAnchor = { x: wPos.x, y: wPos.y };
                wrap.style.cursor = 'crosshair';
            }
        });

        // Mousemove: pan, box-select rect, multi-drag
        this.stage.on('mousemove', (e: any) => {
            if (this.isPanning) {
                const dx = e.evt.clientX - this.panStart.x;
                const dy = e.evt.clientY - this.panStart.y;
                this.stage.x(this.panOrigin.x + dx);
                this.stage.y(this.panOrigin.y + dy);
                this.stage.batchDraw();
                this.updateGrid();
                return;
            }

            if (this.isMultiDragging) {
                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);
                const sx = this.circuit.snap(wPos.x);
                const sy = this.circuit.snap(wPos.y);
                const dx = sx - this.multiDragLast.x;
                const dy = sy - this.multiDragLast.y;
                if (dx !== 0 || dy !== 0) {
                    this.multiDragLast = { x: sx, y: sy };
                    // Live preview: offset layers
                    this.drawMultiDragGhost(dx, dy);
                }
                return;
            }

            if (this.isBoxSelecting) {
                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);
                this.drawBoxSelectRect(this.boxAnchor, wPos);
                return;
            }
        });

        // Mouseup: finalize pan / box-select / multi-drag
        this.stage.on('mouseup', (e: any) => {
            if (this.isPanning) {
                this.isPanning = false;
                wrap.style.cursor = '';
                return;
            }

            if (this.isMultiDragging) {
                this.finalizeMultiDrag();
                wrap.style.cursor = '';
                return;
            }

            if (this.isBoxSelecting) {
                this.isBoxSelecting = false;
                wrap.style.cursor = '';
                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);
                this.finalizeBoxSelect(this.boxAnchor, wPos);
                this.overlayLayer.destroyChildren();
                this.overlayLayer.draw();
                return;
            }
        });

        // Zoom
        const ZOOM_MIN = 0.2, ZOOM_MAX = 4;
        el.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const oldScale = this.stage.scaleX();
            const pointer = this.stage.getPointerPosition();
            if (!pointer) return;

            const mousePointTo = {
                x: (pointer.x - this.stage.x()) / oldScale,
                y: (pointer.y - this.stage.y()) / oldScale,
            };

            const direction = e.deltaY > 0 ? -1 : 1;
            const factor = 1.08;
            let newScale = direction > 0 ? oldScale * factor : oldScale / factor;
            newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));

            this.stage.scale({ x: newScale, y: newScale });
            this.stage.x(pointer.x - mousePointTo.x * newScale);
            this.stage.y(pointer.y - mousePointTo.y * newScale);
            this.stage.batchDraw();
            this.updateGrid();

            this.ngZone.run(() => this.state.setZoom(newScale * 100));
        }, { passive: false });

        // Resize
        this.resizeObserver = new ResizeObserver(() => {
            this.stage.width(wrap.clientWidth);
            this.stage.height(wrap.clientHeight);
            this.updateGrid();
        });
        this.resizeObserver.observe(wrap);

        // Right-click cancel (works for wire mode AND place/add mode)
        wrap.addEventListener('contextmenu', (e: Event) => {
            e.preventDefault();
            this.ngZone.run(() => {
                if (this.state.wireDrawStart()) {
                    this.state.cancelCurrentSegment();
                } else if (this.state.placeMode()) {
                    // Exit add/place mode without placing a component
                    this.state.cancelPlace();
                } else {
                    this.state.cancelWire();
                }
            });
        });

        // Keyboard shortcuts
        this.keyHandler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

            // Delete / Backspace → delete selected items (single or multi)
            if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput) {
                const multi = this.state.selectedIds();
                if (multi.size > 0) {
                    e.preventDefault();
                    this.ngZone.run(() => {
                        const compIds = new Set<string>();
                        const wireIds = new Set<string>();
                        for (const id of multi) {
                            if (id.startsWith('w')) wireIds.add(id);
                            else compIds.add(id);
                        }
                        this.circuit.removeSelection(compIds, wireIds);
                        this.state.clearSelection();
                    });
                } else {
                    const selectedId = this.state.selectedId();
                    if (selectedId) {
                        e.preventDefault();
                        this.ngZone.run(() => {
                            if (selectedId.startsWith('w')) {
                                const wireExists = this.circuit.wires().some(w => w.id === selectedId);
                                if (wireExists) {
                                    this.circuit.removeWire(selectedId);
                                } else {
                                    const fallback = this.circuit.findWireByGeometry(
                                        this.state.selectedWirePoints() ?? []
                                    );
                                    if (fallback) this.circuit.removeWire(fallback);
                                }
                            } else {
                                this.circuit.removeComponent(selectedId);
                            }
                            this.state.selectComp(null);
                        });
                    }
                }
            }
            // Space → rotate selected component
            if (e.code === 'Space' && !e.repeat) {
                const selectedId = this.state.selectedId();
                if (selectedId && !selectedId.startsWith('w')) {
                    e.preventDefault();
                    this.ngZone.run(() => this.circuit.rotateComponent(selectedId));
                }
            }
            // W → toggle wire mode (physical key, works on AZERTY as Z)
            if (e.code === 'KeyW' && !e.repeat && !isInput && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.ngZone.run(() => this.state.toggleWireMode());
            }
            // Tab → toggle bend direction while drawing
            if (e.code === 'Tab' && this.state.wireMode()) {
                e.preventDefault();
                this.ngZone.run(() => this.state.toggleBendDirection());
            }
            // Escape → cancel current segment, exit mode, or clear selection
            if (e.code === 'Escape') {
                this.ngZone.run(() => {
                    if (this.state.wireDrawStart()) {
                        this.state.cancelCurrentSegment();
                    } else if (this.state.hasMultiSelection()) {
                        this.state.clearSelection();
                    }
                });
            }
        };
        window.addEventListener('keydown', this.keyHandler);

        this.updateGrid();
        this.redrawAll();
    }

    // ── Grid Sync ────────────────────────────────────────────────

    private updateGrid(): void {
        const wrap = this.canvasWrapRef.nativeElement;
        const scale = this.stage.scaleX();
        const gridSize = GRID * scale;
        const dotR = Math.max(0.8, Math.min(2, scale));
        wrap.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        wrap.style.backgroundPosition = `${this.stage.x()}px ${this.stage.y()}px`;
        wrap.style.backgroundImage = `radial-gradient(circle, #1a1a1a ${dotR}px, transparent ${dotR}px)`;
    }

    // ── Click / Mouse ────────────────────────────────────────────

    private onStageClick(e: any): void {
        if (e.cancelBubble) return;
        // Only react to left-click (button 0)
        if (e.evt.button !== 0) return;
        const pos = this.stage.getPointerPosition();

        // ─── Place mode ───
        const placeMode = this.state.placeMode();
        if (placeMode) {
            const wPos = this.screenToWorld(pos);
            const comp = this.circuit.makeComp(placeMode, wPos.x, wPos.y);
            this.ngZone.run(() => {
                this.circuit.addComponent(comp);
                this.state.selectComp(comp.id);
            });
            return;
        }

        // ─── Wire mode ───
        if (this.state.wireMode()) {
            const wPos = this.screenToWorld(pos);
            const drawStart = this.state.wireDrawStart();
            const snap = this.circuit.snapToTarget(wPos.x, wPos.y);

            if (drawStart) {
                const endPt = snap.point;
                if (endPt.x === drawStart.x && endPt.y === drawStart.y) return;

                const hFirst = this.state.wireHFirst();
                const wirePts = this.circuit.routeL(drawStart, endPt, hFirst);

                this.ngZone.run(() => {
                    if (snap.type === 'segment') {
                        this.circuit.splitWireAt(snap.detail.wireId, endPt);
                    }
                    this.circuit.addWire({ id: 'w' + Date.now(), points: wirePts });

                    if (snap.type === 'pin' || snap.type === 'vertex' || snap.type === 'segment') {
                        this.state.wireDrawStart.set(null);
                    } else {
                        this.state.wireDrawStart.set(endPt);
                    }
                    this.ghostLayer.destroyChildren();
                    this.ghostLayer.draw();
                });
            } else {
                this.ngZone.run(() => {
                    this.state.wireDrawStart.set(snap.point);
                });
            }
            return;
        }

        // ─── Select mode — click empty → deselect ───
        this.ngZone.run(() => this.state.clearSelection());
    }

    /** Double-click on stage — used for wire deletion in select mode */
    private onStageDblClick(e: any): void {
        // Wire dblclick is handled on the wire shape itself; this is a fallback
    }

    private onStageMouseMove(e: any): void {
        const pos = this.stage.getPointerPosition();
        this.ghostLayer.destroyChildren();

        // ─── Place ghost ───
        const placeMode = this.state.placeMode();
        if (placeMode) {
            const wPos = this.screenToWorld(pos);
            const ghost = this.circuit.makeComp(placeMode, wPos.x, wPos.y);
            this.drawCompOnLayer(ghost, this.ghostLayer, 0.4);
            this.ghostLayer.draw();
        }

        // ─── Wire ghost + guide lines ───
        const drawStart = this.state.wireDrawStart();
        if (this.state.wireMode() && drawStart) {
            const wPos = this.screenToWorld(pos);
            const snap = this.circuit.snapToTarget(wPos.x, wPos.y);
            const endPt = snap.point;
            const hFirst = this.state.wireHFirst();
            const routePts = this.circuit.routeL(drawStart, endPt, hFirst);

            // Full-canvas guide lines (horizontal + vertical through cursor)
            const visTL = this.screenToWorld({ x: 0, y: 0 });
            const visBR = this.screenToWorld({ x: this.stage.width(), y: this.stage.height() });

            // Vertical guide through cursor X
            this.ghostLayer.add(new Konva.Line({
                points: [endPt.x, visTL.y, endPt.x, visBR.y],
                stroke: '#FAFAFA', strokeWidth: 0.6, dash: [4, 8],
                opacity: 0.4, listening: false,
            }));
            // Horizontal guide through cursor Y
            this.ghostLayer.add(new Konva.Line({
                points: [visTL.x, endPt.y, visBR.x, endPt.y],
                stroke: '#FAFAFA', strokeWidth: 0.6, dash: [4, 8],
                opacity: 0.4, listening: false,
            }));

            // Also draw guides from the start point
            if (drawStart.x !== endPt.x || drawStart.y !== endPt.y) {
                this.ghostLayer.add(new Konva.Line({
                    points: [drawStart.x, visTL.y, drawStart.x, visBR.y],
                    stroke: '#FAFAFA', strokeWidth: 0.5, dash: [4, 8],
                    opacity: 0.12, listening: false,
                }));
                this.ghostLayer.add(new Konva.Line({
                    points: [visTL.x, drawStart.y, visBR.x, drawStart.y],
                    stroke: '#FAFAFA', strokeWidth: 0.5, dash: [4, 8],
                    opacity: 0.12, listening: false,
                }));
            }

            // Ghost wire
            const flat: number[] = [];
            routePts.forEach(p => flat.push(p.x, p.y));
            this.ghostLayer.add(new Konva.Line({
                points: flat,
                stroke: '#FAFAFA', strokeWidth: 1.5,
                dash: [5, 4], opacity: 0.8,
                lineCap: 'round', lineJoin: 'round',
            }));

            // Start dot
            this.ghostLayer.add(new Konva.Circle({
                x: drawStart.x, y: drawStart.y,
                radius: 5, fill: '#FAFAFA', opacity: 0.9,
            }));

            // End dot — colour varies by snap type
            const endR = snap.type !== 'grid' ? 7 : 3;
            const endCol =
                snap.type === 'pin' ? '#00e890' :
                    snap.type === 'vertex' ? '#ffb84f' :
                        snap.type === 'segment' ? '#ff6bb5' :
                            '#FAFAFA';
            this.ghostLayer.add(new Konva.Circle({
                x: endPt.x, y: endPt.y, radius: endR,
                fill: endCol, opacity: snap.type !== 'grid' ? 1 : 0.5,
            }));

            this.ghostLayer.draw();
        }
    }

    private screenToWorld(pos: { x: number; y: number }): { x: number; y: number } {
        return {
            x: (pos.x - this.stage.x()) / this.stage.scaleX(),
            y: (pos.y - this.stage.y()) / this.stage.scaleY(),
        };
    }

    // ── Drawing ──────────────────────────────────────────────────

    private redrawAll(): void {
        if (!this.wireLayer) return;
        this.wireLayer.destroyChildren();
        this.compLayer.destroyChildren();

        const wires = this.circuit.wires();
        const components = this.circuit.components();
        const junctions = this.circuit.junctionPoints();

        wires.forEach(w => this.drawWire(w));
        junctions.forEach(j => this.drawJunctionDot(j));
        components.forEach(c => this.drawCompOnLayer(c, this.compLayer, 1));

        this.wireLayer.draw();
        this.compLayer.draw();
    }

    // ── Component drawing ────────────────────────────────────────

    private drawCompOnLayer(comp: CircuitComponent, layer: any, opacity: number): void {
        const grp = new Konva.Group({ x: comp.x, y: comp.y, rotation: comp.rotation, opacity });
        const col = TYPE_COLOR[comp.type] || '#fff';
        const isSelected = this.state.isSelected(comp.id);
        const isWire = this.state.wireMode();

        // Invisible bounding-box hit area for easy selection
        const bounds = this.getComponentBounds(comp.type);
        grp.add(new Konva.Rect({
            x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h,
            fill: '#000', opacity: 0,
        }));

        switch (comp.type) {
            case 'R': this.drawResistor(grp, comp, col, isSelected); break;
            case 'C': this.drawCapacitor(grp, comp, col, isSelected); break;
            case 'L': this.drawInductor(grp, comp, col, isSelected); break;
            case 'V': this.drawVSource(grp, comp, col, isSelected); break;
            case 'GND': this.drawGnd(grp, comp, col, isSelected); break;
            case 'PROBE': this.drawProbeSymbol(grp, comp, isSelected); break;
            case 'IPROBE': this.drawCurrentProbeSymbol(grp, comp, isSelected); break;
            case 'D': this.drawDiode(grp, comp, col, isSelected); break;
            case 'Q_NPN': this.drawNPN(grp, comp, col, isSelected); break;
            case 'Q_PNP': this.drawPNP(grp, comp, col, isSelected); break;
            case 'M_NMOS': this.drawNMOS(grp, comp, col, isSelected); break;
            case 'M_PMOS': this.drawPMOS(grp, comp, col, isSelected); break;
            case 'OPAMP': this.drawOpAmp(grp, comp, col, isSelected); break;
            case 'OPAMP3': this.drawOpAmp3(grp, comp, col, isSelected); break;
            case 'NET_IN': this.drawNetIn(grp, comp, col, isSelected); break;
            case 'NET_OUT': this.drawNetOut(grp, comp, col, isSelected); break;
            case 'NET_INOUT': this.drawNetInOut(grp, comp, col, isSelected); break;
        }

        // ── Smart label placement ─────────────────────────────────
        const noSmartLabel = new Set(['GND', 'NET_IN', 'NET_OUT', 'NET_INOUT']);
        if (opacity === 1 && !noSmartLabel.has(comp.type)) {
            this.drawSmartLabel(grp, comp, col);
        }

        // Port dots
        if (opacity === 1) {
            this.circuit.getRelPorts(comp.type).forEach(p => {
                const r = isWire ? 7 : 4;
                const dot = new Konva.Circle({
                    x: p.rx, y: p.ry, radius: r,
                    fill: isWire ? 'rgba(0,200,240,0.25)' : (isSelected ? '#fff' : '#1e3a50'),
                    stroke: col, strokeWidth: isWire ? 2 : 1.5,
                });

                dot.on('mouseenter', () => {
                    dot.fill(col);
                    dot.radius(isWire ? 9 : 5);
                    this.compLayer.draw();
                    const sPos = this.stage.getPointerPosition();
                    this.ngZone.run(() => this.state.showTooltip(
                        comp.id + '.' + p.key + (isWire ? ' — click to connect' : ''),
                        sPos.x, sPos.y
                    ));
                });
                dot.on('mouseleave', () => {
                    dot.fill(isWire ? 'rgba(0,200,240,0.25)' : (isSelected ? '#fff' : '#1e3a50'));
                    dot.radius(r);
                    this.compLayer.draw();
                    this.ngZone.run(() => this.state.hideTooltip());
                });

                // In wire mode, clicking a port dot starts / finishes a wire
                dot.on('click', (ev: any) => {
                    ev.cancelBubble = true;
                    if (!isWire) {
                        this.ngZone.run(() => this.state.selectComp(comp.id));
                        return;
                    }

                    const absPort = this.circuit.getAbsPorts(comp).find(ap => ap.key === p.key);
                    if (!absPort) return;
                    const pinPt: Point = { x: absPort.x, y: absPort.y };
                    const drawStart = this.state.wireDrawStart();

                    this.ngZone.run(() => {
                        if (!drawStart) {
                            // Start wire from this pin
                            this.state.wireDrawStart.set(pinPt);
                        } else {
                            // Finish wire at this pin
                            if (drawStart.x !== pinPt.x || drawStart.y !== pinPt.y) {
                                const hFirst = this.state.wireHFirst();
                                this.circuit.addWire({
                                    id: 'w' + Date.now(),
                                    points: this.circuit.routeL(drawStart, pinPt, hFirst),
                                });
                            }
                            this.state.wireDrawStart.set(null);
                            this.ghostLayer.destroyChildren();
                            this.ghostLayer.draw();
                        }
                    });
                });

                grp.add(dot);
            });

            // Drag (only in select mode)
            const isInMulti = this.state.selectedIds().has(comp.id);
            grp.draggable(!isWire && !isInMulti);

            let dragStartPos = { x: comp.x, y: comp.y };

            grp.on('dragstart', () => {
                dragStartPos = { x: grp.x(), y: grp.y() };
            });

            grp.on('dragmove', () => {
                grp.x(this.circuit.snap(grp.x()));
                grp.y(this.circuit.snap(grp.y()));
            });

            grp.on('dragend', () => {
                const finalX = this.circuit.snap(grp.x());
                const finalY = this.circuit.snap(grp.y());
                if (finalX !== dragStartPos.x || finalY !== dragStartPos.y) {
                    this.ngZone.run(() => {
                        this.circuit.moveComponent(comp.id, finalX, finalY);
                    });
                }
            });

            // Multi-drag: mousedown on a multi-selected component → start group drag
            if (isInMulti) {
                grp.on('mousedown', (ev: any) => {
                    if (ev.evt.button !== 0 || isWire) return;
                    ev.cancelBubble = true;
                    const pos = this.stage.getPointerPosition();
                    const wPos = this.screenToWorld(pos);
                    const sx = this.circuit.snap(wPos.x);
                    const sy = this.circuit.snap(wPos.y);
                    this.isMultiDragging = true;
                    this.multiDragStart = { x: sx, y: sy };
                    this.multiDragLast = { x: sx, y: sy };
                });
            }

            grp.on('click', (ev: any) => {
                if (isWire) return;
                ev.cancelBubble = true;
                this.ngZone.run(() => this.state.selectComp(comp.id));
            });
        }

        layer.add(grp);
    }

    // ── Component Symbols ────────────────────────────────────────

    /** Get bounding box for hit detection per component type. */
    private getComponentBounds(type: ComponentType): { x: number; y: number; w: number; h: number } {
        switch (type) {
            case 'R': return { x: -44, y: -14, w: 88, h: 28 };
            case 'C': return { x: -20, y: -44, w: 40, h: 88 };
            case 'L': return { x: -44, y: -14, w: 88, h: 28 };
            case 'V': return { x: -24, y: -44, w: 48, h: 88 };
            case 'GND': return { x: -14, y: -24, w: 28, h: 38 };
            case 'PROBE': return { x: -16, y: -20, w: 32, h: 44 };
            case 'IPROBE': return { x: -44, y: -18, w: 88, h: 36 };
            case 'NET_IN': return { x: -44, y: -12, w: 68, h: 24 };
            case 'NET_OUT': return { x: -24, y: -12, w: 68, h: 24 };
            case 'NET_INOUT': return { x: -44, y: -12, w: 68, h: 24 };
            default: {
                // Look up library component bounds
                const def = getGenericDef(type);
                if (def) return def.bounds;
                return { x: -20, y: -20, w: 40, h: 40 };
            }
        }
    }

    private drawResistor(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        grp.add(new Konva.Line({ points: [-40, 0, -16, 0], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [16, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Rect({
            x: -16, y: -8, width: 32, height: 16, stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(255,140,0,.18)' : 'rgba(255,140,0,.05)', cornerRadius: 2,
        }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -14, width: 88, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawCapacitor(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        grp.add(new Konva.Line({ points: [0, -40, 0, -8], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [0, 8, 0, 40], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [-14, -8, 14, -8], stroke: col, strokeWidth: 3 }));
        grp.add(new Konva.Line({ points: [-14, 8, 14, 8], stroke: col, strokeWidth: 3 }));
        if (sel) grp.add(new Konva.Rect({ x: -20, y: -44, width: 40, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawInductor(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        grp.add(new Konva.Line({ points: [-40, 0, -22, 0], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [22, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        for (let i = 0; i < 4; i++) {
            grp.add(new Konva.Arc({
                x: -13 + i * 9, y: 0, innerRadius: 0, outerRadius: 8,
                angle: 180, rotation: -180, stroke: col, strokeWidth: 2, fill: 'transparent',
            }));
        }
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -14, width: 88, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawVSource(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        grp.add(new Konva.Line({ points: [0, -40, 0, -18], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [0, 18, 0, 40], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Circle({
            x: 0, y: 0, radius: 18, stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(179,136,255,.15)' : 'rgba(179,136,255,.04)',
        }));
        grp.add(new Konva.Text({ x: -4, y: -11, text: '+', fontSize: 12, fill: col, fontFamily: 'Space Mono' }));
        grp.add(new Konva.Text({ x: -3, y: 1, text: '\u2212', fontSize: 12, fill: col, fontFamily: 'Space Mono' }));
        if (sel) grp.add(new Konva.Rect({ x: -24, y: -44, width: 48, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawGnd(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        grp.add(new Konva.Line({ points: [0, -20, 0, 0], stroke: col, strokeWidth: 2 }));
        [[18, 0], [12, 5], [6, 10]].forEach(([w, y]) => {
            grp.add(new Konva.Line({ points: [-w / 2, y, w / 2, y], stroke: col, strokeWidth: 2 }));
        });
        if (sel) grp.add(new Konva.Rect({ x: -14, y: -24, width: 28, height: 40, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    // ── NET labels (IN / OUT / INOUT) ────────────────────────────

    /**
     * NET_IN:  pin on the left, arrow pointing right (into the circuit).
     * Shape: wire─┤ rect with pointed right edge ▷
     */
    private drawNetIn(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Wire from pin to body
        grp.add(new Konva.Line({ points: [-40, 0, -24, 0], stroke: col, strokeWidth: 2 }));
        // Body: rectangle with arrow on right
        grp.add(new Konva.Line({
            points: [-24, -10, 14, -10, 22, 0, 14, 10, -24, 10], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(77,208,225,0.18)' : 'rgba(77,208,225,0.05)',
        }));
        // Arrow inside pointing right
        grp.add(new Konva.Line({
            points: [4, -5, 12, 0, 4, 5], stroke: col, strokeWidth: 1.8,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Label text above body
        const label = comp.props.label || '';
        if (label) {
            grp.add(new Konva.Text({
                x: -24, y: -24, text: label, fontSize: 10, fill: col,
                fontFamily: 'Space Mono', listening: false,
            }));
        }
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -14, width: 70, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    /**
     * NET_OUT:  pin on the right, arrow pointing right (out of the circuit).
     * Shape: ◁ rect with pointed left edge ├─wire
     */
    private drawNetOut(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Wire from body to pin
        grp.add(new Konva.Line({ points: [24, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        // Body: rectangle with arrow on left
        grp.add(new Konva.Line({
            points: [-22, 0, -14, -10, 24, -10, 24, 10, -14, 10], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(77,208,225,0.18)' : 'rgba(77,208,225,0.05)',
        }));
        // Arrow inside pointing right
        grp.add(new Konva.Line({
            points: [-2, -5, 6, 0, -2, 5], stroke: col, strokeWidth: 1.8,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Label text above body
        const label = comp.props.label || '';
        if (label) {
            grp.add(new Konva.Text({
                x: -14, y: -24, text: label, fontSize: 10, fill: col,
                fontFamily: 'Space Mono', listening: false,
            }));
        }
        if (sel) grp.add(new Konva.Rect({ x: -26, y: -14, width: 70, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    /**
     * NET_INOUT:  pin on the left, double arrow (bidirectional).
     * Shape: wire─┤ rect with pointed right edge ▷ and ◁ inside
     */
    private drawNetInOut(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Wire from pin to body
        grp.add(new Konva.Line({ points: [-40, 0, -24, 0], stroke: col, strokeWidth: 2 }));
        // Body: diamond-ended rectangle (pointed both sides)
        grp.add(new Konva.Line({
            points: [-22, 0, -14, -10, 14, -10, 22, 0, 14, 10, -14, 10], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(77,208,225,0.18)' : 'rgba(77,208,225,0.05)',
        }));
        // Left arrow
        grp.add(new Konva.Line({
            points: [-2, -5, -10, 0, -2, 5], stroke: col, strokeWidth: 1.8,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Right arrow
        grp.add(new Konva.Line({
            points: [2, -5, 10, 0, 2, 5], stroke: col, strokeWidth: 1.8,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Label text above body
        const label = comp.props.label || '';
        if (label) {
            grp.add(new Konva.Text({
                x: -14, y: -24, text: label, fontSize: 10, fill: col,
                fontFamily: 'Space Mono', listening: false,
            }));
        }
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -14, width: 70, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawProbeSymbol(grp: any, comp: CircuitComponent, sel: boolean): void {
        const col = this.circuit.getProbeColor(comp);

        grp.add(new Konva.Line({
            points: [0, 20, -10, 2, 10, 2, 0, 20], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? col.replace(')', ',0.25)').replace('rgb', 'rgba') : 'rgba(255,224,75,0.08)',
        }));
        grp.add(new Konva.Circle({
            x: 0, y: -6, radius: 8, stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(255,224,75,0.2)' : 'rgba(255,224,75,0.05)',
        }));
        grp.add(new Konva.Line({ points: [0, 2, 0, -14], stroke: col, strokeWidth: 2 }));

        if (sel) grp.add(new Konva.Rect({ x: -16, y: -20, width: 32, height: 46, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawCurrentProbeSymbol(grp: any, comp: CircuitComponent, sel: boolean): void {
        const col = this.circuit.getProbeColor(comp);

        // Wires
        grp.add(new Konva.Line({ points: [-40, 0, -14, 0], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [14, 0, 40, 0], stroke: col, strokeWidth: 2 }));

        // Body circle (ammeter style)
        grp.add(new Konva.Circle({
            x: 0, y: 0, radius: 14, stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(255,107,181,0.2)' : 'rgba(255,107,181,0.05)',
        }));

        // "I" text centered
        grp.add(new Konva.Text({
            x: -5, y: -7, text: 'I', fontSize: 14, fontStyle: 'bold',
            fill: col, fontFamily: 'Space Mono',
        }));

        // Direction arrow (small right arrow)
        grp.add(new Konva.Line({
            points: [5, -5, 10, 0, 5, 5], stroke: col, strokeWidth: 1.5,
            lineCap: 'round', lineJoin: 'round',
        }));

        // Selection outline
        if (sel) grp.add(new Konva.Rect({
            x: -44, y: -18, width: 88, height: 36,
            stroke: '#fff', strokeWidth: 0.5, dash: [3, 3],
            listening: false, cornerRadius: 3,
        }));
    }

    // ── Library Component Drawing ────────────────────────────────

    private drawDiode(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Wires
        grp.add(new Konva.Line({ points: [-40, 0, -10, 0], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [10, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        // Triangle (anode→cathode)
        grp.add(new Konva.Line({
            points: [-10, 0, 10, -10, 10, 10, -10, 0], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(255,68,68,0.18)' : 'rgba(255,68,68,0.05)',
        }));
        // Cathode bar
        grp.add(new Konva.Line({ points: [10, -10, 10, 10], stroke: col, strokeWidth: 2.5 }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -14, width: 88, height: 28, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawNPN(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Base wire
        grp.add(new Konva.Line({ points: [-40, 0, -14, 0], stroke: col, strokeWidth: 2 }));
        // Collector wire
        grp.add(new Konva.Line({ points: [0, -40, 0, -14], stroke: col, strokeWidth: 2 }));
        // Emitter wire
        grp.add(new Konva.Line({ points: [0, 40, 0, 14], stroke: col, strokeWidth: 2 }));
        // Base vertical bar
        grp.add(new Konva.Line({ points: [-14, -14, -14, 14], stroke: col, strokeWidth: 2.5 }));
        // Collector line
        grp.add(new Konva.Line({ points: [-14, -8, 0, -14], stroke: col, strokeWidth: 2 }));
        // Emitter line with arrow
        grp.add(new Konva.Line({ points: [-14, 8, 0, 14], stroke: col, strokeWidth: 2 }));
        // Arrow on emitter
        grp.add(new Konva.Line({
            points: [-4, 8, 0, 14, -8, 12], stroke: col, strokeWidth: 1.5,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Circle body
        grp.add(new Konva.Circle({
            x: -7, y: 0, radius: 16, stroke: col, strokeWidth: 1.5,
            fill: sel ? 'rgba(79,195,247,0.15)' : 'transparent', dash: [0],
        }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -44, width: 60, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawPNP(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Base wire
        grp.add(new Konva.Line({ points: [-40, 0, -14, 0], stroke: col, strokeWidth: 2 }));
        // Emitter wire (top)
        grp.add(new Konva.Line({ points: [0, -40, 0, -14], stroke: col, strokeWidth: 2 }));
        // Collector wire (bottom)
        grp.add(new Konva.Line({ points: [0, 40, 0, 14], stroke: col, strokeWidth: 2 }));
        // Base vertical bar
        grp.add(new Konva.Line({ points: [-14, -14, -14, 14], stroke: col, strokeWidth: 2.5 }));
        // Emitter line with arrow (pointing toward base)
        grp.add(new Konva.Line({ points: [0, -14, -14, -8], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({
            points: [-8, -12, -14, -8, -4, -8], stroke: col, strokeWidth: 1.5,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Collector line
        grp.add(new Konva.Line({ points: [-14, 8, 0, 14], stroke: col, strokeWidth: 2 }));
        // Circle body
        grp.add(new Konva.Circle({
            x: -7, y: 0, radius: 16, stroke: col, strokeWidth: 1.5,
            fill: sel ? 'rgba(206,147,216,0.15)' : 'transparent',
        }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -44, width: 60, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawNMOS(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Gate wire
        grp.add(new Konva.Line({ points: [-40, 0, -18, 0], stroke: col, strokeWidth: 2 }));
        // Drain wire
        grp.add(new Konva.Line({ points: [0, -40, 0, -14], stroke: col, strokeWidth: 2 }));
        // Source wire
        grp.add(new Konva.Line({ points: [0, 40, 0, 14], stroke: col, strokeWidth: 2 }));
        // Gate vertical line
        grp.add(new Konva.Line({ points: [-18, -14, -18, 14], stroke: col, strokeWidth: 2 }));
        // Channel bar (slightly offset from gate)
        grp.add(new Konva.Line({ points: [-12, -14, -12, 14], stroke: col, strokeWidth: 2.5 }));
        // Drain connection
        grp.add(new Konva.Line({ points: [-12, -10, 0, -14], stroke: col, strokeWidth: 2 }));
        // Source connection
        grp.add(new Konva.Line({ points: [-12, 10, 0, 14], stroke: col, strokeWidth: 2 }));
        // Body connection to source
        grp.add(new Konva.Line({ points: [-12, 0, 0, 0], stroke: col, strokeWidth: 1.5 }));
        // Arrow on source (toward channel)
        grp.add(new Konva.Line({
            points: [-6, -3, -2, 0, -6, 3], stroke: col, strokeWidth: 1.5,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Circle body
        grp.add(new Konva.Circle({
            x: -6, y: 0, radius: 20, stroke: col, strokeWidth: 1.5,
            fill: sel ? 'rgba(79,195,247,0.12)' : 'transparent',
        }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -44, width: 60, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawPMOS(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Gate wire
        grp.add(new Konva.Line({ points: [-40, 0, -22, 0], stroke: col, strokeWidth: 2 }));
        // Source wire (top)
        grp.add(new Konva.Line({ points: [0, -40, 0, -14], stroke: col, strokeWidth: 2 }));
        // Drain wire (bottom)
        grp.add(new Konva.Line({ points: [0, 40, 0, 14], stroke: col, strokeWidth: 2 }));
        // Gate vertical line
        grp.add(new Konva.Line({ points: [-18, -14, -18, 14], stroke: col, strokeWidth: 2 }));
        // Inversion circle on gate
        grp.add(new Konva.Circle({ x: -20, y: 0, radius: 3, stroke: col, strokeWidth: 1.5, fill: 'transparent' }));
        // Channel bar
        grp.add(new Konva.Line({ points: [-12, -14, -12, 14], stroke: col, strokeWidth: 2.5 }));
        // Source connection
        grp.add(new Konva.Line({ points: [-12, -10, 0, -14], stroke: col, strokeWidth: 2 }));
        // Drain connection
        grp.add(new Konva.Line({ points: [-12, 10, 0, 14], stroke: col, strokeWidth: 2 }));
        // Body connection
        grp.add(new Konva.Line({ points: [-12, 0, 0, 0], stroke: col, strokeWidth: 1.5 }));
        // Arrow away from channel (PMOS)
        grp.add(new Konva.Line({
            points: [-8, -3, -12, 0, -8, 3], stroke: col, strokeWidth: 1.5,
            lineCap: 'round', lineJoin: 'round',
        }));
        // Circle body
        grp.add(new Konva.Circle({
            x: -6, y: 0, radius: 20, stroke: col, strokeWidth: 1.5,
            fill: sel ? 'rgba(206,147,216,0.12)' : 'transparent',
        }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -44, width: 60, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawOpAmp(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Triangle body
        grp.add(new Konva.Line({
            points: [-24, -32, 32, 0, -24, 32, -24, -32], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(105,240,174,0.12)' : 'rgba(105,240,174,0.03)',
        }));
        // Input wires
        grp.add(new Konva.Line({ points: [-40, -20, -24, -20], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [-40, 20, -24, 20], stroke: col, strokeWidth: 2 }));
        // Output wire
        grp.add(new Konva.Line({ points: [32, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        // Supply wires
        grp.add(new Konva.Line({ points: [0, -40, 0, -18], stroke: col, strokeWidth: 1.5, dash: [3, 2] }));
        grp.add(new Konva.Line({ points: [0, 40, 0, 18], stroke: col, strokeWidth: 1.5, dash: [3, 2] }));
        // + label (non-inverting)
        grp.add(new Konva.Text({
            x: -21, y: -26, text: '+', fontSize: 12, fill: col, fontFamily: 'Space Mono',
        }));
        // − label (inverting)
        grp.add(new Konva.Text({
            x: -21, y: 14, text: '\u2212', fontSize: 12, fill: col, fontFamily: 'Space Mono',
        }));
        // V+ / V− tiny labels
        grp.add(new Konva.Text({ x: 3, y: -24, text: 'V+', fontSize: 7, fill: col, fontFamily: 'Space Mono', opacity: 0.6 }));
        grp.add(new Konva.Text({ x: 3, y: 16, text: 'V−', fontSize: 7, fill: col, fontFamily: 'Space Mono', opacity: 0.6 }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -44, width: 88, height: 88, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    private drawOpAmp3(grp: any, comp: CircuitComponent, col: string, sel: boolean): void {
        // Triangle body (same shape as 5-pin, no supply wires)
        grp.add(new Konva.Line({
            points: [-24, -32, 32, 0, -24, 32, -24, -32], closed: true,
            stroke: col, strokeWidth: 2,
            fill: sel ? 'rgba(105,240,174,0.12)' : 'rgba(105,240,174,0.03)',
        }));
        // Input wires
        grp.add(new Konva.Line({ points: [-40, -20, -24, -20], stroke: col, strokeWidth: 2 }));
        grp.add(new Konva.Line({ points: [-40, 20, -24, 20], stroke: col, strokeWidth: 2 }));
        // Output wire
        grp.add(new Konva.Line({ points: [32, 0, 40, 0], stroke: col, strokeWidth: 2 }));
        // + label (non-inverting)
        grp.add(new Konva.Text({
            x: -21, y: -26, text: '+', fontSize: 12, fill: col, fontFamily: 'Space Mono',
        }));
        // − label (inverting)
        grp.add(new Konva.Text({
            x: -21, y: 14, text: '\u2212', fontSize: 12, fill: col, fontFamily: 'Space Mono',
        }));
        // ∞ symbol to indicate ideal/infinite energy
        grp.add(new Konva.Text({ x: -4, y: -5, text: '∞', fontSize: 10, fill: col, fontFamily: 'Space Mono', opacity: 0.5 }));
        if (sel) grp.add(new Konva.Rect({ x: -44, y: -34, width: 88, height: 68, stroke: '#fff', strokeWidth: 0.5, dash: [3, 3], listening: false, cornerRadius: 3 }));
    }

    // ── Smart Label Placement ────────────────────────────────────

    /**
     * Draw a component's label at the best available position.
     * For PROBE, displays the user label; for others, the component id.
     * Considers rotation, wires and other components to avoid overlap.
     * Draws a small dotted leader line if the label is placed away.
     */
    private drawSmartLabel(grp: any, comp: CircuitComponent, col: string): void {
        // Determine display text and font
        const isProbe = comp.type === 'PROBE';
        const isIProbe = comp.type === 'IPROBE';
        let text: string;
        let subText: string | null = null;  // secondary line (model/part)
        if (isProbe) {
            const probes = this.circuit.components().filter(c => c.type === 'PROBE');
            const idx = probes.indexOf(comp);
            text = comp.props.label || String.fromCharCode(65 + Math.max(0, idx));
            col = this.circuit.getProbeColor(comp);
        } else if (isIProbe) {
            const iprobes = this.circuit.components().filter(c => c.type === 'IPROBE');
            const idx = iprobes.indexOf(comp);
            text = comp.props.label || 'I' + String.fromCharCode(65 + Math.max(0, idx));
            col = this.circuit.getProbeColor(comp);
        } else if (comp.props.partNumber) {
            // Library component with a specific part selected
            text = comp.props.name?.trim() || comp.id;
            subText = comp.props.partNumber;
        } else if (comp.props.model) {
            // Library component (generic)
            text = comp.props.name?.trim() || comp.id;
        } else {
            text = comp.props.name?.trim() || comp.id;
        }
        const fontSize = (isProbe || isIProbe) ? 11 : 10;
        const textW = text.length * fontSize * 0.6;  // approximate width
        const textH = subText ? fontSize * 2.2 : fontSize;

        // Candidate slots in LOCAL (un-rotated) coordinates
        // Each slot: { lx, ly, anchorX, anchorY }
        // lx/ly = text top-left offset; anchorX/anchorY = origin point for leader
        const slots = this.getLabelSlots(comp.type);

        // Convert component rotation to nearest 90° step
        const rot = ((comp.rotation % 360) + 360) % 360;

        // Score each slot: lower = better
        // We transform the local slot position into world space and
        // check for collisions with wires and other components.
        const wires = this.circuit.wires();
        const components = this.circuit.components();

        let bestSlot = slots[0];
        let bestScore = Infinity;

        for (const slot of slots) {
            // Slot center in local space
            const cx = slot.lx + textW / 2;
            const cy = slot.ly + textH / 2;

            // Transform to world space
            const rad = (rot * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const wx = comp.x + cx * cos - cy * sin;
            const wy = comp.y + cx * sin + cy * cos;

            let score = slot.priority;  // base priority (prefer close slots)

            // Penalize overlap with wires
            for (const w of wires) {
                for (let i = 0; i < w.points.length - 1; i++) {
                    const a = w.points[i], b = w.points[i + 1];
                    const dist = this.distPointToSeg(wx, wy, a.x, a.y, b.x, b.y);
                    if (dist < 12) score += 30;
                    else if (dist < 20) score += 10;
                }
            }

            // Penalize overlap with other components
            for (const other of components) {
                if (other.id === comp.id) continue;
                const d = Math.hypot(wx - other.x, wy - other.y);
                if (d < 30) score += 25;
                else if (d < 50) score += 8;
            }

            if (score < bestScore) {
                bestScore = score;
                bestSlot = slot;
            }
        }

        // Counter-rotate the text so it always reads normally (un-rotated)
        // The group is already rotated by comp.rotation, so we counter-rotate by -rotation
        const counterRot = -rot;

        // Compute the actual position of the text node in group-local space
        // When counter-rotating, the text's (x,y) in the group must be adjusted
        // so it visually appears at (bestSlot.lx, bestSlot.ly).
        let textGroupX = bestSlot.lx;
        let textGroupY = bestSlot.ly;
        if (rot !== 0) {
            const rad2 = (counterRot * Math.PI) / 180;
            const cosR = Math.cos(rad2), sinR = Math.sin(rad2);
            textGroupX = bestSlot.lx * cosR - bestSlot.ly * sinR;
            textGroupY = bestSlot.lx * sinR + bestSlot.ly * cosR;
        }

        // Draw leader line if the label is far from center
        // The leader endpoints are both in group-local space
        const labelCenterLx = textGroupX + textW / 2;
        const labelCenterLy = textGroupY + textH / 2;
        const distFromCenter = Math.hypot(bestSlot.lx + textW / 2, bestSlot.ly + textH / 2);
        if (distFromCenter > 28) {
            grp.add(new Konva.Line({
                points: [bestSlot.anchorX, bestSlot.anchorY, labelCenterLx, labelCenterLy],
                stroke: col, strokeWidth: 0.8, dash: [2, 3],
                opacity: 0.35, listening: false,
            }));
        }

        // Draw the label text (counter-rotated so it's always horizontal)
        grp.add(new Konva.Text({
            x: textGroupX,
            y: textGroupY,
            text,
            fontSize,
            fill: col,
            fontFamily: 'Space Mono',
            fontStyle: 'bold',
            listening: false,
            rotation: counterRot,
        }));

        // Draw secondary text (part number) below the main label
        if (subText) {
            grp.add(new Konva.Text({
                x: textGroupX,
                y: textGroupY + fontSize * 1.3,
                text: subText,
                fontSize: fontSize - 1,
                fill: col,
                fontFamily: 'Space Mono',
                fontStyle: 'normal',
                opacity: 0.6,
                listening: false,
                rotation: counterRot,
            }));
        }
    }

    /**
     * Returns candidate label positions in LOCAL (un-rotated) coordinates.
     * Each has: lx, ly (text top-left), anchorX, anchorY (leader origin on body),
     * and priority (lower = preferred by default).
     */
    private getLabelSlots(type: ComponentType): { lx: number; ly: number; anchorX: number; anchorY: number; priority: number }[] {
        switch (type) {
            case 'R':
            case 'L':
                // Horizontal body: prefer below, then above, then sides
                return [
                    { lx: -12, ly: 14, anchorX: 0, anchorY: 8, priority: 0 },   // below
                    { lx: -12, ly: -24, anchorX: 0, anchorY: -8, priority: 1 },   // above
                    { lx: 20, ly: -14, anchorX: 16, anchorY: 0, priority: 3 },   // right
                    { lx: -45, ly: -14, anchorX: -16, anchorY: 0, priority: 3 },   // left
                    { lx: 20, ly: 14, anchorX: 16, anchorY: 8, priority: 5 },   // bottom-right (far)
                    { lx: -45, ly: -24, anchorX: -16, anchorY: -8, priority: 5 },  // top-left (far)
                ];
            case 'C':
                // Vertical body: prefer right, then left, then above/below corners
                return [
                    { lx: 18, ly: -8, anchorX: 14, anchorY: 0, priority: 0 },   // right
                    { lx: -40, ly: -8, anchorX: -14, anchorY: 0, priority: 1 },   // left
                    { lx: 18, ly: -30, anchorX: 14, anchorY: -8, priority: 3 },   // top-right
                    { lx: -40, ly: -30, anchorX: -14, anchorY: -8, priority: 3 },  // top-left
                    { lx: 18, ly: 12, anchorX: 14, anchorY: 8, priority: 4 },   // bottom-right
                    { lx: -40, ly: 12, anchorX: -14, anchorY: 8, priority: 4 },   // bottom-left
                ];
            case 'V':
                // Circle body: prefer right side, then left, then corners
                return [
                    { lx: 24, ly: -8, anchorX: 18, anchorY: 0, priority: 0 },   // right
                    { lx: -48, ly: -8, anchorX: -18, anchorY: 0, priority: 1 },   // left
                    { lx: 20, ly: -36, anchorX: 12, anchorY: -18, priority: 3 },  // top-right
                    { lx: -44, ly: -36, anchorX: -12, anchorY: -18, priority: 3 }, // top-left
                    { lx: 20, ly: 22, anchorX: 12, anchorY: 18, priority: 4 },   // bottom-right
                    { lx: -44, ly: 22, anchorX: -12, anchorY: 18, priority: 4 },  // bottom-left
                ];
            case 'PROBE':
                // Probe: prefer above the circle, then sides
                return [
                    { lx: -8, ly: -32, anchorX: 0, anchorY: -14, priority: 0 },   // above
                    { lx: 14, ly: -16, anchorX: 8, anchorY: -6, priority: 2 },   // right
                    { lx: -30, ly: -16, anchorX: -8, anchorY: -6, priority: 2 },   // left
                    { lx: 14, ly: -32, anchorX: 8, anchorY: -14, priority: 3 },   // top-right
                    { lx: -30, ly: -32, anchorX: -8, anchorY: -14, priority: 3 },  // top-left
                ];
            case 'IPROBE':
                // Current probe: horizontal body, prefer below then above
                return [
                    { lx: -12, ly: 20, anchorX: 0, anchorY: 14, priority: 0 },   // below
                    { lx: -12, ly: -28, anchorX: 0, anchorY: -14, priority: 1 },  // above
                    { lx: 20, ly: -14, anchorX: 14, anchorY: 0, priority: 3 },   // right
                    { lx: -45, ly: -14, anchorX: -14, anchorY: 0, priority: 3 },  // left
                ];

            // ── Library component types ───────────────────────────
            case 'D':
                // Diode: horizontal body, prefer below then above
                return [
                    { lx: -12, ly: 18, anchorX: 0, anchorY: 10, priority: 0 },   // below
                    { lx: -12, ly: -28, anchorX: 0, anchorY: -10, priority: 1 },   // above
                    { lx: 22, ly: -8, anchorX: 10, anchorY: 0, priority: 3 },   // right
                    { lx: -48, ly: -8, anchorX: -10, anchorY: 0, priority: 3 },   // left
                    { lx: 22, ly: 18, anchorX: 10, anchorY: 10, priority: 5 },   // bottom-right
                    { lx: -48, ly: -28, anchorX: -10, anchorY: -10, priority: 5 },   // top-left
                ];
            case 'Q_NPN':
            case 'Q_PNP':
                // BJT: vertical shape with base on left, C/E top/bottom.
                // Label prefers right side (away from base wire)
                return [
                    { lx: 10, ly: -8, anchorX: 0, anchorY: 0, priority: 0 },   // right of body
                    { lx: 10, ly: -30, anchorX: 0, anchorY: -14, priority: 2 },   // top-right
                    { lx: 10, ly: 18, anchorX: 0, anchorY: 14, priority: 2 },   // bottom-right
                    { lx: -55, ly: -8, anchorX: -14, anchorY: 0, priority: 4 },   // left (behind base)
                    { lx: -55, ly: -30, anchorX: -14, anchorY: -14, priority: 5 },   // top-left far
                    { lx: -55, ly: 18, anchorX: -14, anchorY: 14, priority: 5 },   // bottom-left far
                ];
            case 'M_NMOS':
            case 'M_PMOS':
                // MOSFET: vertical shape with gate on left, D/S top/bottom.
                // Label prefers right side (away from gate wire)
                return [
                    { lx: 10, ly: -8, anchorX: 0, anchorY: 0, priority: 0 },   // right of body
                    { lx: 10, ly: -32, anchorX: 0, anchorY: -14, priority: 2 },   // top-right
                    { lx: 10, ly: 20, anchorX: 0, anchorY: 14, priority: 2 },   // bottom-right
                    { lx: -58, ly: -8, anchorX: -18, anchorY: 0, priority: 4 },   // left (behind gate)
                    { lx: -58, ly: -32, anchorX: -18, anchorY: -14, priority: 5 },   // top-left far
                    { lx: -58, ly: 20, anchorX: -18, anchorY: 14, priority: 5 },   // bottom-left far
                ];
            case 'OPAMP':
                // Op-Amp: triangle body; inputs left, output right, supplies top/bottom.
                // Label prefers top-right (above output), then bottom-right, then far sides
                return [
                    { lx: 10, ly: -50, anchorX: 10, anchorY: -22, priority: 0 },   // top-right
                    { lx: 10, ly: 34, anchorX: 10, anchorY: 22, priority: 1 },   // bottom-right
                    { lx: -60, ly: -50, anchorX: -24, anchorY: -22, priority: 3 },   // top-left
                    { lx: -60, ly: 34, anchorX: -24, anchorY: 22, priority: 3 },   // bottom-left
                    { lx: 20, ly: -8, anchorX: 32, anchorY: 0, priority: 4 },   // far right (past output)
                    { lx: -70, ly: -8, anchorX: -24, anchorY: 0, priority: 5 },   // far left
                ];
            case 'OPAMP3':
                // 3-pin ideal op-amp: no supply pins, label can go top/bottom freely
                return [
                    { lx: 10, ly: -34, anchorX: 10, anchorY: -18, priority: 0 },   // top-right
                    { lx: 10, ly: 22, anchorX: 10, anchorY: 18, priority: 1 },   // bottom-right
                    { lx: -60, ly: -34, anchorX: -24, anchorY: -18, priority: 2 },   // top-left
                    { lx: -60, ly: 22, anchorX: -24, anchorY: 18, priority: 2 },   // bottom-left
                    { lx: 20, ly: -8, anchorX: 30, anchorY: 0, priority: 4 },   // far right
                    { lx: -70, ly: -8, anchorX: -24, anchorY: 0, priority: 5 },   // far left
                ];

            default:
                // Fallback for any unknown type: safe positions around a generic body
                return [
                    { lx: 10, ly: -8, anchorX: 0, anchorY: 0, priority: 0 },
                    { lx: 10, ly: 18, anchorX: 0, anchorY: 10, priority: 2 },
                    { lx: -45, ly: -8, anchorX: 0, anchorY: 0, priority: 3 },
                    { lx: 10, ly: -28, anchorX: 0, anchorY: -10, priority: 3 },
                ];
        }
    }

    /** Euclidean distance from point (px, py) to segment (ax,ay)-(bx,by). */
    private distPointToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - ax, py - ay);
        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    // ── Box Selection ────────────────────────────────────────────

    /** Draw the selection rectangle on the overlay layer. */
    private drawBoxSelectRect(anchor: Point, current: Point): void {
        this.overlayLayer.destroyChildren();
        const x = Math.min(anchor.x, current.x);
        const y = Math.min(anchor.y, current.y);
        const w = Math.abs(current.x - anchor.x);
        const h = Math.abs(current.y - anchor.y);
        this.selectionRect = new Konva.Rect({
            x, y, width: w, height: h,
            fill: 'rgba(100, 180, 255, 0.08)',
            stroke: 'rgba(100, 180, 255, 0.5)',
            strokeWidth: 1,
            dash: [6, 3],
            listening: false,
        });
        this.overlayLayer.add(this.selectionRect);
        this.overlayLayer.draw();
    }

    /**
     * Compute which components and wires fall inside the selection box
     * and apply the multi-selection.
     */
    private finalizeBoxSelect(anchor: Point, end: Point): void {
        const x1 = Math.min(anchor.x, end.x);
        const y1 = Math.min(anchor.y, end.y);
        const x2 = Math.max(anchor.x, end.x);
        const y2 = Math.max(anchor.y, end.y);

        // Minimum drag distance to count as a box select (avoid accidental micro-drags)
        if (Math.abs(x2 - x1) < 5 && Math.abs(y2 - y1) < 5) {
            this.ngZone.run(() => this.state.clearSelection());
            return;
        }

        const ids = new Set<string>();

        // Test components: use their world-space bounding box
        for (const comp of this.circuit.components()) {
            const bounds = this.getComponentBounds(comp.type);
            const rad = (comp.rotation * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);

            // Rotate the 4 corners of the local bounding box
            const corners = [
                { lx: bounds.x, ly: bounds.y },
                { lx: bounds.x + bounds.w, ly: bounds.y },
                { lx: bounds.x + bounds.w, ly: bounds.y + bounds.h },
                { lx: bounds.x, ly: bounds.y + bounds.h },
            ];

            let inside = false;
            for (const c of corners) {
                const wx = comp.x + c.lx * cos - c.ly * sin;
                const wy = comp.y + c.lx * sin + c.ly * cos;
                if (wx >= x1 && wx <= x2 && wy >= y1 && wy <= y2) {
                    inside = true;
                    break;
                }
            }
            // Also check if center is inside
            if (!inside && comp.x >= x1 && comp.x <= x2 && comp.y >= y1 && comp.y <= y2) {
                inside = true;
            }
            if (inside) ids.add(comp.id);
        }

        // Test wires: if any endpoint is inside the box
        for (const wire of this.circuit.wires()) {
            for (const p of wire.points) {
                if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) {
                    ids.add(wire.id);
                    break;
                }
            }
        }

        this.ngZone.run(() => {
            if (ids.size > 0) {
                this.state.setSelection(ids);
            } else {
                this.state.clearSelection();
            }
        });
    }

    // ── Multi-drag ───────────────────────────────────────────────

    /** Draw ghost preview during multi-drag (simple offset overlay). */
    private drawMultiDragGhost(_dx: number, _dy: number): void {
        // We accumulate total offset since drag start and will apply on release.
        // The redraw during drag is handled by the effect watching selectedIds + wires/components.
        // For now nothing extra: the final move is applied at mouseup.
    }

    /** Finalize the multi-drag: apply the total offset to all selected items. */
    private finalizeMultiDrag(): void {
        this.isMultiDragging = false;
        const dx = this.multiDragLast.x - this.multiDragStart.x;
        const dy = this.multiDragLast.y - this.multiDragStart.y;
        if (dx === 0 && dy === 0) return;

        const multi = this.state.selectedIds();
        const compIds = new Set<string>();
        const wireIds = new Set<string>();
        for (const id of multi) {
            if (id.startsWith('w')) wireIds.add(id);
            else compIds.add(id);
        }

        this.ngZone.run(() => {
            this.circuit.moveSelection(compIds, wireIds, dx, dy);
            // Re-select with updated IDs (comp IDs don't change, wire IDs may after cleanup)
            // Keep the same set; if wire IDs changed, user can re-select
            // Actually component IDs are stable. We keep the selection as-is since
            // the moveSelection uses snapshot-based undo.
        });
    }

    // ── Wires ────────────────────────────────────────────────────

    private drawWire(wire: Wire): void {
        if (wire.points.length < 2) return;

        const pts: number[] = [];
        wire.points.forEach(p => pts.push(p.x, p.y));

        const isWireMode = this.state.wireMode();
        const drawStart = this.state.wireDrawStart();
        const isSelected = this.state.isSelected(wire.id);

        const line = new Konva.Line({
            points: pts,
            stroke: isSelected ? '#FAFAFA' : '#888888',
            strokeWidth: isSelected ? 3 : 2,
            lineCap: 'round', lineJoin: 'round', hitStrokeWidth: 10,
        });

        // ── Dragging (select mode only, not wire mode) ───────────
        const isInMultiWire = this.state.selectedIds().has(wire.id);
        if (!isWireMode && isSelected && wire.points.length === 2 && !isInMultiWire) {
            const p0 = wire.points[0], p1 = wire.points[1];
            const isHorizontal = p0.y === p1.y;

            line.draggable(true);

            let dragOriginX = 0, dragOriginY = 0;

            line.on('dragstart', () => {
                dragOriginX = line.x();
                dragOriginY = line.y();
            });

            line.on('dragmove', () => {
                // Constrain: horizontal wires move vertically, vertical wires move horizontally
                if (isHorizontal) {
                    line.x(0); // lock X
                    line.y(this.circuit.snap(line.y()));
                } else {
                    line.y(0); // lock Y
                    line.x(this.circuit.snap(line.x()));
                }
            });

            line.on('dragend', () => {
                const dx = this.circuit.snap(line.x());
                const dy = this.circuit.snap(line.y());
                if (dx !== 0 || dy !== 0) {
                    this.ngZone.run(() => {
                        this.circuit.moveWire(wire.id, dx, dy);
                    });
                }
                // Reset line offset so the redraw positions it correctly
                line.x(0);
                line.y(0);
            });
        }

        // Multi-drag: mousedown on a multi-selected wire → start group drag
        if (isInMultiWire && !isWireMode) {
            line.on('mousedown', (ev: any) => {
                if (ev.evt.button !== 0) return;
                ev.cancelBubble = true;
                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);
                const sx = this.circuit.snap(wPos.x);
                const sy = this.circuit.snap(wPos.y);
                this.isMultiDragging = true;
                this.multiDragStart = { x: sx, y: sy };
                this.multiDragLast = { x: sx, y: sy };
            });
        }

        // ── Click ────────────────────────────────────────────────
        line.on('click', (ev: any) => {
            ev.cancelBubble = true;

            if (isWireMode) {
                // Wire-mode click logic
                const pos = this.stage.getPointerPosition();
                const wPos = this.screenToWorld(pos);
                const snap = this.circuit.snapToTarget(wPos.x, wPos.y);
                const endPt = snap.point;
                const currentDrawStart = this.state.wireDrawStart();

                if (currentDrawStart) {
                    // Finish wire on this wire → split & connect
                    this.ngZone.run(() => {
                        this.circuit.splitWireAt(wire.id, endPt);
                        if (currentDrawStart.x !== endPt.x || currentDrawStart.y !== endPt.y) {
                            const hFirst = this.state.wireHFirst();
                            this.circuit.addWire({
                                id: 'w' + Date.now(),
                                points: this.circuit.routeL(currentDrawStart, endPt, hFirst),
                            });
                        }
                        this.state.wireDrawStart.set(null);
                        this.ghostLayer.destroyChildren();
                        this.ghostLayer.draw();
                    });
                } else {
                    // Start a new wire from this wire → split & begin
                    this.ngZone.run(() => {
                        this.circuit.splitWireAt(wire.id, endPt);
                        this.state.wireDrawStart.set(endPt);
                    });
                }
            } else {
                // Select mode → select this wire segment
                this.ngZone.run(() => {
                    this.state.selectComp(wire.id);
                    this.state.selectedWirePoints.set(wire.points.map(p => ({ ...p })));
                });
            }
        });

        // Double-click on wire: delete wire (works in both modes)
        line.on('dblclick', (ev: any) => {
            ev.cancelBubble = true;
            if (!isWireMode) {
                this.ngZone.run(() => this.circuit.removeWire(wire.id));
            }
        });

        line.on('mouseenter', () => {
            if (isWireMode && drawStart) {
                line.stroke('#ff6bb5');
                line.strokeWidth(3);
            } else if (isWireMode) {
                line.stroke('#00e890');
                line.strokeWidth(3);
            } else if (!isSelected) {
                line.stroke('#FAFAFA');
            }
            this.wireLayer.draw();
            if (isWireMode) {
                const sPos = this.stage.getPointerPosition();
                const tooltip = drawStart ? 'Click to connect to wire' : 'Click to start wire here';
                this.ngZone.run(() => this.state.showTooltip(tooltip, sPos.x, sPos.y));
            }
        });

        line.on('mouseleave', () => {
            line.stroke(isSelected ? '#FAFAFA' : '#888888');
            line.strokeWidth(isSelected ? 3 : 2);
            this.wireLayer.draw();
            this.ngZone.run(() => this.state.hideTooltip());
        });

        this.wireLayer.add(line);

        // Selection dashed outline
        if (isSelected) {
            this.wireLayer.add(new Konva.Line({
                points: pts,
                stroke: '#fff', strokeWidth: 0.5, dash: [3, 3],
                lineCap: 'round', lineJoin: 'round', listening: false,
            }));
        }

        // Endpoint dots
        [wire.points[0], wire.points[wire.points.length - 1]].forEach(p => {
            this.wireLayer.add(new Konva.Circle({
                x: p.x, y: p.y, radius: isSelected ? 5 : 3.5,
                fill: isSelected ? '#FAFAFA' : '#888888', listening: false,
            }));
        });
    }

    // ── Junction dots (computed, not stored) ─────────────────────

    private drawJunctionDot(pt: Point): void {
        this.wireLayer.add(new Konva.Circle({
            x: pt.x, y: pt.y, radius: 5,
            fill: '#ffb84f', stroke: '#ff8c00', strokeWidth: 2,
            listening: false,
        }));
    }
}
