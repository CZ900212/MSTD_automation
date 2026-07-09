export const TEMPLATES = {
  meeting_to_task: { id: "meeting_to_task", title: "会议纪要 → 建任务", enableNotify: false },
};

const FENCE = "`".repeat(3);
const INTENT_CONTRACT = [
  `你必须在最终回复中只输出一个 JSON 对象（可包在 ${FENCE}json 代码块里），形如：`,
  '{"card_text":"<给审批人看的中文卡片文案>","items":[{"owner_name":"张三","task":"...","due":"2026-07-15 或 null","suggested_open_id":"ou_xxx 或 null","confidence":"high|low"}]}',
  "无法确定负责人 open_id 时填 null 且 confidence 设 low。严禁任何写操作（只允许只读工具）。",
].join("\n");

export function buildPrompt(templateId, params = {}) {
  if (templateId !== "meeting_to_task") throw new Error(`unknown/未知模板: ${templateId}`);
  const scope = params.minute_token
    ? `只处理妙记 minute_token=${String(params.minute_token)}。`
    : "搜索我拥有的最近妙记，选择最相关的一条处理。";
  return [
    "你是会议纪要处理助手。第一阶段【只读】：",
    scope,
    "步骤：搜索/定位妙记 → 导出并阅读逐字稿 → 抽取待办事项（负责人、事项、截止、建议 open_id、置信度）→ 生成审批卡文案。",
    INTENT_CONTRACT,
  ].join("\n");
}
