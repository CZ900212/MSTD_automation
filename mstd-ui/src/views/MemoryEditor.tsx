import { useEffect, useState } from "react";
import { readMemory, writeMemory, listDreamReports, readDreamReport, listSessions } from "../api/admin";

type LayerRef = { layer: string; id?: string; label: string };

// 记忆编辑器（G5）：五层树导航 + 编辑保存带 snapshotHash（漂移冲突提示重载）+ dreams 只读。
export function MemoryEditor() {
  const [layers, setLayers] = useState<LayerRef[]>([
    { layer: "soul", label: "SOUL.md（人格）" },
    { layer: "org", label: "ORG.md（公司事实）" },
  ]);
  const [dreams, setDreams] = useState<string[]>([]);
  const [current, setCurrent] = useState<LayerRef | null>(null);
  const [content, setContent] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [readonly, setReadonly] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    // 从会话推导 群/人 记忆层
    listSessions().then((sessions) => {
      const extra: LayerRef[] = [];
      for (const s of sessions) {
        if (s.kind === "group" && s.chat_id) extra.push({ layer: "group", id: s.chat_id, label: `群：${s.title || s.chat_id}` });
        if (s.kind === "p2p") {
          const openId = s.session_key.split(":")[2];
          extra.push({ layer: "user", id: openId, label: `人：${s.title || openId}` });
        }
      }
      const seen = new Set<string>();
      setLayers((base) => [...base, ...extra.filter((x) => {
        const k = `${x.layer}:${x.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })]);
    }).catch(() => {});
    listDreamReports().then(setDreams).catch(() => {});
  }, []);

  async function open(ref: LayerRef) {
    setCurrent(ref);
    setStatus("");
    if (ref.layer === "dreams") {
      setContent(await readDreamReport(ref.id!));
      setHash(null);
      setReadonly(true);
      return;
    }
    const r = await readMemory(ref.layer, ref.id);
    setContent(r.content);
    setHash(r.snapshotHash);
    setReadonly(false);
  }

  async function save() {
    if (!current || readonly) return;
    try {
      const r = await writeMemory(current.layer, current.id, content, hash);
      setHash(r.snapshotHash);
      setStatus("✅ 已保存");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes("外部修改") || msg.includes("409")) {
        setStatus("⚠️ 检测到外部漂移：文件已被他处修改（已 .bak 备份）。请重新载入后再编辑。");
      } else {
        setStatus(`❌ 保存失败：${msg}`);
      }
    }
  }

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ width: 260, flexShrink: 0 }}>
        <h3>记忆层</h3>
        <ul>
          {layers.map((l) => (
            <li key={`${l.layer}:${l.id ?? ""}`}>
              <button type="button" className="ghost" onClick={() => { void open(l); }}>{l.label}</button>
            </li>
          ))}
        </ul>
        <h4>dreams 报告（只读）</h4>
        <ul>
          {dreams.map((d) => (
            <li key={d}>
              <button type="button" className="ghost" onClick={() => { void open({ layer: "dreams", id: d.replace(/\.md$/, ""), label: d }); }}>{d}</button>
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        {!current ? <p>选择左侧记忆层</p> : (
          <>
            <h3>{current.label}</h3>
            <textarea
              value={content}
              readOnly={readonly}
              onChange={(e) => setContent(e.target.value)}
              style={{ width: "100%", minHeight: 360, fontFamily: "monospace" }}
            />
            {!readonly && <div><button type="button" onClick={() => { void save(); }}>保存</button> <button type="button" className="ghost" onClick={() => { void open(current); }}>重新载入</button></div>}
            {status && <p>{status}</p>}
          </>
        )}
      </div>
    </div>
  );
}
