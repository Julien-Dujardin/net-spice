import { Injectable } from '@angular/core';
import { ProbeNode, MultiColData } from '../editor/models/circuit.model';

declare const Module: any;
declare let ENV: any;

export interface SimulationResult {
    transient: MultiColData;
    currentTransient: MultiColData;
    fft: { freqs: number[]; cols: number[][] };
    currentFft: { freqs: number[]; cols: number[][] };
    voltageProbes: ProbeNode[];
    currentProbes: ProbeNode[];
    ngspiceMessages: string[];
}

// Global flag to track initialization across service instances
let globalNgspiceInitialized = false;
let globalInitPromise: Promise<void> | null = null;
let ngspiceMessages: string[] = [];

@Injectable({ providedIn: 'root' })
export class NgspiceService {
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;

    constructor() {
        this.initPromise = this.initialize();
    }

    /** Register ngspice callbacks and call ngSpice_Init. */
    private doNgspiceInit(): void {
        try { Module.FS.writeFile('/spinit', '* spinit\n'); } catch (_) { }
        ENV = { SPICE_SCRIPTS: '/' };

        // SendChar callback — captures ngspice stdout/stderr
        const sendCharCb = Module.addFunction((ptr: number, _id: number, _ud: number) => {
            try {
                const msg = Module.UTF8ToString(ptr);
                ngspiceMessages.push(msg);
                console.log('[ngspice]', msg);
            } catch (_) { }
            return 0;
        }, 'iiii');

        const cb4 = Module.addFunction(() => 0, 'iiii');
        const cb5 = Module.addFunction(() => 0, 'iiiii');
        const cb6 = Module.addFunction(() => 0, 'iiiiii');

        Module.ccall(
            'ngSpice_Init', 'number',
            ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
            [sendCharCb, sendCharCb, cb6, cb5, cb4, cb4, 0]
        );
    }

    private async initialize(): Promise<void> {
        if (globalNgspiceInitialized) {
            this.isInitialized = true;
            return Promise.resolve();
        }

        if (globalInitPromise) {
            return globalInitPromise;
        }

        globalInitPromise = new Promise((resolve) => {
            if (typeof Module === 'undefined') {
                console.error('Ngspice module not loaded');
                resolve();
                return;
            }

            if (Module.calledRun) {
                console.log('WebAssembly already initialized — re-initializing ngspice');
                // WASM persists across HMR but JS callbacks are dead → must re-init
                this.doNgspiceInit();
                this.isInitialized = true;
                globalNgspiceInitialized = true;
                resolve();
                return;
            }

            Module.onRuntimeInitialized = () => {
                console.log('WebAssembly ready');
                this.doNgspiceInit();
                this.isInitialized = true;
                globalNgspiceInitialized = true;
                resolve();
            };
        });

        return globalInitPromise;
    }

    async waitForInitialization(): Promise<boolean> {
        if (this.initPromise) {
            await this.initPromise;
        }
        return this.isInitialized;
    }

    /** Get captured ngspice messages (for error reporting) */
    getMessages(): string[] {
        return [...ngspiceMessages];
    }

    /** Safely delete a file from the WASM FS (ignore if missing). */
    private tryUnlink(path: string): void {
        try { Module.FS.unlink(path); } catch (_) { }
    }

