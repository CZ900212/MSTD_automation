import React from "react";

export function LoginFeishu({ onStart }: { onStart: () => void }) {
  return (
    <main className="login-shell">
      <section className="login-copy">
        <h1>MSTD<br />自动化工作台。</h1>
        <div className="login-card">
          <p>用飞书账号登录，身份即你的飞书 open_id（发起 / 审批 / 派活对象）。</p>
          <button className="primary" type="button" onClick={onStart}>飞书扫码登录</button>
        </div>
      </section>
      <aside className="login-preview" aria-label="工作台预览图">
        <img src="/mstd-hero.jpg" alt="MSTD 工作台展示图" />
      </aside>
    </main>
  );
}
