import React, { useState, useCallback } from 'react';
import { GantasmoOrb } from './react/GantasmoOrb';
import { OrbChatPanel } from './chat/OrbChatPanel';
import type { OrbChatConfig } from './chat/useOrbChat';

export interface OrbChatAssembledProps extends OrbChatConfig {
    title?: string;
    subtitle?: string;
    panelWidth?: number;
    panelHeight?: number;
    defaultOpen?: boolean;
}

export const OrbChatAssembled: React.FC<OrbChatAssembledProps> = ({
    title,
    subtitle,
    panelWidth = 420,
    panelHeight = 550,
    defaultOpen = false,
    ...chatConfig
}) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const [orbPosition, setOrbPosition] = useState<{ x: number; y: number }>({ x: 20, y: 500 });

    const panelPosition = useCallback(() => {
        if (typeof window === 'undefined') return { x: 120, y: 120 };
        const orbCenterX = orbPosition.x + 32;
        const orbCenterY = orbPosition.y + 32;
        const isRight = orbCenterX > window.innerWidth / 2;
        const isBottom = orbCenterY > window.innerHeight / 2;
        const margin = 16;

        let x = isRight
            ? Math.max(margin, orbPosition.x - panelWidth - margin)
            : Math.min(window.innerWidth - panelWidth - margin, orbPosition.x + 80);
        let y = isBottom
            ? Math.max(margin, orbPosition.y - panelHeight - margin)
            : Math.min(window.innerHeight - panelHeight - margin - 80, orbPosition.y);

        x = Math.max(margin, Math.min(x, window.innerWidth - panelWidth - margin));
        y = Math.max(margin, Math.min(y, window.innerHeight - panelHeight - margin - 80));
        return { x, y };
    }, [orbPosition, panelWidth, panelHeight]);

    return (
        <>
            <GantasmoOrb
                isActive={isOpen}
                onToggle={() => setIsOpen(prev => !prev)}
                onPositionChange={setOrbPosition}
            />
            <OrbChatPanel
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                title={title}
                subtitle={subtitle}
                position={panelPosition()}
                width={panelWidth}
                height={panelHeight}
                {...chatConfig}
            />
        </>
    );
};

export default OrbChatAssembled;
