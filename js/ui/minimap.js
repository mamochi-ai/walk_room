// ミニマップ（北が上）。3D と同じローカル座標（x=東, z=南）をそのまま使う。
import { DATA_RADIUS, WALK_RADIUS } from '../config.js';

const PPM = 1.25; // 下地の解像度（px/m）
const CAT_COLOR = { convenience: '#2e8b57', supermarket: '#c2602b', station: '#2f6db5' };

export class Minimap {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.big = false;
    this.base = this._renderBase();
    this.hitTargets = [];
  }

  _renderBase() {
    const size = Math.ceil(DATA_RADIUS * 2 * PPM);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const T = (x, z) => [(x + DATA_RADIUS) * PPM, (z + DATA_RADIUS) * PPM];
    g.fillStyle = '#dcd8cc';
    g.fillRect(0, 0, size, size);
    g.lineCap = g.lineJoin = 'round';
    g.strokeStyle = '#ffffff';
    for (const w of this.data.walk) {
      g.lineWidth = Math.max(1.2, w.half * 2 * PPM);
      g.beginPath();
      w.pts.forEach((p, i) => { const [x, y] = T(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    const fillRings = (rings) => {
      g.beginPath();
      for (const r of rings) r.forEach((p, i) => { const [x, y] = T(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath();
      g.fill('evenodd');
    };
    g.fillStyle = '#c9c6bf';
    for (const b of this.data.buildings) fillRings(b.rings);
    if (this.data.target) { g.fillStyle = '#d9773b'; fillRings([this.data.target.ring]); }
    g.strokeStyle = 'rgba(192,57,43,0.7)';
    g.lineWidth = 2;
    g.setLineDash([6, 5]);
    g.beginPath();
    const [cx, cy] = T(0, 0);
    g.arc(cx, cy, WALK_RADIUS * PPM, 0, Math.PI * 2);
    g.stroke();
    return c;
  }

  setBig(on) {
    this.big = on;
    this.canvas.classList.toggle('big', on);
  }

  draw(st) {
    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 表示スケール（px/m）と中心
    const scale = this.big ? Math.min(w, h) / (WALK_RADIUS * 2.15) : Math.min(w, h) / 260;
    const cxm = this.big ? 0 : st.x, czm = this.big ? 0 : st.z;
    const S = (x, z) => [w / 2 + (x - cxm) * scale, h / 2 + (z - czm) * scale];
    g.fillStyle = '#ebe8e1';
    g.fillRect(0, 0, w, h);
    const [ox, oy] = S(-DATA_RADIUS, -DATA_RADIUS);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, ox, oy, DATA_RADIUS * 2 * scale, DATA_RADIUS * 2 * scale);

    // 経路
    if (st.route && st.route.length > 1) {
      g.strokeStyle = '#2f7fd0'; g.lineWidth = 3.5; g.lineJoin = 'round';
      g.beginPath();
      st.route.forEach((p, i) => { const [x, y] = S(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    // 施設
    this.hitTargets = [];
    for (const p of st.pois) {
      const [x, y] = S(p.x, p.z);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      const isDest = st.dest && st.dest.id === p.id;
      g.fillStyle = CAT_COLOR[p.cat];
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, isDest ? 7 : this.big ? 5.5 : 4, 0, Math.PI * 2); g.fill(); g.stroke();
      if (isDest) { g.strokeStyle = '#2f7fd0'; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke(); }
      if (this.big) {
        g.font = '600 11px -apple-system, "Hiragino Sans", sans-serif';
        g.fillStyle = '#222'; g.textBaseline = 'middle';
        g.fillText(p.name, x + 8, y);
      }
      this.hitTargets.push({ x, y, poi: p });
    }
    // 目的地が画面外なら縁に方向を表示
    if (st.dest && !this.big) {
      const [x, y] = S(st.dest.x, st.dest.z);
      if (x < 0 || y < 0 || x > w || y > h) {
        const a = Math.atan2(y - h / 2, x - w / 2);
        const r = Math.min(w, h) / 2 - 8;
        g.fillStyle = '#2f7fd0';
        g.beginPath(); g.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 5, 0, Math.PI * 2); g.fill();
      }
    }
    // 現在地と向き（yaw=0 が北）
    const [px, py] = S(st.x, st.z);
    const dir = -st.yaw; // 画面上の回転角（北=上 から時計回り）
    g.save();
    g.translate(px, py);
    g.rotate(dir);
    g.fillStyle = 'rgba(47,127,208,0.18)';
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, this.big ? 40 : 34, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    g.fillStyle = '#1d4f8c'; g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6.5, 7); g.lineTo(0, 3.5); g.lineTo(-6.5, 7); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // 方位
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(14, 14, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c0392b'; g.font = '700 11px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', 14, 14.5);
    g.textAlign = 'start';
    // 縮尺
    const barM = this.big ? 200 : 50;
    g.fillStyle = '#333'; g.fillRect(w - 12 - barM * scale, h - 10, barM * scale, 2.5);
    g.font = '600 10px -apple-system, sans-serif'; g.textAlign = 'right';
    g.fillText(`${barM}m`, w - 12, h - 18);
    g.textAlign = 'start';
  }

  hit(x, y) {
    let best = null, bd = 18;
    for (const t of this.hitTargets) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bd) { bd = d; best = t.poi; }
    }
    return best;
  }
}
