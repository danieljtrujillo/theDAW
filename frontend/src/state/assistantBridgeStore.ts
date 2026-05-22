import { create } from 'zustand';
import { useGenerateParamsStore } from './generateParamsStore';
import { useGenerateStore } from './generateStore';
import { logInfo } from './logStore';

export type ActionMode = 'full_access' | 'permission_required';

export interface AssistantAction {
    id: string;
    type: string;
    params: Record<string, unknown>;
    description: string;
    status: 'pending' | 'approved' | 'rejected' | 'executed';
}

interface AssistantBridgeState {
    mode: ActionMode;
    pendingActions: AssistantAction[];
    setMode: (mode: ActionMode) => void;
    executeAction: (action: AssistantAction) => string;
    approveAction: (id: string) => string;
    rejectAction: (id: string) => void;
    clearPending: () => void;
}

function runAction(action: AssistantAction): string {
    const { type, params } = action;
    const paramsStore = useGenerateParamsStore.getState();

    switch (type) {
        case 'set_prompt':
            paramsStore.setField('prompt', String(params.prompt || ''));
            return `Prompt set to: "${String(params.prompt || '').slice(0, 60)}"`;

        case 'set_negative_prompt':
            paramsStore.setField('negativePrompt', String(params.prompt || ''));
            return 'Negative prompt set';

        case 'set_model':
            paramsStore.setField('model', String(params.model || 'medium'));
            return `Model set to: ${params.model}`;

        case 'set_duration':
            paramsStore.setField('duration', Number(params.duration || 30));
            return `Duration set to: ${params.duration}s`;

        case 'set_steps':
            paramsStore.setField('steps', Number(params.steps || 8));
            return `Steps set to: ${params.steps}`;

        case 'set_cfg':
            paramsStore.setField('cfg', Number(params.cfg || 1.0));
            return `CFG scale set to: ${params.cfg}`;

        case 'set_seed':
            paramsStore.setField('seed', Number(params.seed ?? -1));
            return `Seed set to: ${params.seed}`;

        case 'set_shift_mode':
            paramsStore.setField('shiftMode', String(params.mode || 'LogSNR'));
            return `Shift mode set to: ${params.mode}`;

        case 'set_batch':
            paramsStore.setField('batch', Number(params.batch || 1));
            return `Batch size set to: ${params.batch}`;

        case 'set_sampler':
            paramsStore.setField('samplerType', String(params.sampler || 'pingpong'));
            return `Sampler set to: ${params.sampler}`;

        case 'set_params':
            paramsStore.patch(params as Partial<Record<string, unknown>>);
            return 'Multiple parameters updated';

        case 'start_generation': {
            const p = useGenerateParamsStore.getState();
            useGenerateStore.getState().submitGeneration({
                prompt: p.prompt,
                negativePrompt: p.negativePrompt,
                model: p.model,
                duration: p.duration,
                steps: p.steps,
                cfg: p.cfg,
                seed: p.seed,
                batch: p.batch,
                initNoise: p.initNoise,
                initType: p.initType,
                initAudioFile: p.initAudioFile,
                inpaintAudioFile: p.inpaintAudioFile,
                inpaintEnabled: p.inpaintEnabled,
                maskStart: p.maskStart,
                maskEnd: p.maskEnd,
            });
            return 'Generation started';
        }

        case 'abort_generation':
            useGenerateStore.getState().cancelPolling();
            return 'Generation aborted';

        case 'navigate': {
            const tab = String(params.tab || 'create');
            window.dispatchEvent(new CustomEvent('stabledaw:navigate', { detail: { tab } }));
            return `Navigated to: ${tab}`;
        }

        case 'get_status': {
            const gen = useGenerateStore.getState();
            const gp = useGenerateParamsStore.getState();
            return JSON.stringify({
                generating: gen.isGenerating,
                jobStatus: gen.jobStatus,
                model: gp.model,
                prompt: gp.prompt.slice(0, 100),
                duration: gp.duration,
                steps: gp.steps,
                cfg: gp.cfg,
                seed: gp.seed,
            });
        }

        default:
            return `Unknown action: ${type}`;
    }
}

export const useAssistantBridgeStore = create<AssistantBridgeState>()((set, get) => ({
    mode: 'full_access',
    pendingActions: [],

    setMode: (mode) => set({ mode }),

    executeAction: (action) => {
        const { mode } = get();

        if (mode === 'permission_required') {
            set((state) => ({
                pendingActions: [...state.pendingActions, { ...action, status: 'pending' as const }],
            }));
            return `Action "${action.description}" requires your approval.`;
        }

        logInfo('assistant', `Executing: ${action.description}`);
        return runAction(action);
    },

    approveAction: (id) => {
        const action = get().pendingActions.find((a) => a.id === id);
        if (!action) return 'Action not found';

        set((state) => ({
            pendingActions: state.pendingActions.map((a) =>
                a.id === id ? { ...a, status: 'executed' as const } : a
            ),
        }));

        logInfo('assistant', `Approved: ${action.description}`);
        return runAction(action);
    },

    rejectAction: (id) => {
        set((state) => ({
            pendingActions: state.pendingActions.map((a) =>
                a.id === id ? { ...a, status: 'rejected' as const } : a
            ),
        }));
    },

    clearPending: () => set({ pendingActions: [] }),
}));
