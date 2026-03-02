import { Injectable, signal, computed } from '@angular/core';
import { ComponentType, Point } from '../models/circuit.model';

export type EditorMode = 'select' | 'place' | 'wire';

@Injectable({ providedIn: 'root' })
export class EditorStateService {
    readonly selectedId = signal<string | null>(null);
    /** Cached geometry of the selected wire (for fallback deletion when IDs become stale). */
    readonly selectedWirePoints = signal<Point[] | null>(null);
    readonly placeMode = signal<ComponentType | null>(null);
    readonly wireMode = signal(false);
    /** Starting point of the wire segment currently being drawn (null = not drawing). */
    readonly wireDrawStart = signal<Point | null>(null);
    /** When true the L-bend goes horizontal-first, otherwise vertical-first. */
    readonly wireHFirst = signal(true);
    readonly currentMode = signal<EditorMode>('select');
    readonly zoomLevel = signal(100);
    readonly statusMessage = signal('Waiting Wasm…');
    readonly isReady = signal(false);

    /** Tooltip state */
    readonly tooltipText = signal('');
    readonly tooltipX = signal(0);
    readonly tooltipY = signal(0);
    readonly tooltipVisible = signal(false);

    /** Panel visibility and sizes */
    readonly chartsPanelVisible = signal(true);
    readonly propertiesPanelVisible = signal(true);
    readonly chartsPanelHeight = signal(300);
    readonly propertiesPanelWidth = signal(260);

    /** Probe menu */
    readonly probeMenuOpen = signal(false);

    // ── Multi-selection (box select) ─────────────────────────────

    /** Set of currently selected component/wire IDs. */
    readonly selectedIds = signal<ReadonlySet<string>>(new Set());

    /** Box-select rectangle anchors (world coords, null when not dragging). */
    readonly boxSelectStart = signal<Point | null>(null);
    readonly boxSelectEnd = signal<Point | null>(null);

    /** True when there is an active multi-selection (≥ 1 item). */
    readonly hasMultiSelection = computed(() => this.selectedIds().size > 0);

    /** Check if a given id is in the multi-selection. */
    isSelected(id: string): boolean {
        if (this.selectedIds().size > 0) return this.selectedIds().has(id);
        return this.selectedId() === id;
    }

    /** Replace the multi-selection set. Clears single selectedId. */
    setSelection(ids: Set<string>): void {
        this.selectedIds.set(ids);
        this.selectedId.set(null);
        this.selectedWirePoints.set(null);
    }

    /** Clear both single and multi selections. */
    clearSelection(): void {
        this.selectedId.set(null);
        this.selectedIds.set(new Set());
        this.selectedWirePoints.set(null);
    }

    selectComp(id: string | null): void {
        this.selectedIds.set(new Set());          // clear multi
        this.selectedId.set(id);
        if (!id || !id.startsWith('w')) {
            this.selectedWirePoints.set(null);
        }
    }

    startPlace(type: ComponentType): void {
        this.cancelWire();
        this.placeMode.set(type);
        this.currentMode.set('place');
        this.selectedId.set(null);
    }

    cancelPlace(): void {
        this.placeMode.set(null);
        if (this.currentMode() === 'place') {
            this.currentMode.set('select');
        }
    }

    toggleWireMode(): void {
        const newMode = !this.wireMode();
        this.wireMode.set(newMode);
        this.wireDrawStart.set(null);
        this.cancelPlace();
        if (newMode) {
            this.currentMode.set('wire');
        } else {
            this.currentMode.set('select');
        }
    }

    cancelWire(): void {
        this.wireMode.set(false);
        this.wireDrawStart.set(null);
        if (this.currentMode() === 'wire') {
            this.currentMode.set('select');
        }
    }

    /** Cancel the current segment only (stay in wire mode). */
    cancelCurrentSegment(): void {
        this.wireDrawStart.set(null);
    }

    cancelAll(): void {
        this.cancelPlace();
        this.cancelWire();
        this.clearSelection();
    }

    /** Toggle L-bend direction (H-first ↔ V-first). */
    toggleBendDirection(): void {
        this.wireHFirst.set(!this.wireHFirst());
    }

    showTooltip(text: string, x: number, y: number): void {
        this.tooltipText.set(text);
        this.tooltipX.set(x + 14);
        this.tooltipY.set(y - 10);
        this.tooltipVisible.set(true);
    }

    hideTooltip(): void {
        this.tooltipVisible.set(false);
    }

    setStatus(msg: string): void {
        this.statusMessage.set(msg);
    }

    setReady(): void {
        this.isReady.set(true);
        this.setStatus('Ready');
    }

    setZoom(percent: number): void {
        this.zoomLevel.set(Math.round(percent));
    }

    toggleChartsPanel(): void {
        this.chartsPanelVisible.set(!this.chartsPanelVisible());
    }

    togglePropertiesPanel(): void {
        this.propertiesPanelVisible.set(!this.propertiesPanelVisible());
    }

    setChartsPanelHeight(height: number): void {
        this.chartsPanelHeight.set(Math.max(100, Math.min(height, 800)));
    }

    setPropertiesPanelWidth(width: number): void {
        this.propertiesPanelWidth.set(Math.max(200, Math.min(width, 600)));
    }

    toggleProbeMenu(): void {
        this.probeMenuOpen.set(!this.probeMenuOpen());
    }

    closeProbeMenu(): void {
        this.probeMenuOpen.set(false);
    }

    /** Net labels menu */
    readonly netMenuOpen = signal(false);

    toggleNetMenu(): void {
        this.netMenuOpen.set(!this.netMenuOpen());
    }

    closeNetMenu(): void {
        this.netMenuOpen.set(false);
    }

    /** Components library menu */
    readonly componentsMenuOpen = signal(false);
    /** Currently expanded subcategory in the components menu (null = top level) */
    readonly componentsMenuGenericKey = signal<string | null>(null);

    toggleComponentsMenu(): void {
        this.componentsMenuOpen.set(!this.componentsMenuOpen());
        this.componentsMenuGenericKey.set(null);
    }

    closeComponentsMenu(): void {
        this.componentsMenuOpen.set(false);
        this.componentsMenuGenericKey.set(null);
    }

    expandGenericInMenu(key: string): void {
        this.componentsMenuGenericKey.set(
            this.componentsMenuGenericKey() === key ? null : key
        );
    }

    readonly probeListOpen = signal(false);

    toggleProbeList(): void {
        this.probeListOpen.set(!this.probeListOpen());
    }

    closeProbeList(): void {
        this.probeListOpen.set(false);
    }

    /** Sim config dialog */
    readonly simConfigOpen = signal(false);

    toggleSimConfig(): void {
        this.simConfigOpen.set(!this.simConfigOpen());
    }

    /** Model import dialog */
    readonly modelImportOpen = signal(false);

    toggleModelImport(): void {
        this.modelImportOpen.set(!this.modelImportOpen());
    }

    closeModelImport(): void {
        this.modelImportOpen.set(false);
    }
}
