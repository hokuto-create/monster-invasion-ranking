// data.json から最新の更新日を読み取り、プッシュ通知用の payload.json を生成する。
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const entries = data.entries || [];
const timestamps = data.timestamps || {};

const dates = [...new Set(entries.map(e => e.date))].sort();
const latest = dates[dates.length - 1];

const days = ['日', '月', '火', '水', '木', '金', '土'];
const bosses = ['鎌の魔道士', '墓守り', 'ファイアドラゴン', 'バルログ', 'メドゥーサ', 'ストーンマン', '一つ目の魔道士'];

let body = 'ランキングが更新されました';
if (latest) {
  const [y, m, d] = latest.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const tsNote = timestamps[latest] ? `（${timestamps[latest]}）` : '';
  body = `${m}/${d}(${days[dow]}) ${bosses[dow]} のランキングを更新しました${tsNote}`;
}

const payload = {
  title: '魔物襲来 ランキング',
  body,
  url: './index.html',
};

fs.writeFileSync('payload.json', JSON.stringify(payload));
console.log('payload:', JSON.stringify(payload));
