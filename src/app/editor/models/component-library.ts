// ═══════════════════════════════════════════════════════════════════
//  Component Library — Data-driven SPICE component definitions
//
//  Architecture:
//  ─────────────
//  • GenericComponent  = a schematic symbol category (e.g. "Diode",
//    "Op-Amp", "NPN Transistor"). Defines the drawing, ports, and
//    default SPICE parameters.
//  • SpecificComponent = a real-world part that maps to a generic
//    type, with pre-filled SPICE model lines (e.g. "1N4148" is a
//    specific Diode, "TL072" is a specific Op-Amp).
//
//  To add a new component:
//  1. Add a GenericComponent entry in GENERIC_COMPONENTS
//  2. Optionally add SpecificComponent entries in SPECIFIC_COMPONENTS
//  3. The rest (canvas drawing, header menu, properties panel,
//     netlist generation) is handled automatically.
//
//  Data sources:
//  The SPICE model lines come from open-source libraries and
//  manufacturer datasheets. You can expand the collection by
//  adding entries to SPECIFIC_COMPONENTS — no new files needed.
// ═══════════════════════════════════════════════════════════════════

// ── Category for organizing the "Components" menu ────────────────

export type ComponentCategory =
    | 'Semiconductors'
    | 'Amplifiers'
    | 'Logic'
    | 'Sources'
    | 'Passive';

// ── Generic Component Definition ─────────────────────────────────

export interface GenericComponentDef {
    /** Internal key used as ComponentType extension, e.g. 'D', 'Q_NPN', 'OPAMP' */
    key: string;
    /** Display name, e.g. 'Diode', 'NPN Transistor' */
    name: string;
    /** Category for menu grouping */
    category: ComponentCategory;
    /** Symbol character/emoji for header button */
    symbol: string;
    /** Color for schematic drawing */
    color: string;
    /** Pin definitions (relative to component origin) */
    ports: { key: string; rx: number; ry: number }[];
    /** Bounding box for hit detection */
    bounds: { x: number; y: number; w: number; h: number };
    /** SPICE prefix letter (D, Q, X, etc.) */
    spicePrefix: string;
    /** Default SPICE model directive to include (if any) */
    defaultModel?: string;
    /** Default SPICE model name reference */
    defaultModelName?: string;
    /** Default component properties */
    defaultProps: Record<string, string>;
    /** Short description for tooltip */
    description: string;
    /** Editable simulation parameters shown in properties panel */
    editableParams?: EditableParam[];
    /** SPICE model type for .model directive (e.g. 'D', 'NPN', 'NMOS'). Undefined for subcircuit types. */
    spiceModelType?: string;
}

// ── Editable Simulation Parameters ───────────────────────────────

export interface EditableParam {
    /** SPICE parameter key (e.g. 'Is', 'Bf', 'Vto') */
    key: string;
    /** Display label */
    label: string;
    /** Unit hint (e.g. 'A', 'V', 'Ω') */
    unit?: string;
    /** Default value as string */
    defaultValue: string;
    /** Short tooltip description */
    tooltip?: string;
}

// ── Specific (Real-World) Component Definition ───────────────────

