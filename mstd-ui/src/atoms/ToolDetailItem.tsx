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

function toolLabel(tool: ToolActivity) {
  if (tool.status === "running") return `${tool.toolName}：执行中`;
  if (tool.status === "error") return `${tool.toolName}：失败`;
  return `${tool.toolName}：已完成`;
}

export function ToolDetailItem({ tool }: { tool: ToolActivity }) {
  return (
    <div className={`tool-detail ${tool.status}`} key={tool.toolCallId}>
      <span className="tool-detail-dot" aria-hidden="true" />
      <div>
        <b>{toolLabel(tool)}</b>
        {tool.args ? <small> 参数：{compactJson(tool.args)}</small> : null}
      </div>
    </div>
  );
}
