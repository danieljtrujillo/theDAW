/**
 * Pure display decisions for the transcript.
 *
 * These are the rules that used to be buried inside JSX, which is exactly why
 * theDAW shipped an empty bubble with Copy/Retry under every tool-only turn.
 * They are functions here so a test can pin them down.
 */

import { CONTROL_TIMEOUT_MS } from '../stream/frameReducer';
import type { ChatMessage, TextScale } from '../stream/types';

/**
 * Copy/Retry belong to PROSE. A turn that produced only tool activity has
 * nothing to copy and nothing whose wording a retry would change, so it gets no
 * action row — and, upstream, no empty bubble to hang one on.
 */
export function shouldShowMessageActions(message: ChatMessage): boolean {
    return message.role === 'assistant' && message.text.trim().length > 0;
}

/** Message-bubble text scale. */
export function scaleClassFor(textScale: TextScale): string {
    switch (textScale) {
        case 'xs':
            return 'text-[11px] leading-relaxed';
        case 'md':
            return 'text-sm leading-relaxed';
        case 'lg':
            return 'text-base leading-relaxed';
        default:
            return 'text-[12.5px] leading-relaxed';
    }
}

/** Tool-row text scale (one step down from the bubble). */
export function toolScaleClassFor(textScale: TextScale): string {
    switch (textScale) {
        case 'xs':
            return 'text-[10px]';
        case 'md':
            return 'text-xs';
        case 'lg':
            return 'text-sm';
        default:
            return 'text-[11px]';
    }
}

/**
 * Seconds left on a permission request, for display only.
 *
 * The countdown is informational: the BACKEND owns the auto-deny at
 * CONTROL_TIMEOUT_MS. Denying locally as well would race it and could answer a
 * request the CLI had already been told about.
 */
export function controlSecondsLeft(createdAt: number, now: number): number {
    return Math.max(0, Math.ceil((CONTROL_TIMEOUT_MS - (now - createdAt)) / 1000));
}
