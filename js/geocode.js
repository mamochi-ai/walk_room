// 住所 → 位置候補。利用者がボタンを押したときに1回だけ問い合わせ、結果は端末に保存する。
// 候補が複数あっても自動では選ばない（選ぶのは利用者）。
import { GEOCODERS } from './config.js';
import { kvGet, kvPut } from './store.js';

let last = 0;
async function politeWait() {
  // Nominatim の上限（1秒に1回）を超えないように間隔を空ける
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

function precisionOfNominatim(r) {
  const rank = Number(r.place_rank) || 0;
  if (rank >= 30) return { level: 'building', label: '建物・番地レベル' };
  if (rank >= 26) return { level: 'block', label: '街区・道路レベル' };
  if (rank >= 18) return { level: 'area', label: '町丁目・地区レベル（建物の位置ではありません）' };
  return { level: 'city', label: '市区町村レベル（建物の位置ではありません）' };
}

export async function geocode(provider, query, { signal } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('住所が空です');
  const cfg = GEOCODERS[provider];
  if (!cfg) throw new Error('住所検索サービスが選ばれていません');
  const key = `geo:${provider}:${q}`;
  const cached = await kvGet(key);
  if (cached) return { ...cached, cached: true };
  let list = [];
  if (provider === 'nominatim') {
    await politeWait();
    const url = `${cfg.url}?format=jsonv2&limit=6&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`住所検索（Nominatim）が HTTP ${res.status} を返しました`);
    list = (await res.json()).map((r) => ({ lat: +r.lat, lon: +r.lon, label: r.display_name, precision: precisionOfNominatim(r), provider }));
  } else if (provider === 'gsi') {
    await politeWait();
    const res = await fetch(`${cfg.url}?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) throw new Error(`住所検索（国土地理院）が HTTP ${res.status} を返しました`);
    list = (await res.json()).slice(0, 8).map((r) => ({
      lat: r.geometry.coordinates[1], lon: r.geometry.coordinates[0], label: r.properties?.title || '', provider,
      precision: { level: 'unknown', label: '精度の情報なし（町丁目・街区の代表点のことが多い）' },
    }));
  }
  const out = { query: q, provider, at: new Date().toISOString(), list };
  await kvPut(key, out);
  return out;
}
