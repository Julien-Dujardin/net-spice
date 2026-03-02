import {
    Component, ElementRef, input,
    effect, NgZone, OnDestroy, signal,
    AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SimulationResult } from '../../services/ngspice.service';
import { ProbeNode } from '../models/circuit.model';
import { EditorStateService } from '../services/editor-state.service';

declare const uPlot: any;

export type ChartType = 'time' | 'freq';

interface ChartSlot {
    id: string;
    type: ChartType;
    plot: any | null;
}

@Component({
    selector: 'app-charts-panel',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './charts-panel.html',
    styleUrl: './charts-panel.css',
})
export class ChartsPanel implements OnDestroy, AfterViewInit {
    readonly simulationResult = input<SimulationResult | null>(null);

    charts = signal<ChartSlot[]>([]);
    readonly maxCharts = 3;

    private chartIdCounter = 0;
    private resizeObserver: ResizeObserver | null = null;
    private resizeRafId = 0;

    /**
     * Persisted series visibility per chart.
     * Key = chartId, Value = Map<seriesLabel, boolean>.
     * Survives across redraws so toggled-off series stay off.
     */
    private seriesVisibility = new Map<string, Map<string, boolean>>();

    constructor(
        private ngZone: NgZone,
        private state: EditorStateService,
        private hostRef: ElementRef,
    ) {
        // Redraw when simulation data changes
        effect(() => {
            const result = this.simulationResult();
            if (result && this.charts().length > 0) {
                this.ngZone.runOutsideAngular(() =>
                    setTimeout(() => this.drawAllCharts(result), 0)
                );
            }
        });
    }

    ngAfterViewInit(): void {
        this.setupResizeObserver();
    }

    ngOnDestroy(): void {
        this.charts().forEach(c => c.plot?.destroy());
        this.resizeObserver?.disconnect();
        cancelAnimationFrame(this.resizeRafId);
    }

