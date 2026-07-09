export function bearerAuth(db, { verify }) {
  return (req, _res, next) => {
    req.user = null;
    const header = req.header("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) {
      const payload = verify(m[1]);
      if (payload) {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.uid);
        if (user) req.user = user;
      }
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  next();
}

export function publicUser(u) {
  return u ? { id: u.id, open_id: u.feishu_open_id, name: u.name, avatar: u.avatar, role: u.role } : null;
}
