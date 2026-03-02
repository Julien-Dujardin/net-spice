import { Component } from '@angular/core';
import { EditorStateService } from '../services/editor-state.service';

@Component({
    selector: 'app-tooltip',
    standalone: true,
    template: `
    @if (state.tooltipVisible()) {
      <div class="tooltip"
           [style.left.px]="state.tooltipX()"
           [style.top.px]="state.tooltipY()">
        {{ state.tooltipText() }}
      </div>
    }
  `,
    styles: [`
    .tooltip {
      position: fixed;
      background: var(--color-s3);
      border: 1px solid var(--color-accent);
      border-radius: 4px;
      padding: 4px 9px;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--color-accent);
      pointer-events: none;
      z-index: 200;
    }
  `],
})
export class Tooltip {
    constructor(protected state: EditorStateService) { }
}
