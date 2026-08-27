import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EYE_LEFT_D, EYE_RIGHT_D, MOUTH_D, ORB_FACE_VIEWBOX, PUPIL_LEFT_D, PUPIL_RIGHT_D } from './orbFaceShapes';

export interface GantasmoOrbProps {
    /**
     * Whether the host app considers the orb to be in its active/open state.
     *
     * This only affects visuals. The orb does not own panel state internally.
     */
    isActive?: boolean;

    /**
     * Generic click/toggle callback.
     *
     * The host app decides what "toggle" means: open panel, show modal,
     * switch modes, etc.
     */
    onToggle?: () => void;

    /**
     * Called whenever the orb position changes.
     *
     * Hosts can use this to position a companion panel near the orb without
     * coupling panel logic into the orb itself.
     */
    onPositionChange?: (position: { x: number; y: number }) => void;

    /** Starting position before persistence is loaded. */
    defaultPosition?: { x: number; y: number };

    /**
     * localStorage key used to persist the orb position.
     * Pass false to disable persistence entirely.
     */
    persistenceKey?: string | false;

    /** Accessibility label for screen readers. */
    ariaLabel?: string;

    /** Optional wrapper class for host-level styling hooks. */
    className?: string;

    /**
     * fixed=true  -> orb floats over the viewport
     * fixed=false -> orb can sit inline in a normal layout flow
     */
    fixed?: boolean;

    /**
     * Optional visual body rendered inside the orb core, beneath the face
     * overlay (e.g. theDAW's ferrofluid canvas). When present, the ghost body
     * lobes are omitted from the face SVG so only the eyes and mouth composite
     * over the body.
     */
    coreOverlay?: React.ReactNode;

    /**
     * Visual busy state (the host's assistant is thinking). Drives the
     * `processing` CSS hook (face wobble) while true.
     */
    processing?: boolean;

    /**
     * Size of the orb's square hit/clamp box in px. Must match the CSS size
     * of .aether-orb-toggle for the host's skin (default 80; theDAW's 2x orb
     * uses 112 via the orb-2x class).
     */
    bounds?: number;

    /**
     * Pin the orb to a viewport corner until the user drags it away.
     *
     * While stuck the orb re-solves its corner on every resize, so it cannot be
     * left stranded mid-screen by a window change — which a saved absolute
     * position otherwise does. The first drag past the threshold releases it
     * permanently (persisted alongside the position), after which the orb is
     * free and resizes only clamp it back into view.
     */
    stickCorner?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | false;

    /** Gap in px between the orb box and the viewport edges while stuck. */
    cornerMargin?: number;
}

// Small mouse movement should still count as a click.
// Only movement beyond this threshold becomes a drag operation.
const DRAG_THRESHOLD = 5;

// Default persistence key chosen to be generic and product-neutral.
const DEFAULT_STORAGE_KEY = 'gantasmo-orb-position';

// The floating wrapper is visually designed around an 80x80 hit area.
// We use that value when clamping movement to the viewport.
const ORB_BOUNDS = 80;