    private setupResizeObserver(): void {
        this.resizeObserver?.disconnect();
        const el = this.hostRef.nativeElement;
        if (!el) return;
        this.resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(this.resizeRafId);
            this.resizeRafId = requestAnimationFrame(() => {
                const result = this.simulationResult();
                if (result && this.charts().length > 0) {
                    this.ngZone.runOutsideAngular(() => this.drawAllCharts(result));
                }
            });
        });
        this.resizeObserver.observe(el);
    }

    // ── Public API ───────────────────────────────────────────────

    canAddChart(): boolean {
        return this.charts().length < this.maxCharts;
    }

    addChart(type: ChartType): void {
        if (!this.canAddChart()) return;
        const id = `chart-${++this.chartIdCounter}`;
        this.charts.update(cs => [...cs, { id, type, plot: null }]);

        setTimeout(() => {
            const result = this.simulationResult();
            if (result) {
                this.ngZone.runOutsideAngular(() => this.drawAllCharts(result));
            }
        }, 0);
    }

    removeChart(chartId: string): void {
        const chart = this.charts().find(c => c.id === chartId);
        chart?.plot?.destroy();
        this.seriesVisibility.delete(chartId);
        this.charts.update(cs => cs.filter(c => c.id !== chartId));
    }

    getTypeLabel(type: ChartType): string {
        return type === 'time' ? 'Time domain' : 'Frequency domain';
    }

    close(): void {
        this.state.toggleChartsPanel();
    }

    // ── Series visibility helpers ────────────────────────────────

    /** Save current plot's series show state. */
    private saveSeriesState(chartId: string, plot: any): void {
        const map = new Map<string, boolean>();
        for (let i = 1; i < plot.series.length; i++) {
            map.set(plot.series[i].label, plot.series[i].show);
        }
        this.seriesVisibility.set(chartId, map);
    }

    /** Restore saved visibility and apply to series defs + initial toggle. */
    private applySeriesState(chartId: string, series: any[]): void {
        const saved = this.seriesVisibility.get(chartId);
        if (!saved) return;
        for (let i = 1; i < series.length; i++) {
            const vis = saved.get(series[i].label);
            if (vis !== undefined) {
                series[i].show = vis;
            }
        }
    }

    /** Install a hook so toggling a series in the legend persists. */
    private installVisibilityHook(chartId: string, plot: any): void {
        plot.hooks.setSeries.push((_u: any, _idx: number) => {
            this.saveSeriesState(chartId, plot);
        });
    }

    // ── Drawing ──────────────────────────────────────────────────

    /** Estimate height taken by the uPlot legend row. */
    private estimateLegendHeight(seriesCount: number): number {
        // ~18px per legend row; assume items wrap at ~6 per row
        return Math.max(20, Math.ceil(seriesCount / 6) * 18 + 4);
    }

    private drawAllCharts(result: SimulationResult): void {
        const gc = '#1c2836';
        const tc = '#4a6070';
        const { transient, currentTransient, fft, currentFft, voltageProbes, currentProbes } = result;

        this.charts().forEach(chart => {
            const el = document.getElementById(`chart-wrapper-${chart.id}`);
            if (!el) return;

            // Save visibility before destroying
            if (chart.plot) {
                this.saveSeriesState(chart.id, chart.plot);
                chart.plot.destroy();
                chart.plot = null;
            }
            el.innerHTML = '';

            const rect = el.getBoundingClientRect();
            const width = Math.max(200, Math.floor(rect.width));
            const totalH = Math.floor(rect.height);

            if (chart.type === 'time') {
                const nSeries = voltageProbes.length + currentProbes.length;
                const legendH = this.estimateLegendHeight(nSeries);
                const plotH = Math.max(80, totalH - legendH);
                this.drawTimeChart(chart, el, width, plotH, transient, currentTransient, voltageProbes, currentProbes, gc, tc);
            } else {
                const nSeries = voltageProbes.length + currentProbes.length;
                const legendH = this.estimateLegendHeight(nSeries);
                const plotH = Math.max(80, totalH - legendH);
                this.drawFreqChart(chart, el, width, plotH, fft, currentFft, voltageProbes, currentProbes, gc, tc);
            }
        });
    }

    private drawTimeChart(
        chart: ChartSlot,
        el: HTMLElement,
        width: number, height: number,
        transient: { x: number[]; cols: number[][] },
        currentTransient: { x: number[]; cols: number[][] },
        voltageProbes: ProbeNode[],
        currentProbes: ProbeNode[],
        gc: string, tc: string,
    ): void {
        const hasV = voltageProbes.length > 0 && transient.x.length > 0;
        const hasI = currentProbes.length > 0 && currentTransient.x.length > 0;
        if (!hasV && !hasI) return;

        const x = hasV ? transient.x : currentTransient.x;
        const series: any[] = [{ label: 'Time (s)' }];
        const data: number[][] = [x];

        // Voltage series (left Y axis, scale "V")
        voltageProbes.forEach((p, i) => {
            series.push({
                label: `${p.label} (V)`,
                stroke: p.color,
                width: 2,
                scale: 'V',
            });
            data.push(transient.cols[i] ?? []);
        });

        // Current series (right Y axis, scale "I")
        currentProbes.forEach((p, i) => {
            series.push({
                label: `${p.label} (A)`,
                stroke: p.color,
                width: 2,
                dash: [6, 3],
                scale: 'I',
            });
            data.push(currentTransient.cols[i] ?? []);
        });

        const axes: any[] = [
            { label: 'Time (s)', stroke: tc, ticks: { stroke: gc }, grid: { stroke: gc } },
        ];
        const scales: any = { x: { time: false } };

        if (hasV) {
            scales['V'] = { auto: true };
            axes.push({
                label: 'Voltage (V)', stroke: tc,
                ticks: { stroke: gc }, grid: { stroke: gc },
                scale: 'V', side: 3,
            });
        }
        if (hasI) {
            scales['I'] = { auto: true };
            axes.push({
                label: 'Current (A)', stroke: tc,
                ticks: { stroke: gc }, grid: { stroke: gc, show: !hasV },
                scale: 'I', side: 1,
            });
        }

        // Restore saved series visibility
        this.applySeriesState(chart.id, series);

        chart.plot = new uPlot({
            width,
            height,
            cursor: { sync: { key: 'time-sync' } },
            scales,
            series,
            axes,
            legend: { live: true },
            hooks: { setSeries: [] },
        }, data, el);

        this.installVisibilityHook(chart.id, chart.plot);
    }

    private drawFreqChart(
        chart: ChartSlot,
        el: HTMLElement,
        width: number, height: number,
        fft: { freqs: number[]; cols: number[][] },
        currentFft: { freqs: number[]; cols: number[][] },
        voltageProbes: ProbeNode[],
        currentProbes: ProbeNode[],
        gc: string, tc: string,
    ): void {
        const hasV = voltageProbes.length > 0 && fft.freqs.length > 2;
        const hasI = currentProbes.length > 0 && currentFft.freqs.length > 2;
        if (!hasV && !hasI) return;

        const freqs = hasV ? fft.freqs : currentFft.freqs;
        const series: any[] = [{ label: 'Freq (Hz)' }];
        const data: number[][] = [freqs];

        voltageProbes.forEach((p, i) => {
            if (i < fft.cols.length) {
                series.push({
                    label: `${p.label} (dB)`,
                    stroke: p.color,
                    width: 2,
                    scale: 'dBV',
                });
                data.push(fft.cols[i]);
            }
        });

        currentProbes.forEach((p, i) => {
            if (i < currentFft.cols.length) {
                series.push({
                    label: `${p.label} (dBA)`,
                    stroke: p.color,
                    width: 2,
                    dash: [6, 3],
                    scale: 'dBI',
                });
                data.push(currentFft.cols[i]);
            }
        });

        const axes: any[] = [
            {
                label: 'Frequency (Hz)', stroke: tc,
                ticks: { stroke: gc }, grid: { stroke: gc },
                values: (_u: any, splits: number[]) => splits.map((v: number) => {
                    if (v <= 0) return '';
                    if (v >= 1e9) return (v / 1e9).toPrecision(3) + 'G';
                    if (v >= 1e6) return (v / 1e6).toPrecision(3) + 'M';
                    if (v >= 1e3) return (v / 1e3).toPrecision(3) + 'k';
                    if (v >= 1) return v.toPrecision(3);
                    return v.toExponential(0);
                }),
            },
        ];
        const scales: any = { x: { time: false, distr: 3 } };

        if (hasV) {
            scales['dBV'] = { auto: true };
            axes.push({
                label: 'Voltage (dB)', stroke: tc,
                ticks: { stroke: gc }, grid: { stroke: gc },
                scale: 'dBV', side: 3,
            });
        }
        if (hasI) {
            scales['dBI'] = { auto: true };
            axes.push({
                label: 'Current (dB)', stroke: tc,
                ticks: { stroke: gc }, grid: { stroke: gc, show: !hasV },
                scale: 'dBI', side: 1,
            });
        }

        // Restore saved series visibility
        this.applySeriesState(chart.id, series);

        chart.plot = new uPlot({
            width,
            height,
            cursor: { sync: { key: 'freq-sync' } },
            scales,
            series,
            axes,
            legend: { live: true },
            hooks: { setSeries: [] },
        }, data, el);

        this.installVisibilityHook(chart.id, chart.plot);
    }
}
