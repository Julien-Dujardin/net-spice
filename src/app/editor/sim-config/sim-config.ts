import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CircuitService } from '../services/circuit.service';
import { EditorStateService } from '../services/editor-state.service';
import {
    AnalysisType, SimConfig, DEFAULT_SIM_CONFIG,
} from '../models/circuit.model';

@Component({
    selector: 'app-sim-config',
    standalone: true,
    imports: [FormsModule],
    templateUrl: './sim-config.html',
    styleUrl: './sim-config.css',
})
export class SimConfigPanel {
    constructor(
        protected circuit: CircuitService,
        protected state: EditorStateService,
    ) { }

    get config(): SimConfig { return this.circuit.simConfig(); }

    /** All voltage sources in the circuit (for DC sweep source picker) */
    readonly voltageSources = computed(() =>
        this.circuit.components()
            .filter(c => c.type === 'V')
            .map(c => ({ id: c.id, label: `V_${c.id}` }))
    );

    /** Generated SPICE directive line(s) from current config */
    readonly generatedDirective = computed(() => this.circuit.buildAnalysisDirective());

    /** Preview of the full netlist */
    readonly netlistPreview = computed(() => {
        try { return this.circuit.genNetlist(); } catch { return '* Error generating netlist'; }
    });

    setType(type: AnalysisType): void {
        this.circuit.updateSimConfig({ type });
    }

    updateTran(field: string, value: string | boolean): void {
        this.circuit.updateSimConfig({
            tran: { ...this.config.tran, [field]: value },
        });
    }

    updateAc(field: string, value: string): void {
        this.circuit.updateSimConfig({
            ac: { ...this.config.ac, [field]: value },
        });
    }

    updateDc(field: string, value: string): void {
        this.circuit.updateSimConfig({
            dc: { ...this.config.dc, [field]: value },
        });
    }

    updateCustomDirectives(value: string): void {
        this.circuit.updateSimConfig({ customDirectives: value });
    }

    close(): void {
        this.state.simConfigOpen.set(false);
    }
}