export const GantasmoOrb: React.FC<GantasmoOrbProps> = ({
    isActive = false,
    onToggle,
    onPositionChange,
    defaultPosition,
    persistenceKey = DEFAULT_STORAGE_KEY,
    ariaLabel = 'Toggle orb panel',
    className,
    fixed = true,
    coreOverlay,
    processing = false,
    bounds = ORB_BOUNDS,
    stickCorner = false,
    cornerMargin = 12,
}) => {
    // Where the orb sits while it is still stuck to its corner. Recomputed from
    // the live viewport rather than stored, so a resize can never strand it.
    const cornerPosition = useCallback(() => {
        if (typeof window === 'undefined' || !stickCorner) return null;
        const right = window.innerWidth - bounds - cornerMargin;
        const bottom = window.innerHeight - bounds - cornerMargin;
        switch (stickCorner) {
            case 'bottom-right': return { x: Math.max(0, right), y: Math.max(0, bottom) };
            case 'bottom-left': return { x: cornerMargin, y: Math.max(0, bottom) };
            case 'top-right': return { x: Math.max(0, right), y: cornerMargin };
            case 'top-left': return { x: cornerMargin, y: cornerMargin };
            default: return null;
        }
    }, [bounds, cornerMargin, stickCorner]);

    const unstuckKey = persistenceKey ? `${persistenceKey}-unstuck` : null;
    // Read the release flag synchronously so the very first paint is already in
    // the right place — deferring it to an effect makes the orb visibly jump.
    const [unstuck, setUnstuck] = useState<boolean>(() => {
        if (!stickCorner) return true;
        if (!unstuckKey || typeof window === 'undefined') return false;
        try { return window.localStorage.getItem(unstuckKey) === '1'; } catch { return false; }
    });

    // Default visual placement mirrors the original app: lower-left-ish.
    const initialPosition = (!unstuck && cornerPosition()) || defaultPosition || {
        x: 20,
        y: typeof window !== 'undefined' ? window.innerHeight - 140 : 500,
    };

    // The orb owns only its own placement state.
    // The host owns whatever UI appears when the orb is toggled.
    const [position, setPosition] = useState(initialPosition);
    const [isDragging, setIsDragging] = useState(false);
    const [hasDragged, setHasDragged] = useState(false);

    // We store drag-start state in a ref so mousemove can read it without
    // forcing React re-renders on every pixel movement.
    const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

    // Direct DOM access is used only for the transform update. This avoids
    // needing inline React styles on every render and keeps the component easy
    // to drop into style-restricted codebases.
    const orbRef = useRef<HTMLDivElement>(null);

    const clampToViewport = useCallback((pos: { x: number; y: number }) => {
        if (typeof window === 'undefined') {
            return pos;
        }

        const maxX = Math.max(0, window.innerWidth - bounds);
        const maxY = Math.max(0, window.innerHeight - bounds);

        return {
            x: Math.max(0, Math.min(maxX, pos.x)),
            y: Math.max(0, Math.min(maxY, pos.y)),
        };
    }, [bounds]);

    // Restore persisted position on mount when enabled.
    // We still clamp after load in case the viewport changed since last session.
    useEffect(() => {
        if (!persistenceKey || typeof window === 'undefined') {
            return;
        }
        // While the orb is still stuck to its corner the saved position is
        // deliberately ignored — the corner is the source of truth until the
        // user drags the orb out of it for the first time.
        if (!unstuck) {
            return;
        }

        const savedPosition = window.localStorage.getItem(persistenceKey);
        if (!savedPosition) {
            return;
        }

        try {
            const parsed = JSON.parse(savedPosition);
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                setPosition(clampToViewport(parsed));
            }
        } catch {
            // Ignore invalid persisted state.
        }
    }, [clampToViewport, persistenceKey, unstuck]);

    // Keep the orb visible after viewport resizes. A still-stuck orb re-solves
    // its corner (so it stays welded to the edge no matter how the window is
    // resized); a released orb is only clamped back into view.
    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const onResize = () => {
            const corner = !unstuck && cornerPosition();
            setPosition((current) => (corner ? corner : clampToViewport(current)));
        };

        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [clampToViewport, cornerPosition, unstuck]);

    // Persist the latest settled position after drag completes. Skipped while
    // stuck: the corner is recomputed each load, so writing it back would only
    // bake in one viewport's coordinates.
    useEffect(() => {
        if (!persistenceKey || isDragging || !unstuck || typeof window === 'undefined') {
            return;
        }

        window.localStorage.setItem(persistenceKey, JSON.stringify(position));
    }, [isDragging, persistenceKey, position, unstuck]);

    // Emit position updates outward so the host can anchor a related surface.
    useEffect(() => {
        onPositionChange?.(position);
    }, [onPositionChange, position]);

    const handleMouseDown = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        setIsDragging(true);
        setHasDragged(false);
        dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            startPosX: position.x,
            startPosY: position.y,
        };
    }, [position.x, position.y]);

    // Drag logic is intentionally imperative and simple:
    // - compute mouse delta
    // - ignore tiny movements
    // - clamp to viewport
    // - update position
    const handleMouseMove = useCallback((event: MouseEvent) => {
        if (!isDragging || !dragRef.current || typeof window === 'undefined') {
            return;
        }

        const deltaX = event.clientX - dragRef.current.startX;
        const deltaY = event.clientY - dragRef.current.startY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance <= DRAG_THRESHOLD) {
            return;
        }

        setHasDragged(true);
        // The first drag past the threshold releases the orb from its corner
        // for good. Persisted, so it stays free across reloads.
        if (!unstuck) {
            setUnstuck(true);
            if (unstuckKey && typeof window !== 'undefined') {
                try { window.localStorage.setItem(unstuckKey, '1'); } catch { /* non-fatal */ }
            }
        }
        setPosition(clampToViewport({
            x: dragRef.current.startPosX + deltaX,
            y: dragRef.current.startPosY + deltaY,
        }));
    }, [clampToViewport, isDragging, unstuck, unstuckKey]);

    // If the pointer never crossed the drag threshold, treat the interaction as a click.
    const handleMouseUp = useCallback(() => {
        if (isDragging && !hasDragged) {
            onToggle?.();
        }

        setIsDragging(false);
        dragRef.current = null;
    }, [hasDragged, isDragging, onToggle]);

    // We attach global listeners only during an active drag so the drag remains
    // stable even if the pointer moves faster than the orb element itself.
    useEffect(() => {
        if (!isDragging || typeof window === 'undefined') {
            return;
        }

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [handleMouseMove, handleMouseUp, isDragging]);

    // Apply the visual translation directly to the DOM node.
    // This keeps the rendered markup clean and avoids coupling host frameworks
    // to a specific styling strategy.
    useEffect(() => {
        if (!orbRef.current) {
            return;
        }

        orbRef.current.style.transform = fixed
            ? `translate3d(${position.x}px, ${position.y}px, 0)`
            : 'translate3d(0, 0, 0)';
    }, [fixed, position]);

    const rootClassName = ['gantasmo-orb-theme', className].filter(Boolean).join(' ');
    const orbClassName = [
        'aether-orb-toggle',
        fixed ? '' : 'is-inline',
        isActive ? 'active' : '',
        isDragging ? 'dragging' : '',
        processing ? 'processing' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={rootClassName}>
            <div
                ref={orbRef}
                className={orbClassName}
                onMouseDown={handleMouseDown}
                // Click is handled on mouseup so we can distinguish click vs drag.
                // This placeholder onClick only suppresses default bubbling behavior.
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                role="button"
                aria-label={ariaLabel}
                tabIndex={0}
                // Keyboard activation mirrors the mouse click/toggle pathway.
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onToggle?.();
                    }
                }}
            >
                {/*
                  Decorative particles are separate from the orb core so host apps can
                  later swap them out without rewriting the core visual structure.
                */}
                <div className="floating-particles" aria-hidden="true">
                    <div className="particle" />
                    <div className="particle" />
                    <div className="particle" />
                    <div className="particle" />
                    <div className="particle" />
                    <div className="particle" />
                </div>

                <div className="aether-orb-main">
                    <div className="orb-glow-main" aria-hidden="true" />
                    <div className="orb-swirl-layer" aria-hidden="true" />

                    <div className="orb-core-main">
                        {coreOverlay}
                                            {/*
                                                The ghost face SVG is part of the orb identity.
                                                Preserve this unless a human explicitly requests a redesign.
                                                (2026-08-09: the owner requested exactly that for hosts that
                                                supply a coreOverlay body — the ghost lobes yield to the body
                                                and only the eyes + mouth composite on top. Without an
                                                overlay the classic full ghost face renders unchanged.)
                                            */}
                        <div className="gantasmo-face" aria-hidden="true">
                            {coreOverlay ? (
                                /* Cavity face for a body overlay: the EXACT
                                   GANTASMO eye and mouth geometry (extracted
                                   verbatim from the brand favicon), rendered as
                                   glowing violet hollows carved into the fluid.
                                   Dark rims (paint-order stroke) keep them
                                   reading as cavities, not stickers. */
                                <svg viewBox={ORB_FACE_VIEWBOX} xmlns="http://www.w3.org/2000/svg">
                                    <defs>
                                        <radialGradient id="orbCavityGlow">
                                            <stop offset="0%" stopColor="#f3e8ff" />
                                            <stop offset="35%" stopColor="#d8b4fe" />
                                            <stop offset="70%" stopColor="#a855f7" stopOpacity="0.9" />
                                            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.25" />
                                        </radialGradient>
                                        {/* Feathers every feature edge so the glow melts
                                            into the fluid instead of cutting a hard rim. */}
                                        <filter id="orbFaceFeather" x="-20%" y="-20%" width="140%" height="140%">
                                            <feGaussianBlur stdDeviation="8" />
                                        </filter>
                                    </defs>
                                    <g filter="url(#orbFaceFeather)">
                                        <g className="orb-cavity-eye">
                                            <path d={EYE_LEFT_D} fill="url(#orbCavityGlow)" stroke="#08040d" strokeWidth="9" style={{ paintOrder: 'stroke' }} />
                                            <path d={PUPIL_LEFT_D} fill="#7c3aed" opacity="0.55" />
                                        </g>
                                        <g className="orb-cavity-eye">
                                            <path d={EYE_RIGHT_D} fill="url(#orbCavityGlow)" stroke="#08040d" strokeWidth="9" style={{ paintOrder: 'stroke' }} />
                                            <path d={PUPIL_RIGHT_D} fill="#7c3aed" opacity="0.55" />
                                        </g>
                                        <path className="orb-cavity-mouth" d={MOUTH_D} fill="url(#orbCavityGlow)" stroke="#08040d" strokeWidth="9" style={{ paintOrder: 'stroke' }} />
                                    </g>
                                </svg>
                            ) : (
                                <svg viewBox="0 0 102.28 83.35" xmlns="http://www.w3.org/2000/svg">
                                    <path className="face-base" d="M20.4,9.8l3.71,1.31.62,3.84c4.3,1.57,4.86,2.03,4.69,6.83l4.7,2.8-.8,24.91-4.02.47-.02,5.97h-4.02s.01,7,.01,7l-13,.99-.96-6.56-3.94-.54-1.15-7.85c-.53-.57-4.9,1.07-5.82-1.69-.52-1.57-.53-18.64-.16-20.9l3.06-3.15.4-12.38,5.57-.93L10.35,0l9.49,1.86.56,7.94Z" />
                                    <path className="face-base" d="M102.28,47.92l-4.96.04-1.21,7.78-4.77,1.24v5.47s-13.05,1.47-13.05,1.47l-.44-7.08c-5.46-.92-2.46-2.83-4.51-6.49l-4.02-.46c.28-3.6-.97-6.86-1.08-10.42-.06-1.94.74-14.78,1.18-15.41.36-.51,2.96-.65,3.9-1.59l1.42-5.59c4.55-.65,3.86-3.76,5.55-5.46,1.03-1.04,3.5-1.12,3.86-1.63.81-1.14-.27-6.89.14-8.87h11.01s.12,7.88.12,7.88l3.92,1.78-.07,10.66c.26,1.06,3.03,1.52,3.03,2.19v24.5Z" />
                                    <ellipse className="face-eye" cx="13" cy="30" rx="2.5" ry="3" />
                                    <ellipse className="face-eye" cx="85" cy="30" rx="2.5" ry="3" />
                                    <path className="gantasmo-mouth" d="M 10 40 Q 20 45, 25 40" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" opacity="0.8" />
                                    <path className="gantasmo-mouth" d="M 77 40 Q 87 45, 92 40" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" opacity="0.8" />
                                </svg>
                            )}
                        </div>
                    </div>

                    <div className="orb-pulse-main" aria-hidden="true" />
                </div>
            </div>
        </div>
    );
};

export default GantasmoOrb;

