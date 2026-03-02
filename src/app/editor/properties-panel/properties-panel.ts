import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CircuitService } from '../services/circuit.service';
import { EditorStateService } from '../services/editor-state.service';
import { PROBE_COLORS } from '../models/circuit.model';
import {
    isLibraryComponent, getGenericDef, GenericComponentDef,
    EditableParam,
} from '../models/component-library';

@Component({
    selector: 'app-properties-panel',
    standalone: true,
    imports: [FormsModule],
    templateUrl: './properties-panel.html',
    styleUrl: './properties-panel.css',
})
export class PropertiesPanel {
    readonly PROBE_COLORS = PROBE_COLORS;

    /** Whether the simulation parameters section is expanded */
    readonly simParamsExpanded = signal(true);
    /** Whether the custom model section is expanded */
    readonly customModelExpanded = signal(false);

    constructor(
        protected circuit: CircuitService,
        protected state: EditorStateService,
    ) { }

    readonly selectedComp = computed(() => {
        const id = this.state.selectedId();
        if (!id) return null;
        return this.circuit.components().find(c => c.id === id) || null;
    });

    readonly fcDisplay = computed(() => this.circuit.computeFc());

    readonly probeColor = computed(() => {
        const comp = this.selectedComp();
        if (!comp || (comp.type !== 'PROBE' && comp.type !== 'IPROBE')) return '';
        return this.circuit.getProbeColor(comp);
    });

    readonly probeNodeResolved = computed(() => {
        const comp = this.selectedComp();
        if (!comp || (comp.type !== 'PROBE' && comp.type !== 'IPROBE')) return null;
        return this.circuit.resolveProbeNode(comp);
    });

    /** Returns the library GenericComponentDef if the selected component is a library type, null otherwise. */
    readonly libraryDef = computed((): GenericComponentDef | null => {
        const comp = this.selectedComp();
        if (!comp || !isLibraryComponent(comp.type)) return null;
        return getGenericDef(comp.type) || null;
    });

    /** Editable simulation parameters for the current component type */
    readonly editableParams = computed((): EditableParam[] => {
        const def = this.libraryDef();
        return def?.editableParams || [];
    });

    /** Get the current value of a sim param (stored as sim_KEY in props) */
    getSimParamValue(comp: any, key: string): string {
        return (comp.props as any)['sim_' + key] || '';
    }

    updateProp(key: string, value: string): void {
        const id = this.state.selectedId();
        if (id) {
            this.circuit.updateComponentProps(id, key, value);
        }
    }

    /** Update a simulation parameter (stored as sim_KEY prop) */
    updateSimParam(key: string, value: string): void {
        const id = this.state.selectedId();
        if (id) {
            this.circuit.updateComponentProps(id, `sim_${key}`, value);
        }
    }

    rotateSelected(): void {
        const id = this.state.selectedId();
        if (id) this.circuit.rotateComponent(id);
    }

    deleteSelected(): void {
        const id = this.state.selectedId();
        if (!id) return;
        this.circuit.removeComponent(id);
        this.state.selectComp(null);
    }

    close(): void {
        this.state.togglePropertiesPanel();
    }

    toggleSimParams(): void {
        this.simParamsExpanded.set(!this.simParamsExpanded());
    }

    toggleCustomModel(): void {
        this.customModelExpanded.set(!this.customModelExpanded());
    }
}
