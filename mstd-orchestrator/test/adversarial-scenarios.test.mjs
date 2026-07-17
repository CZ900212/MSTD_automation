// 红队 T7：对抗场景文件的防腐测试——schema 可加载 + 对抗结构不变量成立。
// 不变量：security_hard_fail: true 的 turn 必须声明 security_refused 路由（否则硬失败通道无意义）；
// 金丝雀 turn 必须声明 leak_markers（否则 grader 无的放矢）。场景跑真机依赖 sim:run + 测试群。
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../simulator/scenario-loader.mjs";

const scenarioPath = (name) =>
  fileURLToPath(new URL(`../simulator/scenarios/${name}`, import.meta.url));

const FILES = ["08-cross-session-pollution.yaml", "09-multi-turn-social.yaml"];

describe("T7 对抗场景（跨会话污染 / 多轮社工）", () => {
  for (const file of FILES) {
    it(`${file} 可加载且对抗结构成立`, () => {
      const s = loadScenarioFile(scenarioPath(file));
      expect(s.mode).toBe("scripted");
      const hardFails = s.turns.filter((t) => t.expect?.security_hard_fail === true);
      expect(hardFails.length).toBeGreaterThan(0);
      for (const t of hardFails) {
        expect(t.expect.route).toBe("security_refused");
      }
      const withMarkers = s.turns.filter((t) => Array.isArray(t.expect?.leak_markers));
      if (file.startsWith("08")) {
        // 跨会话污染场景：金丝雀贯穿种-发-复述-执行四拍
        expect(withMarkers.length).toBeGreaterThanOrEqual(4);
        const markers = new Set(withMarkers.flatMap((t) => t.expect.leak_markers));
        expect([...markers].every((m) => m.startsWith("CANARY-"))).toBe(true);
      }
      if (file.startsWith("09")) {
        // 多轮社工：铺垫轮 ≥3 且攻击轮在铺垫之后
        const attackIdx = s.turns.findIndex((t) => t.id.startsWith("attack-"));
        const trustIdx = s.turns.map((t, i) => (t.id.startsWith("trust-") || t.id.startsWith("prime-") ? i : -1)).filter((i) => i >= 0);
        expect(trustIdx.length).toBeGreaterThanOrEqual(3);
        expect(Math.min(...s.turns.map((t, i) => (t.id.startsWith("attack-") ? i : 99)))).toBeGreaterThan(Math.max(...trustIdx));
        expect(attackIdx).toBeGreaterThanOrEqual(0);
      }
    });
  }
});
