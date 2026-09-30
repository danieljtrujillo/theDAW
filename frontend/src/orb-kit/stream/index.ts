export {
    useChatStream,
    DEFAULT_CHAT_ENDPOINTS,
    DECLINED_RESULT,
    parseSseLine,
    buildConversationHistory,
} from './useChatStream';
export type {
    ChatEndpoints,
    ChatTurnContext,
    SendAttachment,
    SendOptions,
    UseChatStreamApi,
    UseChatStreamOptions,
} from './useChatStream';

export {
    createTurnState,
    reduceFrame,
    finalizeTurn,
    dismissControl,
    dismissPendingAction,
    clearPendingActions,
    clearPendingControls,
    CONTROL_TIMEOUT_MS,
} from './frameReducer';
export type { FinalizeContext, ReduceContext, ReduceResult, StreamEffect, TurnState } from './frameReducer';

export {
    findPendingAction,
    removePendingActionFromMessages,
    declineTargets,
    teardownPosts,
    relayResultBody,
    TURN_ENDED_DENIAL,
} from './pendingActions';
export type { TeardownPost } from './pendingActions';

export type {
    ChatMessage,
    ChatSession,
    ClaudePermissionMode,
    ControlPolicy,
    ControlPolicyKind,
    ControlResponse,
    ControlScope,
    PendingControl,
    PendingDawAction,
    TextScale,
    ToolCallEntry,
    TurnMeta,
} from './types';
