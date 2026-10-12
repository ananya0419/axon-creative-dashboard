// Pulls live Axon campaign + creative spend data, computes which creatives are
// "picking up" / "performing", and writes the static JSON the dashboard reads.
//
// Run with: AXON_MANAGEMENT_KEY=... AXON_REPORT_KEY=... node scripts/build.mjs
//
// Designed to run on a daily GitHub Actions schedule (see .github/workflows/update-data.yml),
// but safe to run locally too - it never writes credentials anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const POSTERS_DIR = path.join(DOCS, 'posters');

const MGMT_KEY = process.env.AXON_MANAGEMENT_KEY;
const REPORT_KEY = process.env.AXON_REPORT_KEY;
const ACCOUNT_ID = process.env.AXON_ACCOUNT_ID || '300381780';

if (!MGMT_KEY || !REPORT_KEY) {
  console.error('Missing AXON_MANAGEMENT_KEY and/or AXON_REPORT_KEY env vars.');
  process.exit(1);
}

const WINDOW_DAYS = 30;
const RECENT_UPLOAD_DAYS = 28;
const QUALIFY_MIN_PCT = 5;
const QUALIFY_MIN_RUN = 3;

const GAME_NAMES = {
  'com.felicitygames.lineout': 'Line Out',
  'com.felicitygames.arrowmaze': 'Arrow Maze',
  'com.felicitygames.wordjam': 'Cloud Word Jam',
  'com.felicitygames.sorterygame': 'Sortery',
  'com.felicitygames.woofdoku': 'WoofDoku',
  'com.FelicityGames.DuelMasterPistolFight': 'Duel Master - Pistol Fight',
  'com.felicitygames.duelmasterpistolfight': 'Duel Master - Pistol Fight',
};

// ---------- date helpers ----------
function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n, from) { return new Date(from.getTime() - n * 86400000); }

const NOW = new Date();
const YESTERDAY = daysAgo(1, NOW);
const WINDOW_END = isoDate(YESTERDAY);
const WINDOW_START = isoDate(daysAgo(WINDOW_DAYS - 1, YESTERDAY));
const RECENT_CUTOFF = daysAgo(RECENT_UPLOAD_DAYS, YESTERDAY);

console.log(`Window: ${WINDOW_START} .. ${WINDOW_END} (${WINDOW_DAYS}d, ending yesterday)`);

// ---------- http helpers ----------
async function fetchJSON(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  return data;
}

async function getLiveCampaigns() {
  const url = `https://api.ads.axon.ai/manage/v1/campaign/list?account_id=${ACCOUNT_ID}&page=1&size=100`;
  const all = await fetchJSON(url, { Authorization: MGMT_KEY });
  return all.filter(c => c.status === 'LIVE').map(c => ({
    name: c.name.trim(), id: c.id, platform: c.platform, status: c.status,
  }));
}

async function getAssetAnalytics(campaignName) {
  const cols = 'day,campaign,campaign_package_name,asset_id,asset_name,asset_url,creative_set_id,cost';
  const url = `https://r.applovin.com/assetAnalyticsReport?api_key=${REPORT_KEY}&start=${WINDOW_START}&end=${WINDOW_END}&columns=${cols}&format=json&filter_campaign=${encodeURIComponent(campaignName)}&limit=100000`;
  const d = await fetchJSON(url);
  return d.results || [];
}

async function getAdvertiserTotals() {
  const url = `https://r.applovin.com/report?api_key=${REPORT_KEY}&start=${WINDOW_START}&end=${WINDOW_END}&columns=day,campaign,cost&format=json&report_type=advertiser&limit=100000`;
  const d = await fetchJSON(url);
  const totals = {};
  for (const r of d.results) {
    const name = r.campaign.trim();
    totals[name] = totals[name] || {};
    totals[name][r.day] = (totals[name][r.day] || 0) + parseFloat(r.cost);
  }
  return totals;
}

async function getAssetMeta(ids) {
  const out = [];
  const idArr = [...ids];
  for (let i = 0; i < idArr.length; i += 100) {
    const chunk = idArr.slice(i, i + 100);
    const url = `https://api.ads.axon.ai/manage/v1/asset/list?account_id=${ACCOUNT_ID}&ids=${chunk.join(',')}`;
    const d = await fetchJSON(url, { Authorization: MGMT_KEY });
    out.push(...d);
  }
  return out;
}

