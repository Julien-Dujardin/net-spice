import { TestBed } from '@angular/core/testing';
import { UndoRedoService, UndoRedoAction } from './undo-redo.service';

describe('UndoRedoService', () => {
    let service: UndoRedoService;

    beforeEach(() => {
        TestBed.configureTestingModule({});
        service = TestBed.inject(UndoRedoService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    it('should execute and add action to history', () => {
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value = 0,
            redo: () => value = 1,
            description: 'Set value to 1'
        };

        service.executeAction(action);
        expect(value).toBe(1);
        expect(service.canUndo()).toBe(true);
        expect(service.canRedo()).toBe(false);
    });

    it('should undo an action', () => {
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value = 0,
            redo: () => value = 1
        };

        service.executeAction(action);
        expect(value).toBe(1);

        service.undo();
        expect(value).toBe(0);
        expect(service.canUndo()).toBe(false);
        expect(service.canRedo()).toBe(true);
    });

    it('should redo an action', () => {
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value = 0,
            redo: () => value = 1
        };

        service.executeAction(action);
        service.undo();
        expect(value).toBe(0);

        service.redo();
        expect(value).toBe(1);
        expect(service.canUndo()).toBe(true);
        expect(service.canRedo()).toBe(false);
    });

    it('should clear redo stack when new action is added', () => {
        let value = 0;
        const action1: UndoRedoAction = {
            undo: () => value--,
            redo: () => value++
        };

        service.executeAction(action1);
        service.executeAction(action1);
        service.undo();

        expect(service.canRedo()).toBe(true);

        service.executeAction(action1);
        expect(service.canRedo()).toBe(false);
    });

    it('should handle multiple actions', () => {
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value--,
            redo: () => value++
        };

        service.executeAction(action);
        service.executeAction(action);
        service.executeAction(action);
        expect(value).toBe(3);

        service.undo();
        expect(value).toBe(2);
        service.undo();
        expect(value).toBe(1);
        service.undo();
        expect(value).toBe(0);

        expect(service.canUndo()).toBe(false);
    });

    it('should clear all history', () => {
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value = 0,
            redo: () => value = 1
        };

        service.executeAction(action);
        service.clear();

        expect(service.canUndo()).toBe(false);
        expect(service.canRedo()).toBe(false);
        expect(service.getUndoStackSize()).toBe(0);
        expect(service.getRedoStackSize()).toBe(0);
    });

    it('should respect max history size', () => {
        service.setMaxHistorySize(3);
        let value = 0;
        const action: UndoRedoAction = {
            undo: () => value--,
            redo: () => value++
        };

        for (let i = 0; i < 5; i++) {
            service.executeAction(action);
        }

        expect(service.getUndoStackSize()).toBe(3);
        expect(value).toBe(5);

        // Should only undo 3 times
        service.undo();
        service.undo();
        service.undo();
        expect(value).toBe(2); // Started at 5, went back 3
        expect(service.canUndo()).toBe(false);
    });

    it('should return action descriptions', () => {
        const action: UndoRedoAction = {
            undo: () => { },
            redo: () => { },
            description: 'Test action'
        };

        service.executeAction(action);
        expect(service.getUndoDescription()).toBe('Test action');

        service.undo();
        expect(service.getRedoDescription()).toBe('Test action');
    });
});
