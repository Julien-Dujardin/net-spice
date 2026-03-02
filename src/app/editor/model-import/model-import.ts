import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorStateService } from '../services/editor-state.service';
import {
    GENERIC_COMPONENTS, GenericComponentDef,
    addRuntimeSpecific, parseSpiceModel, guessGenericKey,
} from '../models/component-library';

@Component({
    selector: 'app-model-import',
    standalone: true,
    imports: [FormsModule],
    template: `
    <div class="model-import-overlay" (click)="close()">
        <div class="model-import-panel" (click)="$event.stopPropagation()">
            <!-- Header -->
            <div class="panel-header">
                <span class="panel-title">Import SPICE Model</span>
                <button class="panel-close" (click)="close()">✕</button>
            </div>

            <div class="panel-body">
                <div class="info-text">
                    Paste a <span class="accent">.model</span> or <span class="accent">.subckt</span> block below.
                    The model will be registered as a new specific component.
                </div>

                <!-- SPICE model textarea -->
                <div class="form-field">
                    <label>SPICE Model Definition</label>
                    <textarea
                        [(ngModel)]="modelText"
                        (ngModelChange)="onModelTextChange()"
                        placeholder=".model D1N4148 D(Is=2.52e-9 Rs=0.568 N=1.752 BV=100)&#10;&#10;-- or --&#10;&#10;.subckt MyOpAmp inp inn out vp vn&#10;Rin inp inn 1e12&#10;E1 out 0 inp inn 200000&#10;.ends MyOpAmp"
                        spellcheck="false"
                        rows="8"></textarea>
                </div>

                <!-- Auto-detected info -->
                @if (parsedInfo()) {
                <div class="detected-info">
                    <span class="detected-label">Detected:</span>
                    <span class="detected-value">{{ parsedInfo()!.isSubckt ? '.subckt' : '.model' }}</span>
                    <span class="detected-name">{{ parsedInfo()!.name }}</span>
                    @if (!parsedInfo()!.isSubckt) {
                    <span class="detected-type">({{ parsedInfo()!.type }})</span>
                    }
                </div>
                }

                <!-- Display name -->
                <div class="form-field">
                    <label>Display Name</label>
                    <input [(ngModel)]="displayName" placeholder="e.g. My Custom Diode" />
                </div>

                <!-- Generic type mapping -->
                <div class="form-field">
                    <label>Component Type</label>
                    <select [(ngModel)]="selectedGenericKey">
                        @for (g of genericComponents; track g.key) {
                        <option [value]="g.key">{{ g.symbol }} {{ g.name }}</option>
                        }
                    </select>
                </div>

                <!-- Description -->
                <div class="form-field">
                    <label>Description (optional)</label>
                    <input [(ngModel)]="description" placeholder="Short description" />
                </div>

                <!-- Error message -->
                @if (errorMessage()) {
                <div class="error-msg">{{ errorMessage() }}</div>
                }

                <!-- Success message -->
                @if (successMessage()) {
                <div class="success-msg">{{ successMessage() }}</div>
                }

                <!-- Actions -->
                <div class="actions">
                    <button class="btn-cancel" (click)="close()">Cancel</button>
                    <button class="btn-import" [disabled]="!canImport()" (click)="doImport()">
                        Import Model
                    </button>
                </div>
            </div>
        </div>
    </div>
    `,
    styles: [`
        .model-import-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 500;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fade-in 0.15s ease-out;
        }
        @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
        .model-import-panel {
            width: 520px;
            max-height: 80vh;
            background: var(--color-s1);
            border: 1px solid var(--color-border);
            border-radius: 8px;
            box-shadow: 0 16px 48px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 18px;
            border-bottom: 1px solid var(--color-border);
        }
        .panel-title {
            font-family: var(--font-mono);
            font-size: 0.72rem;
            color: var(--color-text);
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        .panel-close {
            background: transparent;
            border: none;
            color: var(--color-muted);
            cursor: pointer;
            font-size: 14px;
            padding: 4px 8px;
            transition: color 0.15s;
        }
        .panel-close:hover { color: var(--color-text); }
        .panel-body {
            padding: 16px 18px;
            overflow-y: auto;
        }
        .info-text {
            font-family: var(--font-mono);
            font-size: 0.68rem;
            color: var(--color-muted);
            line-height: 1.6;
            margin-bottom: 14px;
        }
        .info-text .accent { color: var(--color-accent); }
        .form-field {
            margin-bottom: 12px;
        }
        .form-field label {
            display: block;
            font-family: var(--font-mono);
            font-size: 0.62rem;
            color: var(--color-muted);
            letter-spacing: 0.06em;
            margin-bottom: 4px;
        }
        .form-field input, .form-field select {
            width: 100%;
            background: var(--color-bg);
            border: 1px solid var(--color-border2);
            border-radius: 4px;
            color: var(--color-text);
            font-family: var(--font-mono);
            font-size: 0.74rem;
            padding: 7px 10px;
            outline: none;
            transition: border-color 0.15s;
        }
        .form-field input:focus, .form-field select:focus {
            border-color: var(--color-accent);
        }
        .form-field select option { background: var(--color-s2); }
        .form-field textarea {
            width: 100%;
            background: var(--color-bg);
            border: 1px solid var(--color-border2);
            border-radius: 4px;
            color: var(--color-accent);
            font-family: var(--font-mono);
            font-size: 0.66rem;
            line-height: 1.5;
            padding: 8px 10px;
            outline: none;
            resize: vertical;
            transition: border-color 0.15s;
        }
        .form-field textarea:focus { border-color: var(--color-accent); }
        .form-field textarea::placeholder { color: var(--color-muted); opacity: 0.4; }
        .detected-info {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: rgba(0,232,144,0.06);
            border: 1px solid rgba(0,232,144,0.2);
            border-radius: 4px;
            margin-bottom: 12px;
            font-family: var(--font-mono);
            font-size: 0.68rem;
        }
        .detected-label { color: var(--color-muted); }
        .detected-value { color: var(--color-accent); }
        .detected-name { color: var(--color-text); font-weight: 600; }
        .detected-type { color: var(--color-muted); }
        .error-msg {
            padding: 8px 10px;
            background: rgba(255,68,68,0.08);
            border: 1px solid rgba(255,68,68,0.3);
            border-radius: 4px;
            color: var(--color-red);
            font-family: var(--font-mono);
            font-size: 0.66rem;
            margin-bottom: 10px;
        }
        .success-msg {
            padding: 8px 10px;
            background: rgba(0,232,144,0.08);
            border: 1px solid rgba(0,232,144,0.3);
            border-radius: 4px;
            color: var(--color-green);
            font-family: var(--font-mono);
            font-size: 0.66rem;
            margin-bottom: 10px;
        }
        .actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 8px;
            padding-top: 12px;
            border-top: 1px solid var(--color-border);
        }
        .btn-cancel, .btn-import {
            font-family: var(--font-mono);
            font-size: 0.68rem;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .btn-cancel {
            background: transparent;
            border: 1px solid var(--color-border2);
            color: var(--color-muted);
        }
        .btn-cancel:hover { color: var(--color-text); border-color: var(--color-text); }
        .btn-import {
            background: var(--color-green);
            border: 1px solid var(--color-green);
            color: var(--color-bg);
        }
        .btn-import:hover:not(:disabled) { box-shadow: 0 0 12px rgba(0,232,144,0.3); }
        .btn-import:disabled { opacity: 0.4; cursor: not-allowed; }
    `],
})
export class ModelImportDialog {
    readonly genericComponents: GenericComponentDef[] = GENERIC_COMPONENTS;

