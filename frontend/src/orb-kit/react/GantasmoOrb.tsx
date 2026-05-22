import React, { useCallback, useEffect, useRef, useState } from 'react';

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
}) => {
    // Default visual placement mirrors the original app: lower-left-ish.
    const initialPosition = defaultPosition ?? {
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

        const maxX = Math.max(0, window.innerWidth - ORB_BOUNDS);
        const maxY = Math.max(0, window.innerHeight - ORB_BOUNDS);

        return {
            x: Math.max(0, Math.min(maxX, pos.x)),
            y: Math.max(0, Math.min(maxY, pos.y)),
        };
    }, []);

    // Restore persisted position on mount when enabled.
    // We still clamp after load in case the viewport changed since last session.
    useEffect(() => {
        if (!persistenceKey || typeof window === 'undefined') {
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
    }, [clampToViewport, persistenceKey]);

    // Keep the orb visible after viewport resizes.
    // Without this, a previously valid saved position could end up off-screen.
    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const onResize = () => {
            setPosition((current) => clampToViewport(current));
        };

        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [clampToViewport]);

    // Persist the latest settled position after drag completes.
    useEffect(() => {
        if (!persistenceKey || isDragging || typeof window === 'undefined') {
            return;
        }

        window.localStorage.setItem(persistenceKey, JSON.stringify(position));
    }, [isDragging, persistenceKey, position]);

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
        setPosition(clampToViewport({
            x: dragRef.current.startPosX + deltaX,
            y: dragRef.current.startPosY + deltaY,
        }));
    }, [clampToViewport, isDragging]);

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
                                            {/*
                                                The ghost face SVG is part of the orb identity.
                                                Preserve this unless a human explicitly requests a redesign.
                                            */}
                        <div className="gantasmo-face" aria-hidden="true">
                            <svg viewBox="0 0 102.28 83.35" xmlns="http://www.w3.org/2000/svg">
                                <path className="face-base" d="M20.4,9.8l3.71,1.31.62,3.84c4.3,1.57,4.86,2.03,4.69,6.83l4.7,2.8-.8,24.91-4.02.47-.02,5.97h-4.02s.01,7,.01,7l-13,.99-.96-6.56-3.94-.54-1.15-7.85c-.53-.57-4.9,1.07-5.82-1.69-.52-1.57-.53-18.64-.16-20.9l3.06-3.15.4-12.38,5.57-.93L10.35,0l9.49,1.86.56,7.94Z" />
                                <path className="face-base" d="M102.28,47.92l-4.96.04-1.21,7.78-4.77,1.24v5.47s-13.05,1.47-13.05,1.47l-.44-7.08c-5.46-.92-2.46-2.83-4.51-6.49l-4.02-.46c.28-3.6-.97-6.86-1.08-10.42-.06-1.94.74-14.78,1.18-15.41.36-.51,2.96-.65,3.9-1.59l1.42-5.59c4.55-.65,3.86-3.76,5.55-5.46,1.03-1.04,3.5-1.12,3.86-1.63.81-1.14-.27-6.89.14-8.87h11.01s.12,7.88.12,7.88l3.92,1.78-.07,10.66c.26,1.06,3.03,1.52,3.03,2.19v24.5Z" />
                                <ellipse className="face-eye" cx="13" cy="30" rx="2.5" ry="3" />
                                <ellipse className="face-eye" cx="85" cy="30" rx="2.5" ry="3" />
                                <path className="gantasmo-mouth" d="M 10 40 Q 20 45, 25 40" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" opacity="0.8" />
                                <path className="gantasmo-mouth" d="M 77 40 Q 87 45, 92 40" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" opacity="0.8" />
                            </svg>
                        </div>
                    </div>

                    <div className="orb-pulse-main" aria-hidden="true" />
                </div>
            </div>
        </div>
    );
};

export default GantasmoOrb;