    /**
     * Run a full transient + FFT analysis with both voltage and current probes.
     *
     * Voltage and current FFT are done in **separate passes** because mixing
     * `v()` and `i()` expressions in a single `linearize` call can fail in
     * the ngspice WASM build.
     */
    runSimulation(netlist: string, probeNodes: ProbeNode[]): SimulationResult {
        console.log('Netlist:\n' + netlist);
        ngspiceMessages = [];

        const voltageProbes = probeNodes.filter(p => p.type === 'voltage');
        const currentProbes = probeNodes.filter(p => p.type === 'current');
        const totalProbes = probeNodes.length;

        // Clean up previous simulation state & output files
        this.tryUnlink('/tran.txt');
        this.tryUnlink('/fft_v.txt');
        this.tryUnlink('/fft_i.txt');
        this.tryUnlink('/circuit.cir');

        Module.FS.writeFile('/circuit.cir', netlist);

        // Reset ngspice state before loading new circuit
        Module.ccall('ngSpice_Command', 'number', ['string'], ['destroy all']);
        Module.ccall('ngSpice_Command', 'number', ['string'], ['source /circuit.cir']);
        Module.ccall('ngSpice_Command', 'number', ['string'], ['run']);

        // Check if ngspice hit a fatal error during source/run
        const hasFatal = ngspiceMessages.some(m =>
            m.includes('cannot recover') || m.includes('Cannot compute substitute')
        );
        if (hasFatal) {
            console.warn('ngspice fatal error detected — re-initializing engine');
            this.doNgspiceInit();
            return {
                transient: { x: [], cols: [] },
                currentTransient: { x: [], cols: [] },
                fft: { freqs: [], cols: [] },
                currentFft: { freqs: [], cols: [] },
                voltageProbes,
                currentProbes,
                ngspiceMessages: [...ngspiceMessages],
            };
        }

        // ── Build node-reference strings ──────────────────────────
        const vArgs = voltageProbes.map(p => `v(${p.node.toLowerCase()})`);
        const iArgs = currentProbes.map(p => `i(${p.node.toLowerCase()})`);
        const allArgs = [...vArgs, ...iArgs].join(' ');

        // ── Transient data (combined — wrdata handles expressions) ─
        let allTranData: MultiColData = { x: [], cols: [] };
        if (totalProbes > 0) {
            Module.ccall('ngSpice_Command', 'number', ['string'], [`wrdata /tran.txt ${allArgs}`]);
            try {
                allTranData = this.parseMultiCol(
                    Module.FS.readFile('/tran.txt', { encoding: 'utf8' }),
                    totalProbes,
                );
            } catch (e) {
                console.warn('Could not read transient data:', e);
            }
        }

        // ── Voltage FFT (linearize → fft → wrdata) ───────────────
        let vFftData: MultiColData = { x: [], cols: [] };
        if (voltageProbes.length > 0) {
            const vJoined = vArgs.join(' ');
            Module.ccall('ngSpice_Command', 'number', ['string'], [`linearize ${vJoined}`]);
            Module.ccall('ngSpice_Command', 'number', ['string'], [`fft ${vJoined}`]);
            const vFftWr = voltageProbes.map(p => `db(v(${p.node.toLowerCase()}))`).join(' ');
            Module.ccall('ngSpice_Command', 'number', ['string'], [`wrdata /fft_v.txt ${vFftWr}`]);
            try {
                vFftData = this.parseMultiCol(
                    Module.FS.readFile('/fft_v.txt', { encoding: 'utf8' }),
                    voltageProbes.length,
                );
            } catch (e) {
                console.warn('Could not read voltage FFT data:', e);
            }
        }

        // ── Current FFT (separate pass — go back to tran plot) ────
        let iFftData: MultiColData = { x: [], cols: [] };
        if (currentProbes.length > 0) {
            // After the voltage FFT the active plot is "spec"; switch back to tran.
            Module.ccall('ngSpice_Command', 'number', ['string'], ['setplot tran1']);
            const iJoined = iArgs.join(' ');
            Module.ccall('ngSpice_Command', 'number', ['string'], [`linearize ${iJoined}`]);
            Module.ccall('ngSpice_Command', 'number', ['string'], [`fft ${iJoined}`]);
            const iFftWr = currentProbes.map(p => `db(i(${p.node.toLowerCase()}))`).join(' ');
            Module.ccall('ngSpice_Command', 'number', ['string'], [`wrdata /fft_i.txt ${iFftWr}`]);
            try {
                iFftData = this.parseMultiCol(
                    Module.FS.readFile('/fft_i.txt', { encoding: 'utf8' }),
                    currentProbes.length,
                );
            } catch (e) {
                console.warn('Could not read current FFT data:', e);
            }
        }

        // ── Split tran data into voltage / current columns ────────
        const vCount = voltageProbes.length;
        const tranData: MultiColData = {
            x: allTranData.x,
            cols: allTranData.cols.slice(0, vCount),
        };
        const currentTranData: MultiColData = {
            x: allTranData.x,
            cols: allTranData.cols.slice(vCount),
        };

        // ── Positive frequencies for voltage FFT ──────────────────
        const vfIdx = vFftData.x.map((_, i) => i).filter(i => vFftData.x[i] > 0);
        const vfFreqs = vfIdx.map(i => vFftData.x[i]);
        const vFftCols = vFftData.cols.map(col => vfIdx.map(i => col[i]));

        // ── Positive frequencies for current FFT ──────────────────
        const ifIdx = iFftData.x.map((_, i) => i).filter(i => iFftData.x[i] > 0);
        const ifFreqs = ifIdx.map(i => iFftData.x[i]);
        const iFftCols = iFftData.cols.map(col => ifIdx.map(i => col[i]));

        return {
            transient: tranData,
            currentTransient: currentTranData,
            fft: { freqs: vfFreqs, cols: vFftCols },
            currentFft: { freqs: ifFreqs, cols: iFftCols },
            voltageProbes,
            currentProbes,
            ngspiceMessages: [...ngspiceMessages],
        };
    }

    private parseMultiCol(text: string, n: number): MultiColData {
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
