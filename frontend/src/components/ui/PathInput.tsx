import React, { useState } from 'react';
import { FolderOpen, FileSearch, Loader2 } from 'lucide-react';
import { pickFile, pickFolder } from '../../lib/storageClient';

interface PathInputProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: 'folder' | 'file';
  placeholder?: string;
  description?: string;
  disabled?: boolean;
  onBlur?: () => void;
  onEnter?: () => void;
  className?: string;
}

export const PathInput: React.FC<PathInputProps> = ({
  id,
  name,
  label,
  value,
  onChange,
  kind,
  placeholder,
  description,
  disabled = false,
  onBlur,
  onEnter,
  className = '',
}) => {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    if (disabled || picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = kind === 'folder' ? await pickFolder() : await pickFile();
      if (!result.cancelled && result.path) onChange(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const buttonLabel = kind === 'folder' ? `Browse for ${label} folder` : `Browse for ${label} file`;

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-[9px] font-mono uppercase tracking-wider text-zinc-400">
        {label}
      </label>
      <div className="flex gap-1.5">
        <input
          id={id}
          name={name}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (onEnter) onEnter();
              else (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={disabled}
          spellCheck={false}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={disabled || picking}
          aria-label={buttonLabel}
          title={buttonLabel}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-purple-400/40 hover:bg-purple-500/15 hover:text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {picking ? <Loader2 className="w-3 h-3 animate-spin" /> : kind === 'folder' ? <FolderOpen className="w-3 h-3" /> : <FileSearch className="w-3 h-3" />}
          Browse
        </button>
      </div>
      {description && <p className="text-[8px] text-zinc-600 leading-relaxed">{description}</p>}
      {error && <p className="text-[8px] text-red-300 leading-relaxed">{error}</p>}
    </div>
  );
};