    modelText = '';
    displayName = '';
    selectedGenericKey = 'D';
    description = '';

    readonly parsedInfo = signal<{ name: string; type: string; isSubckt: boolean } | null>(null);
    readonly errorMessage = signal('');
    readonly successMessage = signal('');

    readonly canImport = computed(() => {
        return this.modelText.trim().length > 0 &&
            this.displayName.trim().length > 0 &&
            this.selectedGenericKey.length > 0 &&
            this.parsedInfo() !== null;
    });

    constructor(private state: EditorStateService) { }

    onModelTextChange(): void {
        this.errorMessage.set('');
        this.successMessage.set('');
        const parsed = parseSpiceModel(this.modelText);
        this.parsedInfo.set(parsed);

        if (parsed) {
            // Auto-fill display name from model name
            if (!this.displayName) {
                this.displayName = parsed.name;
            }
            // Auto-detect generic type
            const guessed = guessGenericKey(parsed.type);
            if (guessed) {
                this.selectedGenericKey = guessed;
            }
        }
    }

    doImport(): void {
        const parsed = this.parsedInfo();
        if (!parsed) {
            this.errorMessage.set('Could not parse the model text. Ensure it starts with .model or .subckt');
            return;
        }

        try {
            addRuntimeSpecific({
                partNumber: parsed.name,
                genericKey: this.selectedGenericKey,
                name: this.displayName.trim(),
                spiceModel: this.modelText.trim(),
                modelName: parsed.name,
                description: this.description.trim() || `Imported model: ${parsed.name}`,
            });

            this.successMessage.set(`Model "${parsed.name}" imported successfully as ${this.displayName}`);
            // Reset form after short delay
            setTimeout(() => {
                this.modelText = '';
                this.displayName = '';
                this.description = '';
                this.parsedInfo.set(null);
                this.successMessage.set('');
            }, 2000);
        } catch (err) {
            this.errorMessage.set('Failed to import model: ' + String(err));
        }
    }

    close(): void {
        this.state.closeModelImport();
    }
}
