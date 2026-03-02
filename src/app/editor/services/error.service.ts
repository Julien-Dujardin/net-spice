import { Injectable, signal, computed } from '@angular/core';

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface NetlistError {
    id: string;
    severity: ErrorSeverity;
    message: string;
    componentId?: string;
    line?: number;
    detail?: string;
}

@Injectable({ providedIn: 'root' })
export class ErrorService {
    readonly errors = signal<NetlistError[]>([]);

    readonly hasErrors = computed(() =>
        this.errors().some(e => e.severity === 'error'));

    readonly errorCount = computed(() =>
        this.errors().filter(e => e.severity === 'error').length);

    readonly warningCount = computed(() =>
        this.errors().filter(e => e.severity === 'warning').length);

    readonly errorsVisible = signal(false);

    clear(): void {
        this.errors.set([]);
    }

    addError(error: Omit<NetlistError, 'id'>): void {
        const id = 'err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        this.errors.update(es => [...es, { ...error, id }]);
    }

    setErrors(errors: NetlistError[]): void {
        this.errors.set(errors);
    }

    toggleVisible(): void {
        this.errorsVisible.set(!this.errorsVisible());
    }

    /** Parse ngspice console output for error/warning messages */
    parseNgspiceOutput(messages: string[]): NetlistError[] {
        const errors: NetlistError[] = [];
        let counter = 0;

        for (const msg of messages) {
            const lower = msg.toLowerCase();

            if (lower.includes('error') && !lower.includes('error count')) {
                errors.push({
                    id: `ngspice_err_${counter++}`,
                    severity: 'error',
                    message: msg.trim(),
                    detail: 'ngspice runtime error',
                });
            } else if (lower.includes('warning')) {
                errors.push({
                    id: `ngspice_warn_${counter++}`,
                    severity: 'warning',
                    message: msg.trim(),
                    detail: 'ngspice runtime warning',
                });
            } else if (lower.includes('singular matrix')) {
                errors.push({
                    id: `ngspice_sing_${counter++}`,
                    severity: 'error',
                    message: 'Singular matrix — circuit may have short circuits or floating nodes',
                    detail: msg.trim(),
                });
            } else if (lower.includes('no convergence')) {
                errors.push({
                    id: `ngspice_conv_${counter++}`,
                    severity: 'error',
                    message: 'Simulation did not converge',
                    detail: msg.trim(),
                });
            }
        }

        return errors;
    }
}
