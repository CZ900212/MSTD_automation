export function escapeLarkText(text) {
  return String(text ?? "")
    .replace(/\{\{|\}\}/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderNotifyCard(cardText) {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: escapeLarkText(cardText) } },
    ],
  };
}
