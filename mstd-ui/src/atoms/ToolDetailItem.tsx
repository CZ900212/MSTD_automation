import { useState } from "react";

export type ToolStatus = "running" | "done" | "error";
export type ToolActivity = {
  toolCallId: string;
  toolName: string;
  status: ToolStatus;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

function compactJson(value: unknown) {
  if (!value) return "";
  try {
    return JSON.stringify(value).replace(/[{}"]/g, "").replace(/,/g, "，").slice(0, 120);
  } catch {
    return "";
  }
}

function prettyJson(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolLabel(tool: ToolActivity) {
  if (tool.status === "running") return `${tool.toolName}：执行中`;
  if (tool.status === "error") return `${tool.toolName}：失败`;
  return `${tool.toolName}：已完成`;
}

export function ToolDetailItem({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(tool.status === "error");
  const resultText = prettyJson(tool.result);
  const canExpand = Boolean(resultText) || Boolean(tool.args);

  return (
    <div className={`tool-detail ${tool.status}`} key={tool.toolCallId}>
      <span className="tool-detail-dot" aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <b>{toolLabel(tool)}</b>
          {tool.args ? <small> 参数：{compactJson(tool.args)}</small> : null}
          {canExpand ? (
            <button
              type="button"
              className="ghost"
              style={{ fontSize: 12, padding: "0 4px" }}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "收起" : "展开"}
            </button>
          ) : null}
        </div>
        {open && (
          <pre
            style={{
              margin: "6px 0 0",
              padding: 8,
              background: "rgba(0,0,0,0.04)",
              borderRadius: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              maxHeight: 240,
              overflow: "auto",
            }}
          >
            {tool.result != null
              ? resultText
              : tool.args
                ? `参数原文：\n${prettyJson(tool.args)}`
                : "（无结果）"}
          </pre>
        )}
      </div>
    </div>
  );
}
