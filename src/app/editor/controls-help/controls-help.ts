import { Component } from '@angular/core';

@Component({
    selector: 'app-controls-help',
    standalone: true,
    template: `
    <div class="controls-container" [class.collapsed]="collapsed">
        <button class="toggle-btn" (click)="toggle($event)"
                [title]="collapsed ? 'Show controls' : 'Hide controls'">
            {{ collapsed ? '?' : '✕' }}
        </button>
        @if (!collapsed) {
        <div class="help-content">
            <div class="help-title">Keyboard Shortcuts</div>
            <div class="shortcut-grid">
                <div class="shortcut-row">
                    <span class="key">W <span class="azerty">/ Z</span></span>
                    <span class="desc">Wire mode</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">R</span>
                    <span class="desc">Rotate selected</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Space</span>
                    <span class="desc">Rotate selected</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Tab</span>
                    <span class="desc">Toggle bend direction</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Esc</span>
                    <span class="desc">Cancel / Deselect</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Del</span>
                    <span class="desc">Delete selected</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Home</span>
                    <span class="desc">Reset view</span>
                </div>
            </div>
            <div class="help-subtitle">Mouse</div>
            <div class="shortcut-grid">
                <div class="shortcut-row">
                    <span class="key">Scroll</span>
                    <span class="desc">Zoom in / out</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Alt+Drag</span>
                    <span class="desc">Pan canvas</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Mid-click</span>
                    <span class="desc">Pan canvas</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Right-click</span>
                    <span class="desc">Cancel action</span>
                </div>
                <div class="shortcut-row">
                    <span class="key">Dbl-click</span>
                    <span class="desc">Delete wire</span>
                </div>
            </div>
        </div>
        }
    </div>
    `,
    styles: [`
        :host {
            position: absolute;
            bottom: 12px;
            right: 12px;
            z-index: 100;
            pointer-events: none;
        }
        .controls-container {
            pointer-events: auto;
            font-family: var(--font-sans);
            display: flex;
            flex-direction: column;
            align-items: flex-end;
        }
        .toggle-btn {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            background: rgba(12, 17, 24, 0.85);
            border: 1px solid var(--color-border2);
            color: var(--color-muted);
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            flex-shrink: 0;
        }
        .toggle-btn:hover {
            border-color: var(--color-accent);
            color: var(--color-accent);
        }
        .help-content {
            background: var(--color-s1);
            border: 1px solid var(--color-border2);
            border-radius: 8px;
            padding: 12px 14px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            min-width: 230px;
            margin-bottom: 8px;
        }
        .help-title {
            font-size: 0.65rem;
            color: var(--color-accent);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--color-border);
        }
        .help-subtitle {
            font-size: 0.6rem;
            color: var(--color-accent);
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-top: 8px;
            margin-bottom: 4px;
            opacity: 0.7;
        }
        .shortcut-grid {
            display: flex;
            flex-direction: column;
            gap: 3px;
        }
        .shortcut-row {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.62rem;
        }
        .key {
            background: var(--color-s3);
            border: 1px solid var(--color-border2);
            border-radius: 3px;
            padding: 2px 6px;
            color: var(--color-text);
            min-width: 70px;
            text-align: center;
            font-size: 0.6rem;
            white-space: nowrap;
        }
        .azerty {
            color: var(--color-muted);
            font-size: 0.55rem;
        }
        .desc {
            color: var(--color-muted);
        }
        .help-note {
            font-size: 0.55rem;
            color: var(--color-muted);
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid var(--color-border);
            opacity: 0.7;
        }
    `],
})
export class ControlsHelp {
    collapsed = true;

    toggle(e: Event): void {
        e.stopPropagation();
        this.collapsed = !this.collapsed;
    }
}
