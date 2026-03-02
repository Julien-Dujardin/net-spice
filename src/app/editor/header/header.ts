import { Component, output, signal, computed, ElementRef, inject, AfterViewInit, OnDestroy } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { EditorStateService } from '../services/editor-state.service';
import { CircuitService } from '../services/circuit.service';
import { RewireService } from '../services/rewire.service';
import { ErrorService } from '../services/error.service';
import { UndoRedoService } from '../services/undo-redo.service';
import { FileIoService } from '../services/file-io.service';
import { ComponentType } from '../models/circuit.model';
import {
    getComponentsByCategory,
    GenericComponentDef, ComponentCategory,
} from '../models/component-library';

@Component({
    selector: 'app-editor-header',
    standalone: true,
    imports: [KeyValuePipe],
    templateUrl: './header.html',
    styleUrl: './header.css',
})
export class EditorHeader implements AfterViewInit, OnDestroy {
    readonly runClicked = output<void>();

    /** Component library data for the template */
    readonly componentCategories = getComponentsByCategory();

    /** Basic components ordered by display priority (most important first) */
    readonly basicComponents = [
        { type: 'R' as ComponentType, symbol: '⊓', colorStyle: 'color:#ff8c00', label: 'R', fullName: 'Resistor' },
        { type: 'C' as ComponentType, symbol: '⊣⊢', colorStyle: 'color:#00c8f0', label: 'C', fullName: 'Capacitor' },
        { type: 'V' as ComponentType, symbol: '◎', colorStyle: 'color:#b388ff', label: 'V', fullName: 'Voltage Source' },
        { type: 'GND' as ComponentType, symbol: '⏚', colorStyle: 'color:#4a6070', label: 'GND', fullName: 'Ground' },
        { type: 'L' as ComponentType, symbol: '⌇', colorStyle: 'color:#ffd060', label: 'L', fullName: 'Inductor' },
        { type: 'D' as ComponentType, symbol: '▷|', colorStyle: 'color:#ff4444', label: 'D', fullName: 'Diode' },
    ];

    private el = inject(ElementRef);
    private resizeObs?: ResizeObserver;
    private headerWidth = signal(1920);

    /** How many basic quick buttons to show based on available width */
    readonly visibleBasicCount = computed(() => {
        const w = this.headerWidth();
        if (w >= 1340) return 6;
        if (w >= 1240) return 4;
        if (w >= 1140) return 3;
        if (w >= 1040) return 2;
        return 0;
    });

    readonly visibleBasics = computed(() =>
        this.basicComponents.slice(0, this.visibleBasicCount())
    );

    readonly showZoom = computed(() => this.headerWidth() >= 1800);

    constructor(
        protected state: EditorStateService,
        protected circuit: CircuitService,
        protected errorService: ErrorService,
        protected undoRedo: UndoRedoService,
        private rewireService: RewireService,
        private fileIo: FileIoService,
    ) { }

    ngAfterViewInit(): void {
        this.resizeObs = new ResizeObserver(entries => {
            for (const entry of entries) {
                this.headerWidth.set(entry.contentRect.width);
            }
        });
        this.resizeObs.observe(this.el.nativeElement);
    }

    ngOnDestroy(): void {
        this.resizeObs?.disconnect();
    }

    // ── File menu ───────────────────────────────────────────────

    fileMenuOpen = false;

    toggleFileMenu(): void { this.fileMenuOpen = !this.fileMenuOpen; }
    closeFileMenu(): void { this.fileMenuOpen = false; }

    exportNetlist(): void {
        this.fileIo.exportNetlist();
        this.closeFileMenu();
    }

    exportProject(): void {
        this.fileIo.exportProject();
        this.closeFileMenu();
    }

    async importProject(): Promise<void> {
        this.closeFileMenu();
        try {
            await this.fileIo.importProject();
        } catch (err) {
            console.error('Import failed:', err);
        }
    }

    rewire(): void {
        this.rewireService.rewire();
    }

    deepCleanup(): void {
        this.circuit.deepCleanupWires();
    }

    startPlace(type: ComponentType): void {
        this.state.startPlace(type);
    }

    toggleWireMode(): void {
        this.state.toggleWireMode();
    }

    toggleProbeMenu(): void {
        this.state.toggleProbeMenu();
    }

    closeProbeMenu(): void {
        this.state.closeProbeMenu();
    }

    placeProbeAndClose(type: ComponentType): void {
        this.startPlace(type);
        this.closeProbeMenu();
    }

    openProbeList(): void {
        this.state.toggleProbeList();
        this.closeProbeMenu();
    }

    // ── Net labels menu ─────────────────────────────────────────

    toggleNetMenu(): void {
        this.state.toggleNetMenu();
    }

    closeNetMenu(): void {
        this.state.closeNetMenu();
    }

    placeNetAndClose(type: ComponentType): void {
        this.startPlace(type);
        this.closeNetMenu();
    }

    // ── Components library menu ─────────────────────────────────

    toggleComponentsMenu(): void {
        this.state.toggleComponentsMenu();
    }

    closeComponentsMenu(): void {
        this.state.closeComponentsMenu();
    }

    placeGenericAndClose(key: string): void {
        this.startPlace(key as ComponentType);
        this.closeComponentsMenu();
    }

    toggleErrors(): void {
        this.errorService.toggleVisible();
    }

    deleteSelected(): void { }

    resetView(): void { }

    onRun(): void {
        this.runClicked.emit();
    }
}
