#!/usr/bin/env node
// Archero 2 クラン合併追跡ツール — 横断検索スクリプト
//
// 使い方:
//   node search.mjs player <名前またはplayer_id>   プレイヤー名/IDで全レコードを横断検索
//   node search.mjs clan <clan_id>                 クランIDのスナップショット履歴を表示
//   node search.mjs check                          全レコードを対象に合併検知チェック
//
// 注意:
// - clans.json の文字列は一切正規化せずそのまま保持する
// - 名前の「比較」時のみ NFC 正規化して照合する(表示は原文のまま)
// - player_id があれば ID 優先で照合、なければ名前照合にフォールバック

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'clans.json');

/** clans.json を読み込む(配列を返す) */
export function loadRecords() {
  return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
}

/** 名前比較用キー: NFC 正規化のみ(元データは変更しない) */
export function nameKey(name) {
  return String(name).normalize('NFC');
}

/**
 * 2人の幹部が同一人物かどうか判定する。
 * player_id が両方にあれば ID で照合(改名対策)。
 * どちらかが null なら NFC 正規化した名前で照合にフォールバック。
 */
export function sameOfficer(a, b) {
  if (a.player_id != null && b.player_id != null) {
    return a.player_id === b.player_id;
  }
  return nameKey(a.name) === nameKey(b.name);
}

/** プレイヤー名(NFC照合)または player_id で全レコードを横断検索 */
export function searchPlayer(records, query) {
  const asId = /^\d+$/.test(query) ? Number(query) : null;
  const key = nameKey(query);
  const hits = [];
  for (const rec of records) {
    for (const officer of rec.officers ?? []) {
      const idMatch = asId != null && officer.player_id === asId;
      const nameMatch = nameKey(officer.name) === key;
      if (idMatch || nameMatch) {
        hits.push({ recorded_at: rec.recorded_at, clan: rec.clan, officer });
      }
    }
  }
  return hits;
}

/** clan_id のスナップショット履歴(記録日順) */
export function clanHistory(records, clanId) {
  return records
    .filter((rec) => rec.clan?.clan_id === Number(clanId))
    .sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
}

/**
 * 合併検知チェック:
 * 各幹部について、別 clan_id のレコードにも幹部として現れていたら警告を返す。
 * 戻り値: [{ officer, appearances: [{recorded_at, clan}] }]
 */
export function detectMergers(records) {
  const warnings = [];
  const seen = new Set(); // 同じ組み合わせの重複報告を防ぐ

  for (let i = 0; i < records.length; i++) {
    for (const officer of records[i].officers ?? []) {
      const appearances = [];
      for (let j = 0; j < records.length; j++) {
        if (records[j].clan?.clan_id === records[i].clan?.clan_id) continue;
        for (const other of records[j].officers ?? []) {
          if (sameOfficer(officer, other)) {
            appearances.push({ recorded_at: records[j].recorded_at, clan: records[j].clan, officer: other });
          }
        }
      }
      if (appearances.length > 0) {
        const dedupKey = officer.player_id != null ? `id:${officer.player_id}` : `name:${nameKey(officer.name)}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          warnings.push({
            officer,
            home: { recorded_at: records[i].recorded_at, clan: records[i].clan },
            appearances,
          });
        }
      }
    }
  }
  return warnings;
}

// ---- CLI ----

function fmtOfficer(o) {
  const id = o.player_id != null ? `#${o.player_id}` : 'ID不明';
  return `${o.role} ${o.name} (${id}, power: ${o.power})`;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const records = loadRecords();

  switch (cmd) {
    case 'player': {
      const query = args.join(' ');
      if (!query) return usage();
      const hits = searchPlayer(records, query);
      if (hits.length === 0) {
        console.log(`該当なし: ${query}`);
        return;
      }
      for (const h of hits) {
        console.log(`[${h.recorded_at}] ${h.clan.name} (clan_id: ${h.clan.clan_id}) — ${fmtOfficer(h.officer)}`);
      }
      break;
    }
    case 'clan': {
      if (!args[0]) return usage();
      const history = clanHistory(records, args[0]);
      if (history.length === 0) {
        console.log(`該当なし: clan_id ${args[0]}`);
        return;
      }
      for (const rec of history) {
        console.log(`[${rec.recorded_at}] ${rec.clan.name} Lv${rec.clan.level} ${rec.clan.members} (総戦力: ${rec.clan.total_power})`);
        for (const o of rec.officers ?? []) console.log(`  ${fmtOfficer(o)}`);
      }
      break;
    }
    case 'check': {
      const warnings = detectMergers(records);
      if (warnings.length === 0) {
        console.log('合併の兆候は見つかりませんでした。');
        return;
      }
      for (const w of warnings) {
        console.log(`⚠ ${fmtOfficer(w.officer)} は複数クランに幹部として出現:`);
        console.log(`  [${w.home.recorded_at}] ${w.home.clan.name} (clan_id: ${w.home.clan.clan_id})`);
        for (const a of w.appearances) {
          console.log(`  [${a.recorded_at}] ${a.clan.name} (clan_id: ${a.clan.clan_id}) — ${fmtOfficer(a.officer)}`);
        }
      }
      break;
    }
    default:
      usage();
  }
}

function usage() {
  console.log(`使い方:
  node search.mjs player <名前またはplayer_id>   プレイヤーを横断検索
  node search.mjs clan <clan_id>                 クランの履歴表示
  node search.mjs check                          合併検知チェック`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
