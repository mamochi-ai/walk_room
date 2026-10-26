// 位置の確認用の地図（地理院タイル）。候補ピン・物件位置ピン・建物入口ピンを扱う。
import * as L from '../../vendor/leaflet/leaflet-src.esm.js';
import { SOURCES } from '../config.js';

const pinIcon = (cls, text) => L.divIcon({ className: `map-pin ${cls}`, html: `<span>${text}</span>`, iconSize: [30, 30], iconAnchor: [15, 30] });

export class MapPicker {
  constructor(el, center) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([center.lat, center.lon], center.zoom || 16);
    L.tileLayer(SOURCES.gsiTiles.url, { maxZoom: SOURCES.gsiTiles.maxZoom, attribution: SOURCES.gsiTiles.attribution }).addTo(this.map);
    this.candLayer = L.layerGroup().addTo(this.map);
    this.pin = null;
    this.entrance = null;
    this.mode = 'pin'; // 地図タップで置くもの: 'pin' | 'entrance' | null
    this.onChange = null;
    this.map.on('click', (e) => {
      if (this.mode === 'pin') this.setPin(e.latlng.lat, e.latlng.lng, true);
      else if (this.mode === 'entrance') this.setEntrance(e.latlng.lat, e.latlng.lng, true);
    });
    this.t = setTimeout(() => this.map && this.map._loaded && this.map.invalidateSize(), 50);
  }
  showCandidates(list, onPick) {
    this.candLayer.clearLayers();
    list.forEach((c, i) => {
      const m = L.marker([c.lat, c.lon], { icon: pinIcon('cand', String(i + 1)) }).addTo(this.candLayer);
      m.on('click', () => onPick?.(i));
    });
    if (list.length) this.map.fitBounds(L.latLngBounds(list.map((c) => [c.lat, c.lon])).pad(0.4), { maxZoom: 17, animate: false });
  }
  setPin(lat, lon, user = false) {
    if (!this.pin) {
      this.pin = L.marker([lat, lon], { icon: pinIcon('home', '物'), draggable: true }).addTo(this.map);
      this.pin.on('dragend', () => this.onChange?.('pin', this.pin.getLatLng(), true));
    } else this.pin.setLatLng([lat, lon]);
    this.onChange?.('pin', { lat, lng: lon }, user);
  }
  setEntrance(lat, lon, user = false) {
    if (!this.entrance) {
      this.entrance = L.marker([lat, lon], { icon: pinIcon('door', '入'), draggable: true }).addTo(this.map);
      this.entrance.on('dragend', () => this.onChange?.('entrance', this.entrance.getLatLng(), true));
    } else this.entrance.setLatLng([lat, lon]);
    this.onChange?.('entrance', { lat, lng: lon }, user);
  }
  clearEntrance() {
    if (this.entrance) { this.map.removeLayer(this.entrance); this.entrance = null; }
  }
  focus(lat, lon, zoom = 18) { this.map.setView([lat, lon], zoom, { animate: false }); }
  destroy() { clearTimeout(this.t); this.map.stop(); this.map.off(); this.map.remove(); }
}
