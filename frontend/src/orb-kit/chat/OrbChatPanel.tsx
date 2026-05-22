import React, { useState, useRef, useEffect } from 'react';
import { Paperclip } from 'lucide-react';
import { useOrbChat, OrbChatMessage, OrbChatConfig } from './useOrbChat';
import { ProviderModelSelector } from '../ProviderModelSelector';

export interface OrbChatPanelProps extends OrbChatConfig {
    isOpen?: boolean;
    onClose?: () => void;
    title?: string;
    subtitle?: string;
    position?: { x: number; y: number };
    width?: number;
    height?: number;
}

function inlineMd(text: string): string {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function buildTable(rows: string[]): string {
    if (rows.length < 1) return '';
    const parse = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const hdrs = parse(rows[0]);
    const sep = rows.length > 1 && /^[\s|:-]+$/.test(rows[1]);
    const start = sep ? 2 : 1;
    let h = '<table><thead><tr>' + hdrs.map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (let r = start; r < rows.length; r++) {
        if (/^[\s|:-]+$/.test(rows[r])) continue;
        h += '<tr>' + parse(rows[r]).map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
    }
    return h + '</tbody></table>';
}

function isBlockStart(line: string): boolean {
    const t = line.trim();
    return /^#{1,4}\s/.test(line) || /^>\s?/.test(line) || /^\s*[-*+]\s/.test(line) ||
        /^\s*\d+[.)]\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
        (/^\|.+\|$/.test(t)) || /^\x00P\d+\x00$/.test(line);
}

