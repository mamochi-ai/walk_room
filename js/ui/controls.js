// 入力：左側＝仮想スティック（移動）、右側＝ドラッグ（視点）、PC は WASD／矢印＋マウスドラッグ
// 指を離す・操作中断・タブ切り替え・フォーカス喪失で移動を止める。

export class Controls {
  constructor(surface, stickEl, knobEl) {
    this.surface = surface;
    this.stickEl = stickEl;
    this.knobEl = knobEl;
    this.move = { x: 0, y: 0 }; // x: 右+, y: 前+（-1..1）
    this.lookDelta = { x: 0, y: 0 };
    this.keys = new Set();
    this.stickId = null;
    this.lookId = null;
    this.stickOrigin = null;
    this.lastLook = null;
    this.enabled = true;
    this.stickRadius = 56;
    this._bind();
  }

  _bind() {
    const s = this.surface;
    s.addEventListener('pointerdown', (e) => this._down(e));
    s.addEventListener('pointermove', (e) => this._moveEv(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) s.addEventListener(t, (e) => this._up(e));
    // iOS Safari のスクロール・拡大操作を抑止
    s.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    s.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    s.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    const stopAll = () => this.stopAll();
    window.addEventListener('blur', stopAll);
    window.addEventListener('pagehide', stopAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); });
  }

  stopAll() {
    this.keys.clear();
    this.stickId = null;
    this.lookId = null;
    this.move.x = this.move.y = 0;
    this.lookDelta.x = this.lookDelta.y = 0;
    this._showStick(false);
  }

  _down(e) {
    if (!this.enabled) return;
    const rect = this.surface.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width * 0.45;
    if (e.pointerType === 'mouse') {
      // マウスは常に視点操作（移動はキーボード）
      if (this.lookId === null) this._startLook(e);
      return;
    }
    if (isLeft && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this._showStick(true, e.clientX - rect.left, e.clientY - rect.top);
      this._capture(e);
    } else if (this.lookId === null) {
      this._startLook(e);
    }
  }
  _startLook(e) {
    this.lookId = e.pointerId;
    this.lastLook = { x: e.clientX, y: e.clientY };
    this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    this._capture(e);
  }
  _capture(e) {
    try { this.surface.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }

  _moveEv(e) {
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.stickOrigin.x, dy = e.clientY - this.stickOrigin.y;
      const d = Math.hypot(dx, dy), R = this.stickRadius;
      if (d > R) { dx *= R / d; dy *= R / d; }
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = 0.12;
      const mx = dx / R, my = -dy / R;
      const m = Math.hypot(mx, my);
      const k = m < dead ? 0 : (m - dead) / (1 - dead) / m;
      this.move.x = mx * k;
      this.move.y = my * k;
    } else if (e.pointerId === this.lookId) {
      this.lookDelta.x += e.clientX - this.lastLook.x;
      this.lookDelta.y += e.clientY - this.lastLook.y;
      this.lastLook = { x: e.clientX, y: e.clientY };
    }
  }

  _up(e) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.move.x = this.move.y = 0;
      this._showStick(false);
    }
    if (e.pointerId === this.lookId) {
      this.lookId = null;
      const ts = this.tapStart;
      if (e.type === 'pointerup' && ts && Math.hypot(e.clientX - ts.x, e.clientY - ts.y) < 10 && performance.now() - ts.t < 400) {
        const rect = this.surface.getBoundingClientRect();
        this.onTap?.(e.clientX - rect.left, e.clientY - rect.top);
      }
      this.tapStart = null;
    }
  }

  _showStick(on, x, y) {
    this.stickEl.classList.toggle('active', on);
    if (on) {
      this.stickEl.style.left = x + 'px';
      this.stickEl.style.top = y + 'px';
    }
    this.knobEl.style.transform = 'translate(0px, 0px)';
  }

  // 現在の移動入力（スティック＋キー）と視点変化量を取り出す
  read() {
    let x = this.move.x, y = this.move.y, turn = 0;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) y += 1;
    if (k.has('s') || k.has('arrowdown')) y -= 1;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    if (k.has('q')) turn -= 1;
    if (k.has('e')) turn += 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    const look = { x: this.lookDelta.x, y: this.lookDelta.y };
    this.lookDelta.x = this.lookDelta.y = 0;
    return { x, y, turn, look };
  }
}
