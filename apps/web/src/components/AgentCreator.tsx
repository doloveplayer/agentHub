import { useState, useRef } from 'react';
import { Upload, FileText, X, Check } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  onCreated?: (agent: any) => void;
  onCancel?: () => void;
}

export function AgentCreator({ onCreated, onCancel }: Props) {
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<{
    name: string;
    displayName: string;
    description: string;
    provider: string;
    systemPrompt: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseFrontmatter = (text: string) => {
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      setError('No frontmatter found. Expected format:\n---\nname: my-agent\ndisplayName: My Agent\ndescription: ...\nprovider: claude-code\n---\nSystem prompt here...');
      return null;
    }

    const frontmatterText = fmMatch[1];
    const systemPrompt = fmMatch[2].trim();

    const meta: Record<string, string> = {};
    for (const line of frontmatterText.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }

    return {
      name: meta.name || `custom-${Date.now()}`,
      displayName: meta.displayName || meta.name || 'Custom Agent',
      description: meta.description || 'Custom agent',
      provider: meta.provider || 'claude-code',
      systemPrompt,
    };
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      setContent(text);
      const parsed = parseFrontmatter(text);
      if (parsed) {
        setPreview(parsed);
        setError(null);
      }
    };
    reader.readAsText(file);
  };

  const handleTextChange = (text: string) => {
    setContent(text);
    if (text.trim()) {
      const parsed = parseFrontmatter(text);
      if (parsed) {
        setPreview(parsed);
        setError(null);
      } else {
        setPreview(null);
      }
    } else {
      setPreview(null);
      setError(null);
    }
  };

  const handleCreate = async () => {
    if (!content.trim()) {
      setError('Please provide agent content');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const agent = await api.createAgentFromMd(content);
      onCreated?.(agent);
    } catch (err: any) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
        <h3 className="text-body font-semibold text-hub-primary">Create Agent from Markdown</h3>
        {onCancel && (
          <button onClick={onCancel} className="p-1 rounded hover:bg-hub-hover text-hub-muted">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* File upload */}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-hub border-dashed
                       hover:border-hub-accent hover:bg-hub-hover transition w-full justify-center"
          >
            <Upload className="w-4 h-4 text-hub-muted" />
            <span className="text-sm text-hub-secondary">Upload .md file</span>
          </button>
        </div>

        {/* Or paste text */}
        <div>
          <label className="text-caption text-hub-tertiary mb-1 block">Or paste markdown content:</label>
          <textarea
            value={content}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={`---
name: my-agent
displayName: My Agent
description: A custom agent
provider: claude-code
---
You are a helpful assistant...`}
            className="w-full h-48 px-3 py-2 rounded-lg bg-hub-surface border border-hub
                       text-hub-primary text-sm font-mono resize-none focus:border-hub-accent focus:outline-none"
          />
        </div>

        {/* Preview */}
        {preview && (
          <div className="p-3 rounded-lg bg-hub-surface border border-hub">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-hub-accent" />
              <span className="text-sm font-medium text-hub-primary">Preview</span>
            </div>
            <div className="space-y-1 text-caption">
              <p><span className="text-hub-tertiary">Name:</span> <span className="text-hub-primary">{preview.name}</span></p>
              <p><span className="text-hub-tertiary">Display:</span> <span className="text-hub-primary">{preview.displayName}</span></p>
              <p><span className="text-hub-tertiary">Description:</span> <span className="text-hub-primary">{preview.description}</span></p>
              <p><span className="text-hub-tertiary">Provider:</span> <span className="text-hub-primary">{preview.provider}</span></p>
              <p><span className="text-hub-tertiary">Prompt length:</span> <span className="text-hub-primary">{preview.systemPrompt.length} chars</span></p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 rounded-lg bg-hub-danger/10 border border-hub-danger/20 text-hub-danger text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hub">
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-hub-secondary hover:bg-hub-hover transition"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleCreate}
          disabled={!preview || loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-hub-accent text-white text-sm
                     hover:bg-hub-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {loading ? (
            <span className="animate-spin">⏳</span>
          ) : (
            <Check className="w-4 h-4" />
          )}
          Create Agent
        </button>
      </div>
    </div>
  );
}