function simpleMarkdown(text: string): string {
    const ph: string[] = [];
    let src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        ph.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc}</code></pre>`);
        return `\x00P${ph.length - 1}\x00`;
    });

    const lines = src.split('\n');
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        const pm = line.match(/^\x00P(\d+)\x00$/);
        if (pm) { out.push(ph[parseInt(pm[1])]); i++; continue; }

        if (!trimmed) { i++; continue; }

        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr/>'); i++; continue; }

        const hm = line.match(/^(#{1,4})\s+(.+)/);
        if (hm) { out.push(`<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`); i++; continue; }

        if (/^>\s?/.test(line)) {
            const buf: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
            out.push(`<blockquote>${buf.map(l => inlineMd(l)).join('<br/>')}</blockquote>`);
            continue;
        }

        if (/^\|.+\|$/.test(trimmed)) {
            const rows: string[] = [];
            while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) { rows.push(lines[i]); i++; }
            out.push(buildTable(rows));
            continue;
        }

        if (/^\s*[-*+]\s/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s/, '')); i++; }
            out.push(`<ul>${items.map(t => `<li>${inlineMd(t)}</li>`).join('')}</ul>`);
            continue;
        }

        if (/^\s*\d+[.)]\s/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s/, '')); i++; }
            out.push(`<ol>${items.map(t => `<li>${inlineMd(t)}</li>`).join('')}</ol>`);
            continue;
        }

        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
        if (para.length) out.push(`<p>${para.map(l => inlineMd(l)).join('<br/>')}</p>`);
    }

    return out.join('\n');
}

export const OrbChatPanel: React.FC<OrbChatPanelProps> = ({
    isOpen = true,
    onClose,
    title = 'GANTASMO-b0t',
    subtitle = 'Stable Audio 3 expert',
    position,
    width = 420,
    height = 550,
    ...chatConfig
}) => {
    const chat = useOrbChat(chatConfig);
    const [input, setInput] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [settingsTab, setSettingsTab] = useState<'model' | 'keys'>('model');
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [keyInput, setKeyInput] = useState('');
    const [showKeyText, setShowKeyText] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chat.messages]);

    useEffect(() => {
        if (isOpen && inputRef.current) inputRef.current.focus();
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() && chat.attachments.length === 0) return;
        if (chat.isProcessing && chat.stop) chat.stop();
        chat.sendMessage(input);
        setInput('');
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            chat.addAttachments(Array.from(e.target.files));
        }
        e.target.value = '';
    };

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
    const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) chat.addAttachments(files);
    };

    const panelStyle: React.CSSProperties = {
        position: position ? 'fixed' : 'relative',
        ...(position ? { left: position.x, top: position.y } : {}),
        width, height,
        zIndex: 9998,
    };

    return (
        <div className="gantasmo-orb-theme" style={panelStyle}>
            <div
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                style={{
                display: 'flex', flexDirection: 'column', height: '100%',
                background: 'rgba(9,9,11,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(20px)',
                boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
                position: 'relative',
            }}>
                {/* Header */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)',
                    background: 'linear-gradient(to right, rgba(139,92,246,0.1), rgba(236,72,153,0.1))',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 32, height: 32, borderRadius: '50%',
                            background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.9)' }} />
                        </div>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#fafafa' }}>{title}</div>
                            <div style={{ fontSize: 10, color: '#52525b' }}>{subtitle}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => setShowSettings(!showSettings)} style={{
                            padding: 6, borderRadius: 8, background: 'none', border: 'none',
                            color: showSettings ? '#8b5cf6' : '#52525b', cursor: 'pointer', fontSize: 14,
                        }} title="Settings">&#9881;</button>
                        <button onClick={() => chat.clearHistory()} style={{
                            padding: 6, borderRadius: 8, background: 'none', border: 'none',
                            color: '#52525b', cursor: 'pointer', fontSize: 14,
                        }} title="Clear">&#128465;</button>
                        {onClose && <button onClick={onClose} style={{
                            padding: 6, borderRadius: 8, background: 'none', border: 'none',
                            color: '#52525b', cursor: 'pointer', fontSize: 14,
                        }} title="Close">&times;</button>}
                    </div>
                </div>

                {/* Settings Panel */}
                {showSettings && (
                    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            {(['model', 'keys'] as const).map(tab => (
                                <button key={tab} onClick={() => setSettingsTab(tab)} style={{
                                    flex: 1, padding: '6px 12px', fontSize: 10, fontWeight: 500, cursor: 'pointer',
                                    background: 'none', border: 'none',
                                    borderBottom: settingsTab === tab ? '1px solid #8b5cf6' : '1px solid transparent',
                                    color: settingsTab === tab ? '#8b5cf6' : '#52525b',
                                }}>{tab === 'model' ? 'Chat' : 'Keys'}</button>
                            ))}
                        </div>

                        {settingsTab === 'model' && (
                            <div style={{ padding: '10px 16px' }}>
                                <ProviderModelSelector
                                    providers={chat.providers.map(p => ({
                                        id: p.id,
                                        label: p.label + (p.is_local ? ' (local)' : ''),
                                        models: chat.providerModels[p.id] || (p.default_model ? [{ id: p.default_model, name: p.default_model, capabilities: [] }] : []),
                                    }))}
                                    selectedProvider={chat.selectedProvider}
                                    selectedModel={chat.selectedModel}
                                    onProviderChange={chat.setProvider}
                                    onModelChange={chat.setModel}
                                    loading={chat.loadingModels}
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#52525b', marginTop: 4 }}>
                                    <span>Active: <span style={{ fontFamily: 'monospace', color: '#8b5cf6' }}>{chat.selectedModel}</span></span>
                                </div>
                            </div>
                        )}

                        {settingsTab === 'keys' && (
                            <div style={{ padding: '8px 16px', maxHeight: 180, overflowY: 'auto' }}>
                                {chat.providers.filter(p => p.id !== 'claude' && !p.is_local).map(p => (
                                    <div key={p.id} style={{
                                        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                                    }}>
                                        <span style={{ fontSize: 10, color: '#52525b', width: 80, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                                        {editingKey === p.id ? (
                                            <div style={{ flex: 1, display: 'flex', gap: 4 }}>
                                                <input
                                                    type={showKeyText ? 'text' : 'password'} value={keyInput}
                                                    onChange={e => setKeyInput(e.target.value)}
                                                    placeholder="Paste API key..."
                                                    autoFocus
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter' && keyInput.trim()) { chat.saveApiKey(p.id, keyInput.trim()); setEditingKey(null); setKeyInput(''); }
                                                        if (e.key === 'Escape') { setEditingKey(null); setKeyInput(''); }
                                                    }}
                                                    style={{
                                                        flex: 1, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)',
                                                        borderRadius: 4, padding: '2px 8px', fontSize: 10, fontFamily: 'monospace', color: '#fafafa',
                                                    }}
                                                />
                                                <button onClick={() => setShowKeyText(!showKeyText)} style={{ fontSize: 9, color: '#52525b', background: 'none', border: 'none', cursor: 'pointer' }}>{showKeyText ? 'Hide' : 'Show'}</button>
                                                <button onClick={() => { if (keyInput.trim()) { chat.saveApiKey(p.id, keyInput.trim()); setEditingKey(null); setKeyInput(''); } }} style={{ fontSize: 9, color: '#8b5cf6', background: 'rgba(139,92,246,0.2)', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>Save</button>
                                                <button onClick={() => { setEditingKey(null); setKeyInput(''); }} style={{ fontSize: 9, color: '#52525b', background: 'none', border: 'none', cursor: 'pointer' }}>X</button>
                                            </div>
                                        ) : (
                                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                {chat.apiKeys[p.id] ? (
                                                    <>
                                                        <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#10b981' }}>{chat.maskKey(chat.apiKeys[p.id])}</span>
                                                        <button onClick={() => chat.clearApiKey(p.id)} style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                                                    </>
                                                ) : (
                                                    <span style={{ fontSize: 9, color: 'rgba(82,82,91,0.5)' }}>{p.has_key ? 'env' : 'not set'}</span>
                                                )}
                                                <button onClick={() => { setEditingKey(p.id); setKeyInput(chat.apiKeys[p.id] || ''); }} style={{ marginLeft: 'auto', fontSize: 9, color: 'rgba(139,92,246,0.7)', background: 'none', border: 'none', cursor: 'pointer' }}>{chat.apiKeys[p.id] ? 'Edit' : 'Add'}</button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                <div style={{ paddingTop: 4, fontSize: 9, color: 'rgba(82,82,91,0.4)', fontStyle: 'italic' }}>Keys stored in browser localStorage.</div>
                            </div>
                        )}
                    </div>
                )}

                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {chat.messages.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '40px 16px', color: '#52525b' }}>
                            <div style={{ fontSize: 28, marginBottom: 8 }}>&#10024;</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>How can I help?</div>
                            <div style={{ fontSize: 11 }}>Using {chat.selectedProvider} / {chat.selectedModel}</div>
                        </div>
                    ) : (
                        chat.messages.map(msg => (
                            <div key={msg.id} style={{
                                display: 'flex', gap: 8,
                                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                            }}>
                                {msg.role === 'assistant' && (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                                        <div style={{
                                            width: 24, height: 24, borderRadius: '50%',
                                            background: msg.isError ? 'rgba(239,68,68,0.2)' : 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: 12, color: 'white',
                                        }}>&#9679;</div>
                                        <span style={{ fontSize: 7, color: '#71717a', whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>GANTASMO</span>
                                    </div>
                                )}
                                <div style={{
                                    maxWidth: '85%', padding: '8px 12px', borderRadius: 12, fontSize: 12, lineHeight: 1.5,
                                    ...(msg.role === 'user'
                                        ? { background: '#8b5cf6', color: 'white', borderBottomRightRadius: 4 }
                                        : {
                                            background: msg.isError ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)',
                                            border: `1px solid ${msg.isError ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.1)'}`,
                                            borderBottomLeftRadius: 4, color: '#fafafa',
                                        }
                                    ),
                                }}>
                                    {msg.role === 'user' ? (
                                        <span>{msg.content}</span>
                                    ) : (
                                        <div className="orb-chat__prose" dangerouslySetInnerHTML={{ __html: simpleMarkdown(msg.content) }} />
                                    )}
                                    {msg.isStreaming && <span style={{ display: 'inline-block', width: 6, height: 14, background: '#8b5cf6', marginLeft: 2, animation: 'gantasmo-orb-core-breathe 1s ease-in-out infinite' }} />}
                                </div>
                                {msg.role === 'user' && (
                                    <div style={{
                                        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                                        background: 'rgba(255,255,255,0.1)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: 12, color: '#a1a1aa',
                                    }}>&#9679;</div>
                                )}
                            </div>
                        ))
                    )}

                    {chat.isProcessing && chat.statusText && (
                        <div style={{ fontSize: 10, color: '#52525b', padding: '4px 32px' }}>{chat.statusText}</div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Drag-over overlay */}
                {isDragging && (
                    <div style={{
                        position: 'absolute', inset: 0, zIndex: 20,
                        background: 'rgba(167,139,250,0.08)',
                        border: '2px dashed #a78bfa',
                        borderRadius: 16,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none',
                    }}>
                        <span style={{ fontSize: 13, color: '#a78bfa', fontWeight: 600 }}>Drop files to attach</span>
                    </div>
                )}

                {/* Input */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
                    {/* Attachment chips */}
                    {chat.attachments.length > 0 && (
                        <div style={{
                            display: 'flex', flexWrap: 'wrap', gap: 6,
                            padding: '6px 12px',
                        }}>
                            {chat.attachments.map(att => (
                                <div key={att.id} style={{
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    background: 'rgba(167,139,250,0.12)',
                                    border: '1px solid rgba(167,139,250,0.35)',
                                    borderRadius: 6, padding: '4px 8px',
                                    fontSize: 11, color: '#d4d4d8',
                                }}>
                                    <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {att.name.length > 24 ? att.name.slice(0, 24) + '\u2026' : att.name}
                                    </span>
                                    <span style={{ color: '#71717a', flexShrink: 0 }}>
                                        {Math.round(att.size / 1024)} KB
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => chat.removeAttachment(att.id)}
                                        style={{
                                            background: 'none', border: 'none', cursor: 'pointer',
                                            color: '#71717a', fontSize: 13, lineHeight: 1, padding: '0 2px',
                                        }}
                                        title="Remove attachment"
                                    >&times;</button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Input row */}
                    <form onSubmit={handleSubmit} style={{ padding: 12, display: 'flex', gap: 8 }}>
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="*/*"
                            onChange={handleFileChange}
                            style={{ display: 'none' }}
                        />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                                padding: '8px', borderRadius: 8, background: 'none',
                                border: '1px solid rgba(255,255,255,0.08)',
                                color: '#71717a', cursor: 'pointer', display: 'flex',
                                alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}
                            title="Attach files"
                        >
                            <Paperclip size={15} />
                        </button>
                        <input
                            ref={inputRef}
                            type="text" value={input} onChange={e => setInput(e.target.value)}
                            placeholder={chat.isProcessing ? 'Type to interrupt...' : 'Ask anything...'}
                            style={{
                                flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#fafafa', outline: 'none',
                            }}
                        />
                        {chat.isProcessing ? (
                            <button type="button" onClick={() => chat.stop?.()} style={{
                                padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                                background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)',
                                color: '#fca5a5', fontSize: 14,
                            }} title="Stop generation">&#9632;</button>
                        ) : (
                            <button type="submit" disabled={!input.trim() && chat.attachments.length === 0} style={{
                                padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                                background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
                                color: 'white', fontSize: 14,
                                opacity: (!input.trim() && chat.attachments.length === 0) ? 0.5 : 1,
                            }}>&#9654;</button>
                        )}
                    </form>
                </div>
            </div>
        </div>
    );
};

export default OrbChatPanel;
