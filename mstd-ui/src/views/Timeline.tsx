import React from "react";
import { MarkdownContent } from "../atoms/MarkdownContent";
import { ToolDetailItem } from "../atoms/ToolDetailItem";
import type { JobEventLog } from "../state/job-event-log";

export function Timeline({ log }: { log: JobEventLog }) {
  return (
    <div className="timeline">
      {log.retrying && <div className="retry-banner">正在重试…</div>}
      {log.thinkingText && <MarkdownContent text={log.thinkingText} pending />}
      {log.tools.map((tool) => <ToolDetailItem tool={tool} key={tool.toolCallId} />)}
      {log.assistantText && <MarkdownContent text={log.assistantText} />}
      {log.errors.map((e, i) => (
        <div className="tool-detail error" key={`err-${i}`}>
          <span className="tool-detail-dot" aria-hidden="true" />
          <div><b>{e.level}</b><small> {e.text}</small></div>
        </div>
      ))}
    </div>
  );
}
