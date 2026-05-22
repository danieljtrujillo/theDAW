export interface AssistantExecutableAction {
    type: string;
    payload?: Record<string, unknown>;
}

const STABLEDAW_ACTION_TYPES = new Set([
    'navigate',
    'navigate_to',
    'open_docs',
    'close_docs',
    'open_left_panel',
    'close_left_panel',
    'set_prompt',
    'append_prompt',
    'improve_prompt',
    'set_negative_prompt',
    'set_model',
    'set_duration',
    'set_steps',
    'set_cfg',
    'set_cfg_scale',
    'set_seed',
    'set_batch',
    'set_batch_size',
    'set_sampler',
    'set_shift_mode',
    'set_init_noise',
    'set_params',
    'generate',
    'start_generation',
    'abort',
    'abort_generation',
    'stop_generation',
    'get_status',
    'status',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): Record<string, unknown> {
    if (isRecord(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (isRecord(parsed)) return parsed;
        } catch {
            return {};
        }
    }
    return {};
}

function actionNameFromEvent(event: Record<string, unknown>): string | null {
    if (typeof event.action_type === 'string') return event.action_type;
    if (typeof event.name === 'string') return event.name;

    const fn = event.function;
    if (isRecord(fn) && typeof fn.name === 'string') return fn.name;

    return null;
}

function payloadFromEvent(event: Record<string, unknown>): Record<string, unknown> {
    if ('payload' in event) return parsePayload(event.payload);
    if ('input' in event) return parsePayload(event.input);

    const fn = event.function;
    if (isRecord(fn) && 'arguments' in fn) return parsePayload(fn.arguments);

    return {};
}

export function actionFromAssistantEvent(event: unknown): AssistantExecutableAction | null {
    if (!isRecord(event)) return null;
    if (event.type !== 'action' && event.type !== 'tool_call' && event.type !== 'function_call') return null;

    const type = actionNameFromEvent(event);
    if (!type || !STABLEDAW_ACTION_TYPES.has(type)) return null;

    return {
        type,
        payload: payloadFromEvent(event),
    };
}

export function statusFromAssistantEvent(event: unknown): string | null {
    if (!isRecord(event)) return null;

    if (event.type === 'function_result') {
        const name = actionNameFromEvent(event);
        return name ? `Claude Code: ${name} complete` : 'Claude Code: tool complete';
    }

    if (event.type !== 'tool_call' && event.type !== 'function_call') return null;
    const name = actionNameFromEvent(event);
    if (!name || STABLEDAW_ACTION_TYPES.has(name)) return null;

    return `Claude Code: using ${name}`;
}
