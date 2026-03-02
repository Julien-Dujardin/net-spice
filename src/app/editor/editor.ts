import {
  Component, OnInit, HostListener, signal, ViewChild,
} from '@angular/core';
import { EditorHeader } from './header/header';
import { EditorCanvas } from './canvas/canvas';
import { PropertiesPanel } from './properties-panel/properties-panel';
import { ChartsPanel } from './charts-panel/charts-panel';
import { Tooltip } from './tooltip/tooltip';
import { ProbeList } from './probe-list/probe-list';
import { SimConfigPanel } from './sim-config/sim-config';

import { CircuitService } from './services/circuit.service';
import { EditorStateService } from './services/editor-state.service';
import { ErrorService } from './services/error.service';
import { UndoRedoService } from './services/undo-redo.service';
import { NgspiceService, SimulationResult } from '../services/ngspice.service';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [
    EditorHeader, EditorCanvas, PropertiesPanel,
    ChartsPanel, Tooltip, ProbeList, SimConfigPanel,
  ],
  templateUrl: './editor.html',
  styleUrl: './editor.css',
})
export class Editor implements OnInit {
  @ViewChild(EditorCanvas) canvasComp!: EditorCanvas;

  readonly simulationResult = signal<SimulationResult | null>(null);

  private resizing: 'charts' | 'properties' | null = null;
  private resizeStartY = 0;
  private resizeStartX = 0;
  private resizeInitialHeight = 0;
  private resizeInitialWidth = 0;

  constructor(
    private circuit: CircuitService,
    protected state: EditorStateService,
    protected errorService: ErrorService,
    protected undoRedo: UndoRedoService,
    private ngspice: NgspiceService,
  ) { }

  async ngOnInit(): Promise<void> {
    const ready = await this.ngspice.waitForInitialization();
    if (ready) {
      this.state.setReady();
      // Only load default circuit if nothing was pre-loaded (e.g. from an example)
      if (this.circuit.components().length === 0 && this.circuit.wires().length === 0) {
        this.circuit.loadDefaultCircuit();
      }
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    // Undo/Redo shortcuts
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      this.undoRedo.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)) && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      this.undoRedo.redo();
      return;
    }

    if (e.key === 'Escape') {
      this.state.cancelAll();
    }
    if (e.key === 'Home') {
      this.canvasComp?.resetView();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (this.state.selectedId() || this.state.hasMultiSelection()) && (e.target as HTMLElement).tagName !== 'INPUT') {
      this.deleteSelected();
    }
    if (e.key === 'r' && this.state.selectedId() && !this.state.selectedId()!.startsWith('w') && (e.target as HTMLElement).tagName !== 'INPUT') {
      this.circuit.rotateComponent(this.state.selectedId()!);
    }
  }

  runSimulation(): void {
    this.state.setStatus('Validating…');
    this.errorService.clear();

    // Pre-simulation validation
    const validationErrors = this.circuit.validateCircuit();
    const hasBlockingErrors = validationErrors.some(e => e.severity === 'error');

    if (hasBlockingErrors) {
      this.errorService.setErrors(validationErrors);
      this.errorService.errorsVisible.set(true);
      this.state.setStatus(`✗ ${validationErrors.filter(e => e.severity === 'error').length} error(s) — fix circuit before running`);
      return;
    }

    // Non-blocking warnings — set them but continue
    if (validationErrors.length) {
      this.errorService.setErrors(validationErrors);
    }

    this.state.setStatus('Running…');

    setTimeout(() => {
      try {
        const probeNodes = this.circuit.probeNodes();
        if (!probeNodes.length) {
          this.state.setStatus('⚠ No probes — add probes to the circuit');
          return;
        }

        const netlist = this.circuit.genNetlist();
        const result = this.ngspice.runSimulation(netlist, probeNodes);
        this.simulationResult.set(result);

        // Parse ngspice runtime errors
        const runtimeErrors = this.errorService.parseNgspiceOutput(result.ngspiceMessages);
        if (runtimeErrors.length) {
          this.errorService.setErrors([...validationErrors, ...runtimeErrors]);
          this.errorService.errorsVisible.set(true);
          const errCount = runtimeErrors.filter(e => e.severity === 'error').length;
          if (errCount > 0) {
            this.state.setStatus(`⚠ Simulation completed with ${errCount} error(s)`);
          } else {
            this.state.setStatus('✓ OK (with warnings)');
          }
        } else {
          this.state.setStatus('✓ OK');
        }
      } catch (err) {
        console.error(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        this.errorService.addError({
          severity: 'error',
          message: `Simulation failed: ${errMsg}`,
          detail: 'Check the browser console for details.',
        });
        this.errorService.errorsVisible.set(true);
        this.state.setStatus('✗ Error — see error panel');
      }
    }, 30);
  }

  private deleteSelected(): void {
    const multi = this.state.selectedIds();
    if (multi.size > 0) {
      const compIds = new Set<string>();
      const wireIds = new Set<string>();
      for (const id of multi) {
        if (id.startsWith('w')) wireIds.add(id);
        else compIds.add(id);
      }
      this.circuit.removeSelection(compIds, wireIds);
      this.state.clearSelection();
      return;
    }
    const id = this.state.selectedId();
    if (!id) return;
    if (id.startsWith('w')) {
      this.circuit.removeWire(id);
    } else {
      this.circuit.removeComponent(id);
    }
    this.state.selectComp(null);
  }

  startResize(panel: 'charts' | 'properties', event: MouseEvent): void {
    event.preventDefault();
    this.resizing = panel;
    if (panel === 'charts') {
      this.resizeStartY = event.clientY;
      this.resizeInitialHeight = this.state.chartsPanelHeight();
    } else {
      this.resizeStartX = event.clientX;
      this.resizeInitialWidth = this.state.propertiesPanelWidth();
    }
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.resizing === 'charts') {
      const delta = this.resizeStartY - event.clientY;
      const newHeight = this.resizeInitialHeight + delta;
      this.state.setChartsPanelHeight(newHeight);
    } else if (this.resizing === 'properties') {
      const delta = this.resizeStartX - event.clientX;
      const newWidth = this.resizeInitialWidth + delta;
      this.state.setPropertiesPanelWidth(newWidth);
    }
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    this.resizing = null;
  }
}
