/**
 * Type definitions for the StableDAW AI Assistant (Orb Kit)
 *
 * Ported from SunoHarvester's Gantasmo assistant types,
 * adapted for the StableDAW audio generation domain.
 */

// ---------------------------------------------------------------------------
// Message roles
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'action' | 'system' | 'pending_confirmation'

// ---------------------------------------------------------------------------
// Action kinds - StableDAW audio generation domain
// ---------------------------------------------------------------------------

export type AssistantActionKind =
  | 'navigate'       // UI navigation
  | 'set_params'     // modify generation parameters
  | 'generate'       // start audio generation
  | 'abort'          // cancel in-progress generation
  | 'playback'       // play/pause/stop generated audio
  | 'status'         // query pipeline or model status
  | 'diagnose'       // system diagnostics (GPU, model load, etc.)
  | 'generic'        // catch-all

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface AssistantAction {
  id: string
  kind: AssistantActionKind
  label: string
  detail?: string
  /** Parameter names that were changed (for set_params actions) */
  params?: string[]
  success?: boolean
  timestamp: number
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AssistantMessage {
  id: string
  role: MessageRole
  content: string
  action?: AssistantAction
  pending?: PendingToolCall
  createdAt: number
  streaming?: boolean
}

// ---------------------------------------------------------------------------
// Thinking / progress steps
// ---------------------------------------------------------------------------

export type ThinkingStepStatus = 'active' | 'done' | 'error'

export interface ThinkingStep {
  id: string
  label: string
  status: ThinkingStepStatus
}

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

export interface AssistantConversationState {
  messages: AssistantMessage[]
  isTyping: boolean
  isOpen: boolean
  unreadCount: number
  error: string | null
  toolStatus: string | null
  pendingToolCalls: Record<string, PendingToolCall>
  thinkingSteps: ThinkingStep[]
}

// ---------------------------------------------------------------------------
// Pending tool calls (T2_confirm tier)
// ---------------------------------------------------------------------------

export interface PendingToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  description: string
  createdAt: number
  expiresAt: number   // 60s countdown
  status: 'pending' | 'approved' | 'skipped' | 'expired'
}

// ---------------------------------------------------------------------------
// Chat request / SSE events
// ---------------------------------------------------------------------------

export interface AssistantChatRequest {
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    tool_call_id?: string
  }>
  conversationId?: string
  model?: string
  provider?: string
}

export type AssistantSSEEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'function_call'; id: string; name: string; arguments: string }
  | { type: 'function_result'; id: string; name: string; result: unknown }
  | { type: 'status'; message: string }
  | { type: 'done'; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { type: 'error'; error: string }

// ---------------------------------------------------------------------------
// UI positioning
// ---------------------------------------------------------------------------

export interface OrbPosition {
  bottom: number
  right: number
}

// ---------------------------------------------------------------------------
// Function call / result helpers
// ---------------------------------------------------------------------------

export interface FunctionCallEvent {
  name: string
  args: Record<string, unknown>
}

export interface ActionResult {
  action: AssistantAction
  data?: unknown
}