export interface SpecificComponentDef {
    /** Unique ID, e.g. '1N4148', 'TL072' */
    partNumber: string;
    /** Which generic component this instantiates */
    genericKey: string;
    /** Human-readable name */
    name: string;
    /** Manufacturer (optional) */
    manufacturer?: string;
    /** Complete SPICE .model or .subckt line(s) */
    spiceModel: string;
    /** The model name to reference in the component line */
    modelName: string;
    /** Override default props if needed */
    propsOverride?: Record<string, string>;
    /** Short description */
    description: string;
    /** Optional datasheet URL */
    datasheetUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════
//  GENERIC COMPONENTS LIBRARY
// ═══════════════════════════════════════════════════════════════════

export const GENERIC_COMPONENTS: GenericComponentDef[] = [
    // ── Semiconductors ───────────────────────────────────────────
    {
        key: 'D',
        name: 'Diode',
        category: 'Semiconductors',
        symbol: '▷|',
        color: '#ff4444',
        ports: [
            { key: 'a', rx: -40, ry: 0 },  // anode
            { key: 'k', rx: 40, ry: 0 },   // cathode
        ],
        bounds: { x: -44, y: -14, w: 88, h: 28 },
        spicePrefix: 'D',
        defaultModelName: 'DMOD',
        defaultModel: '.model DMOD D',
        defaultProps: { model: 'DMOD' },
        description: 'Generic diode — add a specific model or use the default',
        editableParams: [
            { key: 'Is', label: 'Saturation Current', unit: 'A', defaultValue: '1e-14', tooltip: 'Reverse bias saturation current' },
            { key: 'N', label: 'Emission Coefficient', defaultValue: '1', tooltip: 'Emission coefficient (ideality factor)' },
            { key: 'Rs', label: 'Series Resistance', unit: 'Ω', defaultValue: '0', tooltip: 'Ohmic series resistance' },
            { key: 'BV', label: 'Breakdown Voltage', unit: 'V', defaultValue: '100', tooltip: 'Reverse breakdown voltage' },
            { key: 'Cjo', label: 'Junction Capacitance', unit: 'F', defaultValue: '0', tooltip: 'Zero-bias junction capacitance' },
            { key: 'tt', label: 'Transit Time', unit: 's', defaultValue: '0', tooltip: 'Forward-bias depletion capacitance transit time' },
        ],
        spiceModelType: 'D',
    },
    {
        key: 'Q_NPN',
        name: 'NPN Transistor',
        category: 'Semiconductors',
        symbol: 'Qn',
        color: '#4fc3f7',
        ports: [
            { key: 'c', rx: 0, ry: -40 },  // collector (top)
            { key: 'b', rx: -40, ry: 0 },   // base (left)
            { key: 'e', rx: 0, ry: 40 },    // emitter (bottom)
        ],
        bounds: { x: -44, y: -44, w: 60, h: 88 },
        spicePrefix: 'Q',
        defaultModelName: 'NMOD',
        defaultModel: '.model NMOD NPN',
        defaultProps: { model: 'NMOD' },
        description: 'NPN bipolar junction transistor',
        editableParams: [
            { key: 'Bf', label: 'Forward Current Gain (β)', defaultValue: '100', tooltip: 'Ideal maximum forward beta' },
            { key: 'Is', label: 'Saturation Current', unit: 'A', defaultValue: '1e-16', tooltip: 'Transport saturation current' },
            { key: 'Vaf', label: 'Forward Early Voltage', unit: 'V', defaultValue: '100', tooltip: 'Forward Early voltage (VA)' },
            { key: 'Rb', label: 'Base Resistance', unit: 'Ω', defaultValue: '10', tooltip: 'Zero-bias base resistance' },
            { key: 'Cje', label: 'B-E Capacitance', unit: 'F', defaultValue: '0', tooltip: 'Base-emitter zero-bias capacitance' },
            { key: 'Cjc', label: 'B-C Capacitance', unit: 'F', defaultValue: '0', tooltip: 'Base-collector zero-bias capacitance' },
        ],
        spiceModelType: 'NPN',
    },
    {
        key: 'Q_PNP',
        name: 'PNP Transistor',
        category: 'Semiconductors',
        symbol: 'Qp',
        color: '#ce93d8',
        ports: [
            { key: 'c', rx: 0, ry: 40 },   // collector (bottom)
            { key: 'b', rx: -40, ry: 0 },   // base (left)
            { key: 'e', rx: 0, ry: -40 },   // emitter (top)
        ],
        bounds: { x: -44, y: -44, w: 60, h: 88 },
        spicePrefix: 'Q',
        defaultModelName: 'PMOD',
        defaultModel: '.model PMOD PNP',
        defaultProps: { model: 'PMOD' },
        description: 'PNP bipolar junction transistor',
        editableParams: [
            { key: 'Bf', label: 'Forward Current Gain (β)', defaultValue: '100', tooltip: 'Ideal maximum forward beta' },
            { key: 'Is', label: 'Saturation Current', unit: 'A', defaultValue: '1e-16', tooltip: 'Transport saturation current' },
            { key: 'Vaf', label: 'Forward Early Voltage', unit: 'V', defaultValue: '100', tooltip: 'Forward Early voltage (VA)' },
            { key: 'Rb', label: 'Base Resistance', unit: 'Ω', defaultValue: '10', tooltip: 'Zero-bias base resistance' },
        ],
        spiceModelType: 'PNP',
    },
    {
        key: 'M_NMOS',
        name: 'NMOS Transistor',
        category: 'Semiconductors',
        symbol: 'Mn',
        color: '#4fc3f7',
        ports: [
            { key: 'd', rx: 0, ry: -40 },  // drain (top)
            { key: 'g', rx: -40, ry: 0 },   // gate (left)
            { key: 's', rx: 0, ry: 40 },    // source (bottom)
        ],
        bounds: { x: -44, y: -44, w: 60, h: 88 },
        spicePrefix: 'M',
        defaultModelName: 'NMOSMOD',
        defaultModel: '.model NMOSMOD NMOS',
        defaultProps: { model: 'NMOSMOD', w: '10u', l: '1u' },
        description: 'N-channel MOSFET',
        editableParams: [
            { key: 'Vto', label: 'Threshold Voltage', unit: 'V', defaultValue: '0.7', tooltip: 'Zero-bias threshold voltage' },
            { key: 'Kp', label: 'Transconductance', unit: 'A/V²', defaultValue: '2e-5', tooltip: 'Transconductance parameter' },
            { key: 'Lambda', label: 'Channel Modulation', unit: 'V⁻¹', defaultValue: '0', tooltip: 'Channel-length modulation' },
        ],
        spiceModelType: 'NMOS',
    },
    {
        key: 'M_PMOS',
        name: 'PMOS Transistor',
        category: 'Semiconductors',
        symbol: 'Mp',
        color: '#ce93d8',
        ports: [
            { key: 'd', rx: 0, ry: 40 },   // drain (bottom)
            { key: 'g', rx: -40, ry: 0 },   // gate (left)
            { key: 's', rx: 0, ry: -40 },   // source (top)
        ],
        bounds: { x: -44, y: -44, w: 60, h: 88 },
        spicePrefix: 'M',
        defaultModelName: 'PMOSMOD',
        defaultModel: '.model PMOSMOD PMOS',
        defaultProps: { model: 'PMOSMOD', w: '10u', l: '1u' },
        description: 'P-channel MOSFET',
        editableParams: [
            { key: 'Vto', label: 'Threshold Voltage', unit: 'V', defaultValue: '-0.7', tooltip: 'Zero-bias threshold voltage' },
            { key: 'Kp', label: 'Transconductance', unit: 'A/V²', defaultValue: '2e-5', tooltip: 'Transconductance parameter' },
            { key: 'Lambda', label: 'Channel Modulation', unit: 'V⁻¹', defaultValue: '0', tooltip: 'Channel-length modulation' },
        ],
        spiceModelType: 'PMOS',
    },

    // ── Amplifiers ───────────────────────────────────────────────
    {
        key: 'OPAMP',
        name: 'Op-Amp',
        category: 'Amplifiers',
        symbol: '△',
        color: '#69f0ae',
        ports: [
            { key: 'inp', rx: -40, ry: -20 },   // non-inverting input (+)
            { key: 'inn', rx: -40, ry: 20 },     // inverting input (−)
            { key: 'out', rx: 40, ry: 0 },       // output
            { key: 'vp', rx: 0, ry: -40 },       // V+ supply
            { key: 'vn', rx: 0, ry: 40 },        // V− supply
        ],
        bounds: { x: -44, y: -44, w: 88, h: 88 },
        spicePrefix: 'X',
        defaultModelName: 'OPAMP_IDEAL',
        defaultModel:
            '* Ideal op-amp subcircuit\n' +
            '.subckt OPAMP_IDEAL inp inn out vp vn\n' +
            'E1 out 0 inp inn 1e6\n' +
            '.ends OPAMP_IDEAL',
        defaultProps: { model: 'OPAMP_IDEAL' },
        description: 'Operational amplifier — use a specific model (TL072, LM741…) or ideal',
        editableParams: [
            { key: 'Aol', label: 'Open-Loop Gain', defaultValue: '1e6', tooltip: 'DC open-loop voltage gain' },
            { key: 'Rin', label: 'Input Resistance', unit: 'Ω', defaultValue: '1e12', tooltip: 'Differential input resistance' },
            { key: 'Rout', label: 'Output Resistance', unit: 'Ω', defaultValue: '75', tooltip: 'Output resistance' },
        ],
    },
    {
        key: 'OPAMP3',
        name: 'Op-Amp (Ideal)',
        category: 'Amplifiers',
        symbol: '▽',
        color: '#69f0ae',
        ports: [
            { key: 'inp', rx: -40, ry: -20 },   // non-inverting input (+)
            { key: 'inn', rx: -40, ry: 20 },     // inverting input (−)
            { key: 'out', rx: 40, ry: 0 },       // output
        ],
        bounds: { x: -44, y: -34, w: 88, h: 68 },
        spicePrefix: 'X',
        defaultModelName: 'OPAMP3_IDEAL',
        defaultModel:
            '* Ideal 3-pin op-amp (infinite energy)\n' +
            '.subckt OPAMP3_IDEAL inp inn out\n' +
            'E1 out 0 inp inn 1e6\n' +
            '.ends OPAMP3_IDEAL',
        defaultProps: { model: 'OPAMP3_IDEAL' },
        description: '3-pin ideal op-amp — no supply rails, automatic infinite energy',
        editableParams: [
            { key: 'Aol', label: 'Open-Loop Gain', defaultValue: '1e6', tooltip: 'DC open-loop voltage gain' },
        ],
    },
];

// ═══════════════════════════════════════════════════════════════════
//  SPECIFIC (REAL-WORLD) COMPONENTS
//  These reference a generic key and provide a real SPICE model.
//  To add more parts, just append to this array.
// ═══════════════════════════════════════════════════════════════════

export const SPECIFIC_COMPONENTS: SpecificComponentDef[] = [];

// ═══════════════════════════════════════════════════════════════════
//  Lookup Helpers
// ═══════════════════════════════════════════════════════════════════

const _genericMap = new Map<string, GenericComponentDef>();
GENERIC_COMPONENTS.forEach(g => _genericMap.set(g.key, g));

const _specificByGeneric = new Map<string, SpecificComponentDef[]>();
SPECIFIC_COMPONENTS.forEach(s => {
    const list = _specificByGeneric.get(s.genericKey) || [];
    list.push(s);
    _specificByGeneric.set(s.genericKey, list);
});

/** Get a generic component definition by key. */
export function getGenericDef(key: string): GenericComponentDef | undefined {
    return _genericMap.get(key);
}

/** Get all specific components for a given generic key. */
export function getSpecificsForGeneric(genericKey: string): SpecificComponentDef[] {
    return _specificByGeneric.get(genericKey) || [];
}

/** Get all generic components grouped by category. */
export function getComponentsByCategory(): Map<ComponentCategory, GenericComponentDef[]> {
    const map = new Map<ComponentCategory, GenericComponentDef[]>();
    GENERIC_COMPONENTS.forEach(g => {
        const list = map.get(g.category) || [];
        list.push(g);
        map.set(g.category, list);
    });
    return map;
}

/** Get a specific component by part number. */
export function getSpecificDef(partNumber: string): SpecificComponentDef | undefined {
    return SPECIFIC_COMPONENTS.find(s => s.partNumber === partNumber);
}

/** Check if a ComponentType key belongs to the library (not a built-in). */
export function isLibraryComponent(type: string): boolean {
    return _genericMap.has(type);
}

/** Get all library component type keys. */
export function getLibraryTypeKeys(): string[] {
    return GENERIC_COMPONENTS.map(g => g.key);
}

// ═══════════════════════════════════════════════════════════════════
//  Custom Model Generation
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a custom .model or .subckt directive from user-edited sim params.
 * Returns null if no params differ from defaults (use generic default model).
 */
export function buildCustomModelDirective(
    def: GenericComponentDef,
    modelName: string,
    simParams: Record<string, string>,
): string | null {
    if (!def.editableParams || def.editableParams.length === 0) return null;

    // Collect params that have been changed from defaults
    const parts: string[] = [];
    for (const p of def.editableParams) {
        const val = simParams[p.key];
        if (val !== undefined && val !== '' && val !== p.defaultValue) {
            parts.push(`${p.key}=${val}`);
        }
    }
    if (parts.length === 0) return null;

    // .model types: D, NPN, PNP, NMOS, PMOS
    if (def.spiceModelType) {
        return `.model ${modelName} ${def.spiceModelType}(${parts.join(' ')})`;
    }

    // Subcircuit types: OPAMP (5-pin), OPAMP3 (3-pin)
    if (def.key === 'OPAMP') {
        const aol = simParams['Aol'] || '1e6';
        const rin = simParams['Rin'] || '1e12';
        const rout = simParams['Rout'] || '75';
        return [
            `.subckt ${modelName} inp inn out vp vn`,
            `Rin inp inn ${rin}`,
            `E1 mid 0 inp inn ${aol}`,
            `R1 mid out ${rout}`,
            `.ends ${modelName}`,
        ].join('\n');
    }
    if (def.key === 'OPAMP3') {
        const aol = simParams['Aol'] || '1e6';
        return [
            `.subckt ${modelName} inp inn out`,
            `E1 out 0 inp inn ${aol}`,
            `.ends ${modelName}`,
        ].join('\n');
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  Runtime Model Import
// ═══════════════════════════════════════════════════════════════════

/**
 * Add a user-imported model as a runtime SpecificComponent.
 * It immediately becomes available in the Components menu.
 */
export function addRuntimeSpecific(def: SpecificComponentDef): void {
    SPECIFIC_COMPONENTS.push(def);
    const list = _specificByGeneric.get(def.genericKey) || [];
    list.push(def);
    _specificByGeneric.set(def.genericKey, list);
}

/**
 * Parse a SPICE model text and extract metadata.
 * Returns { name, type, isSubckt } or null if unrecognized.
 */
export function parseSpiceModel(text: string): { name: string; type: string; isSubckt: boolean } | null {
    const trimmed = text.trim();
    // Match .subckt NAME ...
    const subcktMatch = trimmed.match(/^\.subckt\s+(\S+)/im);
    if (subcktMatch) {
        return { name: subcktMatch[1], type: 'subckt', isSubckt: true };
    }
    // Match .model NAME TYPE(...)
    const modelMatch = trimmed.match(/^\.model\s+(\S+)\s+(\S+)/im);
    if (modelMatch) {
        return { name: modelMatch[1], type: modelMatch[2].toUpperCase(), isSubckt: false };
    }
    return null;
}

/**
 * Guess which generic component key a SPICE model type maps to.
 */
export function guessGenericKey(spiceType: string): string | null {
    const t = spiceType.toUpperCase();
    if (t === 'D') return 'D';
    if (t === 'NPN') return 'Q_NPN';
    if (t === 'PNP') return 'Q_PNP';
    if (t === 'NMOS') return 'M_NMOS';
    if (t === 'PMOS') return 'M_PMOS';
    if (t === 'SUBCKT') return 'OPAMP'; // default guess for subcircuits
    return null;
}
