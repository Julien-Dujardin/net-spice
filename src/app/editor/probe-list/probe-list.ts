import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CircuitService } from '../services/circuit.service';
import { EditorStateService } from '../services/editor-state.service';
import { PROBE_COLORS } from '../models/circuit.model';

@Component({
    selector: 'app-probe-list',
    standalone: true,
    imports: [FormsModule],
    templateUrl: './probe-list.html',
    styleUrl: './probe-list.css',
})
export class ProbeList {
    readonly PROBE_COLORS = PROBE_COLORS;
    readonly editingId = signal<string | null>(null);

    constructor(
        protected circuit: CircuitService,
        protected state: EditorStateService,
    ) { }

    readonly allProbes = computed(() =>
        this.circuit.components().filter(c => c.type === 'PROBE' || c.type === 'IPROBE')
    );

    readonly nodeMap = computed(() => this.circuit.nodeMap());

    getProbeColor(probe: any): string {
        return this.circuit.getProbeColor(probe);
    }

    getProbeNode(probe: any): string {
        if (probe.type === 'IPROBE') {
            const p = this.nodeMap().get(`${probe.id}.p`);
            const n = this.nodeMap().get(`${probe.id}.n`);
            if (p && n) return `${p} → ${n}`;
            return '—';
        }
        return this.nodeMap().get(`${probe.id}.tip`) || '—';
    }

    getProbeLabel(probe: any, index: number): string {
        if (probe.type === 'IPROBE') {
            return probe.props.label || 'I' + String.fromCharCode(65 + index);
        }
        return probe.props.label || String.fromCharCode(65 + index);
    }

    getProbeType(probe: any): string {
        return probe.type === 'IPROBE' ? 'I' : 'V';
    }

    selectProbe(id: string): void {
        this.state.selectComp(id);
    }

    deleteProbe(id: string): void {
        this.circuit.removeComponent(id);
        if (this.state.selectedId() === id) {
            this.state.selectComp(null);
        }
    }

    startEditing(id: string): void {
        this.editingId.set(id);
    }

    finishEditing(id: string, newLabel: string): void {
        this.circuit.updateComponentProps(id, 'label', newLabel);
        this.editingId.set(null);
    }

    cycleColor(probe: any): void {
        const currentColor = this.getProbeColor(probe);
        const currentIdx = PROBE_COLORS.indexOf(currentColor);
        const nextIdx = (currentIdx + 1) % PROBE_COLORS.length;
        this.circuit.updateComponentProps(probe.id, 'probeColor', PROBE_COLORS[nextIdx]);
    }
}