// ---------- domain logic ----------
function assetType(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.html')) return 'PLAYABLE';
  if (n.endsWith('.mp4') || n.endsWith('.mov')) return 'VIDEO';
  if (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'ENDCARD';
  return 'OTHER';
}

function dayDiff(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

function linregSlope(series) {
  const n = series.length;
  if (n < 2) return 0;
  const xs = series.map((_, i) => i), ys = series.map(d => d.pct);
  const xBar = xs.reduce((a, b) => a + b, 0) / n, yBar = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - xBar) * (ys[i] - yBar); den += (xs[i] - xBar) ** 2; }
  return den === 0 ? 0 : num / den;
}

function classifyTrend(series) {
  const n = series.length, k = Math.min(3, n);
  const firstAvg = series.slice(0, k).reduce((s, d) => s + d.pct, 0) / k;
  const lastAvg = series.slice(n - k).reduce((s, d) => s + d.pct, 0) / k;
  const slope = linregSlope(series);
  const peak = Math.max(...series.map(d => d.pct));
  if (slope > 0.12 && lastAvg > firstAvg * 1.15) return { label: 'Picking up', slope, firstAvg, lastAvg, peak };
  if (lastAvg > QUALIFY_MIN_PCT) return { label: 'Performing', slope, firstAvg, lastAvg, peak };
  return { label: 'Fading', slope, firstAvg, lastAvg, peak };
}

