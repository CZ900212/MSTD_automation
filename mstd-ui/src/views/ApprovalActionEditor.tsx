import { useMemo, useState } from "react";
import type { ActionDraft } from "../api/jobs";

const isValidOpenId = (v: unknown): v is string => typeof v === "string" && /^ou_/.test(v);

function assigneeOf(a: ActionDraft): string {
  const v = a.payload.assignee_open_id ?? a.payload.to_open_id ?? a.target_open_id;
  return typeof v === "string" ? v : "";
}

export function ApprovalActionEditor({
  actions, onApprove, onReject,
}: {
  actions: ActionDraft[];
  onApprove: (edited: ActionDraft[]) => void;
  onReject: (note: string) => void;
}) {
  const [openIds, setOpenIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(actions.map((a) => [a.action_key, assigneeOf(a)]))
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");

  const kept = useMemo(
    () => actions.filter((a) => !removed.has(a.action_key)),
    [actions, removed]
  );

  const canApprove = useMemo(
    () => kept.length > 0 && kept.every((a) => !a.requires_open_id || isValidOpenId(openIds[a.action_key])),
    [kept, openIds]
  );

  function toggleRemoved(actionKey: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(actionKey)) next.delete(actionKey);
      else next.add(actionKey);
      return next;
    });
  }

  function submitApprove() {
    const edited = kept.map((a) => ({
      ...a,
      target_open_id: openIds[a.action_key] || a.target_open_id,
      payload: { ...a.payload, assignee_open_id: openIds[a.action_key] || a.payload.assignee_open_id },
    }));
    onApprove(edited);
  }

  return (
    <div className="approval-editor">
      <ul className="action-list">
        {actions.map((a) => {
          const value = openIds[a.action_key] ?? "";
          const isRemoved = removed.has(a.action_key);
          const invalid = !isRemoved && a.requires_open_id && !isValidOpenId(value);
          return (
            <li key={a.action_key} className={`action-item${isRemoved ? " removed" : ""}`}>
              <div className="action-head">
                <b>{String(a.payload.title ?? a.kind)}</b>
                <span className={`confidence-badge ${a.requires_open_id ? "low" : "high"}`}>
                  {a.requires_open_id ? "低置信 · 需人工补齐" : "高置信"}
                </span>
                <button type="button" className="ghost" onClick={() => toggleRemoved(a.action_key)}>
                  {isRemoved ? "恢复" : "删除"}
                </button>
              </div>
              <label>
                负责人 open_id
                <input
                  className={`open-id-input ${invalid ? "invalid" : ""}`}
                  value={value}
                  placeholder="ou_ 开头"
                  disabled={isRemoved}
                  onChange={(e) => setOpenIds((prev) => ({ ...prev, [a.action_key]: e.target.value }))}
                />
              </label>
              {invalid && <small className="hint">必须补齐合法 ou_ open_id 才可批准</small>}
            </li>
          );
        })}
      </ul>
      <textarea placeholder="审批备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button type="button" className="primary" disabled={!canApprove} onClick={submitApprove}>批准并真写</button>
        <button type="button" className="ghost" onClick={() => onReject(note)}>驳回</button>
      </div>
      {kept.length === 0 && <small className="hint">全部删除请直接驳回</small>}
    </div>
  );
}
