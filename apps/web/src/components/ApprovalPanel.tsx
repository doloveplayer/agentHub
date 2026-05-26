import { useState, useCallback } from 'react';
import { Check, X, MessageSquare, Send, Loader2 } from 'lucide-react';

export interface ApprovalRequest {
  id: string;
  planId: string;
  taskId: string;
  agentName: string;
  output: string;
  replies: ApprovalReply[];
  status: 'waiting' | 'approved' | 'rejected';
  selectedReplyId?: string;
  createdAt: string;
}

export interface ApprovalReply {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  createdAt: string;
}

interface Props {
  request: ApprovalRequest;
  /** Called when user clicks Approve */
  onApprove: (taskId: string, comment?: string) => void;
  /** Called when user clicks Reject */
  onReject: (taskId: string, comment?: string) => void;
  /** Called when user sends a reply message */
  onReply: (taskId: string, message: string) => void;
  /** Whether a reply is currently being processed */
  replying?: boolean;
}

export function ApprovalPanel({ request, onApprove, onReject, onReply, replying }: Props) {
  const [replyText, setReplyText] = useState('');
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [comment, setComment] = useState('');

  const handleApprove = useCallback(() => {
    onApprove(request.taskId, comment || undefined);
  }, [request.taskId, comment, onApprove]);

  const handleReject = useCallback(() => {
    onReject(request.taskId, comment || undefined);
  }, [request.taskId, comment, onReject]);

  const handleReply = useCallback(() => {
    if (!replyText.trim()) return;
    onReply(request.taskId, replyText.trim());
    setReplyText('');
  }, [request.taskId, replyText, onReply]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleReply();
    }
  }, [handleReply]);

  const isResolved = request.status === 'approved' || request.status === 'rejected';

  return (
    <div className="mx-4 my-2 bg-hub-raised border border-hub-warning/40 rounded-hub-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-hub bg-hub-warning/5 flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-hub-warning animate-pulse" />
        <span className="text-sm font-medium text-hub-warning">
          Approval Required
        </span>
        <span className="text-xs text-hub-tertiary ml-auto">
          {request.agentName}
        </span>
      </div>

      {/* Output preview */}
      <div className="px-4 py-3">
        <div className="text-xs font-medium text-hub-secondary mb-1.5">
          Agent Output
        </div>
        <div className="bg-hub-surface rounded-hub p-3 text-xs text-hub-secondary font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
          {typeof request.output === 'string'
            ? request.output.slice(0, 2000)
            : JSON.stringify(request.output, null, 2).slice(0, 2000)
          }
          {typeof request.output === 'string' && request.output.length > 2000 && (
            <span className="text-hub-tertiary ml-1">...(truncated)</span>
          )}
        </div>
      </div>

      {/* Multi-round replies */}
      {request.replies.length > 0 && (
        <div className="px-4 py-2 border-t border-hub space-y-2">
          <div className="text-xs font-medium text-hub-secondary mb-1">
            Conversation ({request.replies.length})
          </div>
          {request.replies.map((reply) => (
            <div
              key={reply.id}
              className={`flex gap-2 text-xs ${
                reply.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              <div
                className={`max-w-[80%] rounded-hub-lg px-3 py-1.5 ${
                  reply.role === 'user'
                    ? 'bg-hub-accent/20 text-hub-accent'
                    : 'bg-hub-surface text-hub-secondary'
                }`}
              >
                <div className="whitespace-pre-wrap break-words">{reply.body}</div>
                <div className="text-[10px] text-hub-tertiary mt-0.5">
                  {reply.role === 'user' ? 'You' : request.agentName}
                  {' '}&middot;{' '}
                  {new Date(reply.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reply input */}
      {!isResolved && (showReplyInput ? (
        <div className="px-4 py-2 border-t border-hub">
          <div className="flex gap-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent to clarify or revise..."
              rows={2}
              className="flex-1 bg-hub-surface border border-hub rounded-hub px-3 py-1.5 text-xs text-hub-primary placeholder:text-hub-tertiary resize-none focus:outline-none focus:border-hub-accent"
              disabled={replying}
            />
            <button
              onClick={handleReply}
              disabled={!replyText.trim() || replying}
              className="self-end px-3 py-1.5 bg-hub-accent text-white rounded-hub text-xs hover:bg-hub-accent/90 disabled:opacity-40 flex items-center gap-1"
            >
              {replying ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              Send
            </button>
            <button
              onClick={() => setShowReplyInput(false)}
              className="self-end px-2 py-1.5 text-hub-tertiary hover:text-hub-secondary text-xs"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2 border-t border-hub">
          <button
            onClick={() => setShowReplyInput(true)}
            className="flex items-center gap-1.5 text-xs text-hub-accent hover:text-hub-accent/80"
          >
            <MessageSquare className="w-3 h-3" />
            Reply to agent
          </button>
        </div>
      ))}

      {/* Comment input */}
      {!isResolved && (
        <div className="px-4 py-2 border-t border-hub">
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment for approve/reject..."
            className="w-full bg-hub-surface border border-hub rounded-hub px-3 py-1.5 text-xs text-hub-primary placeholder:text-hub-tertiary focus:outline-none focus:border-hub-accent"
          />
        </div>
      )}

      {/* Action buttons */}
      {isResolved ? (
        <div className="px-4 py-2.5 border-t border-hub bg-hub-surface flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              request.status === 'approved' ? 'bg-hub-success' : 'bg-hub-danger'
            }`}
          />
          <span className="text-xs text-hub-secondary">
            {request.status === 'approved' ? 'Approved' : 'Rejected'}
            {request.selectedReplyId && ' (with reply selected)'}
          </span>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-hub bg-hub-surface flex items-center gap-2">
          <button
            onClick={handleApprove}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-hub text-xs font-medium bg-hub-success/15 text-hub-success border border-hub-success/30 hover:bg-hub-success/25 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            Approve
          </button>
          <button
            onClick={handleReject}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-hub text-xs font-medium bg-hub-danger/15 text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/25 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Reject
          </button>
          <span className="text-[10px] text-hub-tertiary ml-auto">
            {new Date(request.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      )}
    </div>
  );
}