// Element tags inferred from creative naming conventions - see memory of prior
// manual tagging passes. Extend RULES as new naming patterns show up.
const TAG_RULES = [
  [/tutorial/i, { hook: 'Tutorial walkthrough', caption: 'Instructional captions' }],
  [/instructional/i, { hook: 'Instructional walkthrough', caption: 'Step-by-step on-screen instructions' }],
  [/firstclick|5click|3mistakes|20click|click/i, { hook: 'Tap-count interaction hook (playable)', caption: 'Click-counter UI text' }],
  [/relaxing.?phone|relaxing.?game/i, { hook: 'Relaxing / ASMR gameplay', caption: 'Minimal / ambient captions' }],
  [/wrong.?move/i, { hook: 'Fail-state / "wrong move" hook', caption: 'Red warning text overlay' }],
  [/frustrating/i, { hook: 'Rage-bait / frustration hook' }],
  [/cleanplate/i, { hook: 'Clean, distraction-free gameplay edit', caption: 'Little to no text' }],
  [/guidingcomments/i, { hook: 'Guided walkthrough with narrator comments', caption: 'Comment-bubble captions' }],
  [/progressive/i, { hook: 'Progressive difficulty ramp' }],
  [/guilty|findthekiller|locked|open/i, { hook: 'Mystery / "find the killer" narrative hook', comp: 'Detective/whodunit narrative framing' }],
  [/iq_?landmarks/i, { hook: 'IQ-test / landmark trivia challenge', caption: 'Trivia question captions' }],
  [/captioncycle/i, { hook: 'Rotating on-screen captions hook', caption: 'Cycling caption text (primary device)' }],
  [/pixarcross/i, { hook: '3D-render style crossover', comp: 'Pixar/3D-animation inspired render' }],
  [/onepercent/i, { hook: '"Only 1% can solve" ego-bait', caption: 'Percentage-challenge caption' }],
  [/canyousolve|ninetyninefail|proveit/i, { hook: 'Challenge / ego-bait ("can you solve it")', caption: 'Challenge-question caption' }],
  [/hard.?to.?stop/i, { hook: 'Compulsion / "hard to stop" hook' }],
  [/simple.?to.?complicated/i, { hook: 'Simple-to-complex mechanic demo' }],
  [/complete.?the.?word|one.?category/i, { hook: 'Core word-mechanic demo' }],
  [/category.?quiz/i, { hook: 'Trivia/quiz hook', caption: 'Quiz question captions' }],
  [/connect.?four|four.?connection/i, { hook: 'Named-mechanic demo (Connect Four style)' }],
  [/rainbow.?rush/i, { hook: 'Speed color-match hook', shape: 'Rainbow color tiles' }],
  [/baselevel|^.*gameplay(?!-)/i, { hook: 'Plain core-gameplay demo' }],
  [/lockandkey/i, { hook: 'Lock-and-key mechanic demo', shape: 'Lock & key iconography' }],
  [/slotunlock/i, { hook: 'Slot-machine reward-unlock mechanic', shape: 'Slot-machine reels' }],
  [/bigmazepattern|neonslidepuzzle|diamondtangle/i, { shape: 'Neon maze / mandala pattern', comp: 'Neon geometric art style' }],
  [/cherry ?blossom|kimono|curved.?leaf|parrot-green|face|greenmaze|curved-arrows-fox/i, { comp: 'Themed visual skin (floral/kimono/animal/nature)', shape: 'Decorative nature or character motif' }],
  [/korean_temple|dark.?mixedgameplay.?jp|_jp\b|_kr\b|-jp\b/i, { comp: 'Localized geo-specific art skin (JP/KR)' }],
  [/statesonmap/i, { hook: 'Geography mapping mechanic demo', shape: 'Map/state outline shapes' }],
  [/cloudsweep|rowsort|cleartheboard/i, { hook: 'Named sorting/sweep mechanic demo' }],
  [/superhard/i, { hook: 'Escalating "super hard" difficulty challenge' }],
  [/big.?maze/i, { shape: 'Maze pattern motif', comp: 'Neon geometric art style' }],
  [/free.?the.*arrow/i, { hook: 'Complex gameplay showcase ("free the arrow")' }],
  [/gameplay-dark|gameplay-pink/i, { hook: 'Plain core-gameplay demo', comp: 'Color-themed skin (dark/pink)' }],
  [/frozen ?clouds|cloud-expression/i, { hook: 'Cloud-themed matching mechanic demo', shape: 'Cloud iconography' }],
  [/endcardstatic_/i, { comp: 'Localized static endcard (per-geo swap)' }],
  [/complex-mandala|curved-arrows-star|bigmazepattern_jp/i, { comp: 'Abstract shape/mandala art', shape: 'Mandala / star / arrow motif' }],
  [/kimono_japanese_dark/i, { comp: 'Aspirational anime/ukiyo-e character illustration (no gameplay shown)' }],
  [/gameplay-v\d|^st_endcards/i, { comp: 'Screenshot-style gameplay endcard' }],
  [/image_05_endcard/i, { comp: 'Generic gameplay screenshot endcard' }],
  [/complicated-gameplay|free-the-arrow/i, { hook: 'Complex gameplay showcase ("free the arrow")' }],
  [/parrot/i, { comp: 'Themed visual skin (parrot/nature)', shape: 'Animal character motif' }],
  [/compreplica/i, { comp: 'Direct competitor-ad replica (comp)' }],
  [/multilevels?phonk/i, { hook: 'Multi-level progression showcase', comp: 'Phonk-music-driven edit' }],
  [/coregameplay.?ai.?minimal/i, { hook: 'Minimal core-gameplay demo (AI-generated variant)' }],
  [/garden.?dog.?asmr|garden-dog/i, { hook: 'ASMR gameplay with dog character', comp: 'Garden/nature themed skin' }],
  [/garden.?satisfying|garden_apl/i, { hook: 'Satisfying gameplay showcase', comp: 'Garden/nature themed skin' }],
  [/cat.?levels/i, { hook: 'Level-progression showcase', comp: 'Cat character skin' }],
  [/plant.?vibrant.?timer|sunflower.?timer|cat.?timer/i, { hook: 'Countdown-timer interaction hook (playable)', comp: 'Plant/garden themed skin' }],
  [/mushroom.?v2|windmill.?v2|trophy.?v2/i, { comp: 'Themed visual skin (nature/reward icon)' }],
];

function tagAsset(name) {
  const out = { hook: null, caption: null, comp: null, shape: null, ctaStyle: null };
  for (const [re, vals] of TAG_RULES) {
    if (re.test(name)) for (const k of Object.keys(vals)) if (!out[k]) out[k] = vals[k];
  }
  const durMatch = name.match(/(\d+)s\.mp4/i);
  if (durMatch) out.duration = durMatch[1] + 's';
  if (/\.html$/i.test(name)) out.ctaStyle = 'Interactive playable CTA (in-ad tap-through)';
  if (/\.png$|\.jpg$/i.test(name)) out.ctaStyle = 'Static "PLAY NOW" button endcard';
  return out;
}

