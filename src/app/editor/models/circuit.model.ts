// ═══════════════════════════════════════════════════════════════════
//  SPICE Circuit Data Models
//  LTspice-style: connections by grid-point coincidence, not by
//  explicit endpoint references.  Junction dots are computed, not
//  stored.
// ═══════════════════════════════════════════════════════════════════

/** Built-in primitive types */
export type BuiltinComponentType = 'R' | 'C' | 'L' | 'V' | 'GND' | 'PROBE' | 'IPROBE' | 'NET_IN' | 'NET_OUT' | 'NET_INOUT';
/** Library component types (semiconductors, op-amps, etc.) */
export type LibraryComponentType = 'D' | 'Q_NPN' | 'Q_PNP' | 'M_NMOS' | 'M_PMOS' | 'OPAMP' | 'OPAMP3';
/** All component types */
export type ComponentType = BuiltinComponentType | LibraryComponentType;

export type ProbeType = 'voltage' | 'current';

export interface VoltageSourceProps {
    waveform: 'SIN' | 'PULSE' | 'DC' | 'NOISE';
    amp: string;
    freq: string;
    offset: string;
    dc: string;
    pulse_v1: string;
    pulse_v2: string;
    pulse_td: string;
    pulse_tr: string;
    pulse_tf: string;
    pulse_pw: string;
    pulse_per: string;
}

export interface PassiveProps {
    value: string;
}

export interface LibraryComponentProps {
    /** SPICE model name (e.g. 'D1N4148', 'Q2N2222') */
    model: string;
    /** Specific part number if a real-world part was selected */
    partNumber?: string;
    /** MOSFET W parameter */
    w?: string;
    /** MOSFET L parameter */
    l?: string;
}

export interface ProbeProps {
    label: string;
    probeColor: string;
}

export type ComponentProps = Partial<VoltageSourceProps> & Partial<PassiveProps> & Partial<ProbeProps> & Partial<LibraryComponentProps> & {
    /** Custom SPICE name override (e.g. 'BV1' instead of auto 'V_v1') */
    name?: string;
    /** Raw SPICE line override — if set, replaces the auto-generated line entirely */
    spiceLine?: string;
    /** Custom .model/.subckt text — overrides auto-generated model definition */
    customModel?: string;
};

export interface CircuitComponent {
    id: string;
    type: ComponentType;
    x: number;
    y: number;
    rotation: number;
    props: ComponentProps;
}

// ── Geometry ────────────────────────────────────────────────────

export interface Point {
    x: number;
    y: number;
}

// ── Wire ────────────────────────────────────────────────────────
// A wire is a simple polyline of grid-snapped orthogonal segments.
// Electrical connections are determined purely by coordinate
// coincidence: if a wire vertex and a component pin (or another
// wire vertex) share the same grid point they belong to the same
// net.  No explicit "from/to" references are needed.

export interface Wire {
    id: string;
    points: Point[];   // ≥ 2 grid-snapped points — each consecutive pair is a segment
}

// ── Ports ────────────────────────────────────────────────────────

export interface RelativePort {
    key: string;
    rx: number;
    ry: number;
}

export interface AbsolutePort {
    key: string;
    x: number;
    y: number;
}

export interface PortRef {
    cid: string;
    port: string;
    x: number;
    y: number;
}

// ── Simulation ──────────────────────────────────────────────────

export type AnalysisType = 'tran' | 'ac' | 'dc' | 'op';

export interface TranConfig {
    stopTime: string;   // e.g. '10m'
    step: string;       // e.g. '1u' — max timestep
    startSave: string;  // e.g. '0'
    uic: boolean;       // Use Initial Conditions
}

export interface AcConfig {
    variation: 'dec' | 'oct' | 'lin';
    npoints: string;    // number of points
    fstart: string;
    fstop: string;
}

export interface DcConfig {
    source: string;     // voltage source name (e.g. 'V_v1')
    start: string;
    stop: string;
    step: string;
}

export interface SimConfig {
    type: AnalysisType;
    tran: TranConfig;
    ac: AcConfig;
    dc: DcConfig;
    customDirectives: string;  // free text SPICE directives
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
    type: 'tran',
    tran: { stopTime: '10m', step: '1u', startSave: '0', uic: false },
    ac: { variation: 'dec', npoints: '100', fstart: '1', fstop: '1Meg' },
    dc: { source: '', start: '0', stop: '5', step: '0.1' },
    customDirectives: '',
};

export interface ProbeNode {
    node: string;
    label: string;
    color: string;
    type: ProbeType;
}

export interface MultiColData {
    x: number[];
    cols: number[][];
}

// ── Constants ───────────────────────────────────────────────────

export const GRID = 20;

export const PROBE_COLORS = ['#ffe04b', '#ff6bb5', '#a8ff6b', '#ff9e6b', '#6bc1ff', '#ff6b6b', '#6bffb3', '#4945c5'];

export const TYPE_COLOR: Record<string, string> = {
    R: '#ff8c00',
    C: '#00c8f0',
    L: '#ffd060',
    V: '#b388ff',
    GND: '#4a6070',
    PROBE: '#ffe04b',
    IPROBE: '#ff6bb5',
    D: '#ff4444',
    Q_NPN: '#4fc3f7',
    Q_PNP: '#ce93d8',
    M_NMOS: '#4fc3f7',
    M_PMOS: '#ce93d8',
    OPAMP: '#69f0ae',
    OPAMP3: '#69f0ae',
    NET_IN: '#4dd0e1',
    NET_OUT: '#4dd0e1',
    NET_INOUT: '#4dd0e1',
};

export const TYPE_NAMES: Record<string, string> = {
    R: 'Resistor',
    C: 'Capacitor',
    L: 'Inductor',
    V: 'Voltage Source',
    GND: 'Ground',
    PROBE: 'Voltage Probe',
    IPROBE: 'Current Probe',
    D: 'Diode',
    Q_NPN: 'NPN Transistor',
    Q_PNP: 'PNP Transistor',
    M_NMOS: 'NMOS Transistor',
    M_PMOS: 'PMOS Transistor',
    OPAMP: 'Op-Amp',
    OPAMP3: 'Op-Amp (Ideal)',
    NET_IN: 'Net In',
    NET_OUT: 'Net Out',
    NET_INOUT: 'Net In/Out',
};

export const COMPONENT_DEFAULTS: Record<string, ComponentProps> = {
    R: { value: '1k' },
    C: { value: '1u' },
    L: { value: '10m' },
    V: {
        waveform: 'SIN', amp: '5', freq: '1000', offset: '0', dc: '5',
        pulse_v1: '0', pulse_v2: '5', pulse_td: '0', pulse_tr: '1u',
        pulse_tf: '1u', pulse_pw: '0.5m', pulse_per: '1m',
    },
    GND: {},
    PROBE: { label: '' },
    IPROBE: { label: '' },
    D: { model: 'DMOD' },
    Q_NPN: { model: 'NMOD' },
    Q_PNP: { model: 'PMOD' },
    M_NMOS: { model: 'NMOSMOD', w: '10u', l: '1u' },
    M_PMOS: { model: 'PMOSMOD', w: '10u', l: '1u' },
    OPAMP: { model: 'OPAMP_IDEAL' },
    OPAMP3: { model: 'OPAMP3_IDEAL' },
    NET_IN: { label: '' },
    NET_OUT: { label: '' },
    NET_INOUT: { label: '' },
};
