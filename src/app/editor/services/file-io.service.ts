import { Injectable } from '@angular/core';
import { CircuitService } from './circuit.service';
import {
    CircuitComponent, Wire, SimConfig, DEFAULT_SIM_CONFIG,
} from '../models/circuit.model';

// ═══════════════════════════════════════════════════════════════════
//  File I/O Service
//
//  • Export SPICE netlist (.cir)
//  • Export / Import project file (.nsp — JSON with full layout)
// ═══════════════════════════════════════════════════════════════════

/** On-disk project format */
export interface ProjectFile {
    version: 1;
    components: CircuitComponent[];
    wires: Wire[];
    simConfig: SimConfig;
}

@Injectable({ providedIn: 'root' })
export class FileIoService {

    constructor(private circuit: CircuitService) { }

    // ── Export Netlist ────────────────────────────────────────────

    exportNetlist(): void {
        const netlist = this.circuit.genNetlist();
        this.downloadText(netlist, 'circuit.cir', 'text/plain');
    }

    // ── Export Project ────────────────────────────────────────────

    exportProject(): void {
        const project: ProjectFile = {
            version: 1,
            components: this.circuit.components(),
            wires: this.circuit.wires(),
            simConfig: this.circuit.simConfig(),
        };
        const json = JSON.stringify(project, null, 2);
        this.downloadText(json, 'circuit.nsp', 'application/json');
    }

    // ── Import Project ────────────────────────────────────────────

    /**
     * Open a file picker and load a .nsp project file.
     * Returns a promise that resolves when done. Rejects on bad format.
     */
    importProject(): Promise<void> {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.nsp';
            input.onchange = () => {
                const file = input.files?.[0];
                if (!file) { resolve(); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const raw = JSON.parse(reader.result as string);
                        this.applyProject(raw);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                };
                reader.onerror = () => reject(reader.error);
                reader.readAsText(file);
            };
            input.click();
        });
    }

    // ── Load from URL (for examples) ────────────────────────────

    /**
     * Fetch a .nsp project from a URL and apply it.
     */
    async loadFromUrl(url: string): Promise<void> {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        const raw = await resp.json();
        this.applyProject(raw);
    }

    // ── Internal helpers ──────────────────────────────────────────

    applyProject(raw: unknown): void {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid project file');
        const p = raw as Record<string, unknown>;
        if (p['version'] !== 1) throw new Error(`Unsupported project version: ${p['version']}`);
        if (!Array.isArray(p['components'])) throw new Error('Missing components array');
        if (!Array.isArray(p['wires'])) throw new Error('Missing wires array');

        const components = p['components'] as CircuitComponent[];
        const wires = p['wires'] as Wire[];
        const simConfig = (p['simConfig'] as SimConfig) ?? { ...DEFAULT_SIM_CONFIG };

        // Apply to circuit — replaces entire state
        this.circuit.loadProject(components, wires, simConfig);
    }

    private downloadText(content: string, filename: string, mime: string): void {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
