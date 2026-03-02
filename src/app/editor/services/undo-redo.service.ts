import { Injectable, signal } from '@angular/core';

export interface UndoRedoAction {
    undo: () => void;
    redo: () => void;
    description?: string;
}

@Injectable({
    providedIn: 'root'
})
export class UndoRedoService {
    private undoStack: UndoRedoAction[] = [];
    private redoStack: UndoRedoAction[] = [];
    private maxHistorySize = 100;

    // Signals to track availability
    canUndo = signal(false);
    canRedo = signal(false);

    constructor() { }

    /**
     * Execute an action and add it to the undo history
     */
    executeAction(action: UndoRedoAction): void {
        action.redo(); // Execute the action
        this.addToHistory(action);
    }

    /**
     * Add an action to the undo history without executing it
     * Use this when you've already performed the action
     */
    addToHistory(action: UndoRedoAction): void {
        this.undoStack.push(action);
        this.redoStack = []; // Clear redo stack when new action is added

        // Limit history size
        if (this.undoStack.length > this.maxHistorySize) {
            this.undoStack.shift();
        }

        this.updateAvailability();
    }

    /**
     * Undo the last action
     */
    undo(): void {
        const action = this.undoStack.pop();
        if (action) {
            action.undo();
            this.redoStack.push(action);
            this.updateAvailability();
        }
    }

    /**
     * Redo the last undone action
     */
    redo(): void {
        const action = this.redoStack.pop();
        if (action) {
            action.redo();
            this.undoStack.push(action);
            this.updateAvailability();
        }
    }

    /**
     * Clear all undo/redo history
     */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.updateAvailability();
    }

    /**
     * Get the description of the next undo action
     */
    getUndoDescription(): string | undefined {
        return this.undoStack[this.undoStack.length - 1]?.description;
    }

    /**
     * Get the description of the next redo action
     */
    getRedoDescription(): string | undefined {
        return this.redoStack[this.redoStack.length - 1]?.description;
    }

    /**
     * Set the maximum history size
     */
    setMaxHistorySize(size: number): void {
        this.maxHistorySize = size;
        while (this.undoStack.length > this.maxHistorySize) {
            this.undoStack.shift();
        }
    }

    /**
     * Get the current undo stack size
     */
    getUndoStackSize(): number {
        return this.undoStack.length;
    }

    /**
     * Get the current redo stack size
     */
    getRedoStackSize(): number {
        return this.redoStack.length;
    }

    private updateAvailability(): void {
        this.canUndo.set(this.undoStack.length > 0);
        this.canRedo.set(this.redoStack.length > 0);
    }
}
