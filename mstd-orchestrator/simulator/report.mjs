export function renderReportMarkdown(report) {
  const lines = [
    `# Simulator report: ${report.scenarioId}`,
    "",
    `- status: **${report.status}**`,
    `- run: \`${report.runId}\``,
    `- scope: ${report.scope ?? "single_session"}`,
    `- route accuracy: ${(report.routes.accuracy * 100).toFixed(1)}% (${report.routes.matched}/${report.routes.total})`,
    "",
    "## Critical mismatches",
    "",
  ];
  if (!report.routes.critical_mismatches?.length) {
    lines.push("_none_");
  } else {
    for (const c of report.routes.critical_mismatches) {
      lines.push(`- \`${c.turnId}\`: ${c.error} (expected ${c.expected}${c.actual ? ` actual ${c.actual}` : ""})`);
    }
  }
  lines.push("", "## Latency", "");
  lines.push(`- ack p50/p95/p99: ${fmtP(report.latency_ms.ack)}`);
  lines.push(`- terminal p50/p95/p99: ${fmtP(report.latency_ms.terminal)}`);
  lines.push("", "## Models", "");
  lines.push(`- retries: ${report.models.retries}, fallbacks: ${report.models.fallbacks}, tokens: ${report.models.tokens}`);
  lines.push("", "## Safety", "");
  lines.push(`- unauthorized_writes: ${report.safety.unauthorized_writes}`);
  lines.push(`- cross_scope: ${report.safety.cross_scope}`);
  lines.push(`- sensitive_bytes_out: ${report.safety.sensitive_bytes_out}`);
  lines.push("");
  return lines.join("\n");
}

function fmtP(p) {
  if (!p) return "n/a";
  return `${p.p50}/${p.p95}/${p.p99} (n=${p.n})`;
}