function daysLive(uploadTimeStr, ref) {
  if (!uploadTimeStr) return null;
  const u = new Date(uploadTimeStr.endsWith('Z') ? uploadTimeStr : uploadTimeStr + 'Z');
  return Math.max(0, Math.round((ref - u) / 86400000));
}

function extractPoster(url, assetId) {
  const out = path.join(POSTERS_DIR, `${assetId}.jpg`);
  if (fs.existsSync(out)) return true; // already have one from a prior run
  const attempts = [1.5, 0.2];
  for (const ss of attempts) {
    try {
      execFileSync('ffmpeg', ['-y', '-ss', String(ss), '-i', url, '-frames:v', '1', '-update', '1', '-vf', 'scale=420:-2', '-q:v', '5', out], { stdio: 'ignore', timeout: 30000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return true;
    } catch { /* try next offset */ }
  }
  return false;
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.mkdirSync(POSTERS_DIR, { recursive: true });

  console.log('Fetching live campaigns...');
  const liveCampaigns = await getLiveCampaigns();
  console.log(`Found ${liveCampaigns.length} LIVE campaigns:`, liveCampaigns.map(c => c.name).join(', '));

  console.log('Fetching authoritative advertiser totals...');
  const advertiserTotals = await getAdvertiserTotals();

  const games = {}; // gameName -> platform -> campaignName -> {...}
  const allRowsByCampaign = {}; // for the recent-uploads pass later
  const everyAssetSeen = new Map(); // assetId -> {name, url}

  for (const camp of liveCampaigns) {
    console.log(`Pulling asset report for ${camp.name}...`);
    let rows;
    try {
      rows = await getAssetAnalytics(camp.name);
    } catch (e) {
      console.error(`  failed: ${e.message}`);
      rows = [];
    }
    allRowsByCampaign[camp.name] = rows;

    if (rows.length === 0) {
      const gameName = '(no spend data in this window)';
      games[gameName] = games[gameName] || {};
      games[gameName][camp.platform] = games[gameName][camp.platform] || {};
      games[gameName][camp.platform][camp.name] = { id: camp.id, status: camp.status, noData: true, assets: [] };
      continue;
    }

    const pkg = rows[0].campaign_package_name;
    const gameName = GAME_NAMES[pkg] || pkg;
    const campaignDayTotal = advertiserTotals[camp.name] || {};
    const allDays = Object.keys(campaignDayTotal).sort();

    const assetDaySpend = {}, assetInfo = {};
    for (const r of rows) {
      const cost = parseFloat(r.cost);
      if (!assetDaySpend[r.asset_id]) assetDaySpend[r.asset_id] = {};
      assetDaySpend[r.asset_id][r.day] = (assetDaySpend[r.asset_id][r.day] || 0) + cost;
      if (!assetInfo[r.asset_id]) assetInfo[r.asset_id] = { name: r.asset_name, url: r.asset_url, type: assetType(r.asset_name) };
      if (!everyAssetSeen.has(r.asset_id)) everyAssetSeen.set(r.asset_id, { name: r.asset_name, url: r.asset_url });
    }

    const qualifying = [];
    for (const assetId in assetDaySpend) {
      const info = assetInfo[assetId];
      const series = allDays.map(day => {
        const total = campaignDayTotal[day] || 0;
        const spend = assetDaySpend[assetId][day] || 0;
        const rawPct = total > 0 ? (spend / total) * 100 : 0;
        return { day, spend: +spend.toFixed(4), pct: +Math.min(rawPct, 100).toFixed(3) };
      });

      let maxRun = 0, curRun = 0, curStart = null, bestRun = null;
      for (let i = 0; i < series.length; i++) {
        const above = series[i].pct > QUALIFY_MIN_PCT;
        const consecutive = i === 0 || dayDiff(series[i - 1].day, series[i].day) === 1;
        if (above && consecutive && curRun > 0) curRun++;
        else if (above) { curRun = 1; curStart = series[i].day; }
        else { curRun = 0; curStart = null; }
        if (curRun > maxRun) { maxRun = curRun; bestRun = { start: curStart, end: series[i].day, length: curRun }; }
      }

      if (maxRun < QUALIFY_MIN_RUN) continue;
      const trend = classifyTrend(series);
      if (trend.label === 'Fading') continue;

      const totalSpend = series.reduce((s, d) => s + d.spend, 0);
      qualifying.push({
        asset_id: assetId, name: info.name, url: info.url, type: info.type,
        maxConsecutiveRun: maxRun, bestRunWindow: bestRun,
        totalSpend: +totalSpend.toFixed(2), series, trend, tags: tagAsset(info.name),
      });
    }

    qualifying.sort((a, b) => b.trend.lastAvg - a.trend.lastAvg);

    const byHook = {};
    for (const a of qualifying) {
      const key = a.tags.hook || a.tags.comp || a.tags.shape || 'Untagged';
      if (!byHook[key]) byHook[key] = { tag: key, totalSpend: 0, count: 0, types: new Set() };
      byHook[key].totalSpend += a.totalSpend; byHook[key].count += 1; byHook[key].types.add(a.type);
    }
    const elementRanking = Object.values(byHook)
      .map(r => ({ tag: r.tag, totalSpend: +r.totalSpend.toFixed(2), count: r.count, types: [...r.types] }))
      .sort((a, b) => b.totalSpend - a.totalSpend);

    const totalCampaignSpend = Object.values(campaignDayTotal).reduce((s, v) => s + v, 0);
    const activeDays = allDays.filter(d => campaignDayTotal[d] > 0);

    games[gameName] = games[gameName] || {};
    games[gameName][camp.platform] = games[gameName][camp.platform] || {};
    games[gameName][camp.platform][camp.name] = {
      id: camp.id, status: camp.status, days: allDays, campaignDayTotal,
      totalCampaignSpend: +totalCampaignSpend.toFixed(2),
      firstActiveDay: activeDays[0] || null, lastActiveDay: activeDays[activeDays.length - 1] || null,
      assets: qualifying, elementRanking,
    };
  }

  // ---- upload_time for every asset we've touched (qualifying + everything else seen) ----
  console.log(`Fetching upload metadata for ${everyAssetSeen.size} assets...`);
  const metaList = await getAssetMeta(everyAssetSeen.keys());
  const metaById = {};
  for (const m of metaList) metaById[m.id] = m;

  // attach uploadTime/daysLive onto qualifying assets
  for (const g in games) for (const p in games[g]) for (const c in games[g][p]) {
    const camp = games[g][p][c];
    for (const a of (camp.assets || [])) {
      const m = metaById[a.asset_id];
      a.uploadTime = m?.upload_time || null;
      a.daysLive = daysLive(m?.upload_time, YESTERDAY);
    }
  }

  // ---- generate poster thumbnails for every qualifying video ----
  console.log('Generating poster thumbnails for qualifying videos...');
  for (const g in games) for (const p in games[g]) for (const c in games[g][p]) {
    for (const a of (games[g][p][c].assets || [])) {
      if (a.type === 'VIDEO') {
        const ok = extractPoster(a.url, a.asset_id);
        a.posterUrl = ok ? `./posters/${a.asset_id}.jpg` : null;
      }
    }
  }

  fs.writeFileSync(path.join(DOCS, 'final_data_active.json'), JSON.stringify({
    range: { start: WINDOW_START, end: WINDOW_END }, games,
  }));

  // ---- recently-added creatives (last 28 days by upload_time) ----
  console.log('Building recently-added creatives list...');
  const recentIds = new Set(
    metaList.filter(m => m.upload_time && new Date(m.upload_time + 'Z') >= RECENT_CUTOFF).map(m => m.id)
  );
  console.log(`${recentIds.size} assets uploaded in the last ${RECENT_UPLOAD_DAYS} days.`);

  const qualifyingIds = new Set();
  for (const g in games) for (const p in games[g]) for (const c in games[g][p])
    for (const a of (games[g][p][c].assets || [])) qualifyingIds.add(a.asset_id);

  // per-(asset,campaign) spend series for recent-upload assets, computed the same way as above
  const recentPerAsset = {};
  for (const camp of liveCampaigns) {
    const rows = allRowsByCampaign[camp.name] || [];
    if (rows.length === 0) continue;
    const pkg = rows[0].campaign_package_name;
    const gameName = GAME_NAMES[pkg] || pkg;
    const campaignDayTotal = advertiserTotals[camp.name] || {};
    const allDays = Object.keys(campaignDayTotal).sort();

    const assetDaySpend = {};
    for (const r of rows) {
      if (!recentIds.has(r.asset_id)) continue;
      const cost = parseFloat(r.cost);
      if (!assetDaySpend[r.asset_id]) assetDaySpend[r.asset_id] = {};
      assetDaySpend[r.asset_id][r.day] = (assetDaySpend[r.asset_id][r.day] || 0) + cost;
    }
    for (const assetId in assetDaySpend) {
      const series = allDays.map(day => {
        const total = campaignDayTotal[day] || 0;
        const spend = assetDaySpend[assetId][day] || 0;
        const rawPct = total > 0 ? (spend / total) * 100 : 0;
        return { day, spend: +spend.toFixed(4), pct: +Math.min(rawPct, 100).toFixed(3) };
      });
      const totalSpend = series.reduce((s, d) => s + d.spend, 0);
      const k = Math.min(3, series.length);
      const lastAvg = series.slice(series.length - k).reduce((s, d) => s + d.pct, 0) / k;

      recentPerAsset[assetId] = recentPerAsset[assetId] || {};
      let trendLabel = 'Below 5% threshold';
      const qa = (games[gameName]?.[camp.platform]?.[camp.name]?.assets || []).find(a => a.asset_id === assetId);
      if (qa) trendLabel = qa.trend.label;
      else if (lastAvg > QUALIFY_MIN_PCT) trendLabel = 'Above 5%, <3d';
      recentPerAsset[assetId][camp.name] = {
        game: gameName, platform: camp.platform,
        totalSpend: +totalSpend.toFixed(2), lastAvg: +lastAvg.toFixed(2), trendLabel,
      };
    }
  }

  const recentVideosNeedingPoster = [];
  const recentList = [...recentIds].map(id => {
    const m = metaById[id];
    const seen = everyAssetSeen.get(id) || { name: m?.name, url: m?.url };
    const type = seen.name ? assetType(seen.name) : (m?.resource_type === 'HTML' ? 'PLAYABLE' : m?.resource_type === 'VIDEO' ? 'VIDEO' : m?.resource_type === 'IMAGE' ? 'ENDCARD' : 'OTHER');
    const isQualifying = qualifyingIds.has(id);
    const perCampaign = recentPerAsset[id] || {};
    const campaigns = Object.keys(perCampaign).map(cn => ({ name: cn, ...perCampaign[cn] })).sort((a, b) => b.totalSpend - a.totalSpend);
    const totalSpend = campaigns.reduce((s, c) => s + c.totalSpend, 0);
    const bestLastAvg = Math.max(0, ...campaigns.map(c => c.lastAvg));

    let posterUrl = null;
    if (type === 'VIDEO' && !isQualifying) {
      recentVideosNeedingPoster.push({ id, url: seen.url });
      posterUrl = `./posters/${id}.jpg`;
    } else if (type === 'VIDEO' && isQualifying) {
      posterUrl = `./posters/${id}.jpg`; // already generated above
    }

    return {
      asset_id: id, name: seen.name, url: seen.url, type, tags: tagAsset(seen.name || ''),
      uploadDate: m?.upload_time ? m.upload_time.slice(0, 10) : null,
      daysLive: daysLive(m?.upload_time, YESTERDAY),
      isQualifying, totalSpend: +totalSpend.toFixed(2), bestLastAvg: +bestLastAvg.toFixed(2),
      campaigns, posterUrl,
    };
  }).sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));

  console.log(`Generating poster thumbnails for ${recentVideosNeedingPoster.length} new (non-qualifying) videos...`);
  for (const v of recentVideosNeedingPoster) {
    const ok = extractPoster(v.url, v.id);
    if (!ok) {
      const rec = recentList.find(r => r.asset_id === v.id);
      if (rec) rec.posterUrl = null;
    }
  }

  fs.writeFileSync(path.join(DOCS, 'recent_creatives_final.json'), JSON.stringify(recentList));

  fs.writeFileSync(path.join(DOCS, 'meta.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: { start: WINDOW_START, end: WINDOW_END, days: WINDOW_DAYS },
    recentUploadWindowDays: RECENT_UPLOAD_DAYS,
    liveCampaignCount: liveCampaigns.length,
    liveCampaigns: liveCampaigns.map(c => c.name),
  }));

  console.log('Done.');
  let qualTotal = 0;
  for (const g in games) for (const p in games[g]) for (const c in games[g][p]) qualTotal += (games[g][p][c].assets || []).length;
  console.log(`Qualifying campaign-asset instances: ${qualTotal}`);
  console.log(`Recently-added creatives: ${recentList.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
