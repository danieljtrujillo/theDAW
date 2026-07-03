import React, { useState, useEffect, useRef } from 'react';

export function ConfirmModal({ isOpen, title, message, onConfirm, onCancel, confirmText = "Confirm", cancelText = "Cancel" }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-app-base border border-app-border p-6 rounded-xl shadow-2xl max-w-sm w-full">
        <h2 className="text-lg font-bold text-app-main mb-2">{title}</h2>
        <p className="text-sm text-app-muted mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-app-muted hover:text-app-main">
            {cancelText}
          </button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-app-accent hover:bg-app-accent-hover text-white rounded-lg">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PromptModal({ isOpen, title, message, defaultValue = "", onConfirm, onCancel, confirmText = "Save", cancelText = "Cancel" }: any) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-app-base border border-app-border p-6 rounded-xl shadow-2xl max-w-sm w-full">
        <h2 className="text-lg font-bold text-app-main mb-2">{title}</h2>
        <p className="text-sm text-app-muted mb-4">{message}</p>
        <input 
          ref={inputRef}
          type="text" 
          value={value} 
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onConfirm(value);
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full bg-app-surface border border-app-border rounded px-3 py-2 text-app-main mb-6 outline-none focus:border-app-accent"
        />
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-app-muted hover:text-app-main">
            {cancelText}
          </button>
          <button onClick={() => onConfirm(value)} className="px-4 py-2 text-sm bg-app-accent hover:bg-app-accent-hover text-white rounded-lg">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
