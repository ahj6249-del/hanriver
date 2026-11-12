import { transactionTime, TX_TYPES } from './domain.js';
import { getManualPrices, restoreManualPrices } from './api.js';

/**
 * 한강아니면 한강뷰 (Hanriver) - Data Storage & Persistence Module
 * IndexedDB + LocalStorage 이중 영구 보관 및 JSON/CSV 내보내기/가져오기 지원
 */

const DB_NAME = 'hanriver_db';
const DB_VERSION = 1;

let dbPromise = null;

export function initDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported, falling back to LocalStorage');
      resolve(null);
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      console.warn('IndexedDB unavailable, falling back to LocalStorage', error);
      resolve(null);
      return;
    }

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('transactions')) {
        const txStore = db.createObjectStore('transactions', { keyPath: 'id' });
        txStore.createIndex('ticker', 'ticker', { unique: false });
        txStore.createIndex('date', 'date', { unique: false });
        txStore.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('journal')) {
        const jStore = db.createObjectStore('journal', { keyPath: 'id' });
        jStore.createIndex('ticker', 'ticker', { unique: false });
        jStore.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = (e) => {
      const db = e.target.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = (e) => {
      console.error('IndexedDB open error:', e);
      resolve(null);
    };
  });

  return dbPromise;
}

// LocalStorage 키
const LS_TX_KEY = 'hanriver_transactions_v1';
const LS_JOURNAL_KEY = 'hanriver_journal_v1';
const LS_SETTINGS_KEY = 'hanriver_settings_v1';
const LS_BENCHMARK_KEY = 'hanriver_benchmark_prices_v1';

// One origin-wide lock also covers tabs that temporarily cannot use IndexedDB.
// Without Web Locks, fallback read/modify/write remains synchronous after init.
function withStorageLock(operation) {
  return globalThis.navigator?.locks?.request ?
    navigator.locks.request('hanriver.storage', operation) : operation();
}

// Keep deletion markers in both stores so recovery cannot resurrect deleted rows.
// Older releases stored plain arrays; their records are merged without migration.
function readBackup(key) {
  let rows = [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(saved)) rows = saved.filter(row => row && typeof row.id === 'string');
  } catch { /* Individual fallback records can still recover a damaged snapshot. */ }
  const journal = [];
  for (const itemKey of Object.keys(localStorage)) {
    if (!itemKey.startsWith(key + '.record.')) continue;
    try {
      const row = JSON.parse(localStorage.getItem(itemKey));
      if (row && typeof row.id === 'string') journal.push(row);
    } catch { /* Preserve the other readable records. */ }
  }
  return [...mergeRecords(rows, journal).values()];
}

const modifiedTime = row => Date.parse(row?.updatedAt || row?.createdAt) || 0;

function mergeRecords(primary, backup) {
  const merged = new Map(primary.map(row => [row.id, row]));
  for (const row of backup) {
    const existing = merged.get(row.id);
    if (!existing || modifiedTime(row) > modifiedTime(existing) ||
        (modifiedTime(row) === modifiedTime(existing) && row._deleted && !existing._deleted)) {
      merged.set(row.id, row);
    }
  }
  return merged;
}

function applyChange(records, change) {
  if (!change) return;
  const { id, record } = change;
  const updatedAt = new Date(Math.max(Date.now(), modifiedTime(records.get(id)) + 1)).toISOString();
  records.set(id, record ? { ...record, updatedAt, _deleted: false } :
    { id, updatedAt, _deleted: true });
}

function mirror(key, records) {
  try {
    localStorage.setItem(key, JSON.stringify(records));
  } catch (error) {
    console.warn('Local backup could not be updated', error);
  }
}

async function accessRecords(storeName, key, change) {
  return withStorageLock(() => accessRecordsUnlocked(storeName, key, change));
}

async function accessRecordsUnlocked(storeName, key, change) {
  const db = await initDB();
  const backup = readBackup(key);
  if (!db) {
    const records = mergeRecords([], backup);
    applyChange(records, change);
    const rows = [...records.values()];
    // Store each change independently before updating the legacy snapshot. A
    // stale snapshot in another tab must never erase the only copy of a row.
    if (change) {
      localStorage.setItem(key + '.record.' + encodeURIComponent(change.id),
        JSON.stringify(records.get(change.id)));
      mirror(key, rows);
    }
    return rows;
  }
  try {
    return await new Promise((resolve, reject) => {
      // Serialize recovery and writes in one transaction, including across tabs.
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      let rows;
      request.onsuccess = () => {
        const primary = request.result || [];
        const records = mergeRecords(primary, readBackup(key));
        applyChange(records, change);
        rows = [...records.values()];
        const existing = new Map(primary.map(row => [row.id, row]));
        for (const row of rows) {
          if (row !== existing.get(row.id)) store.put(row);
        }
      };
      transaction.oncomplete = () => {
        mirror(key, rows);
        resolve(rows);
      };
      transaction.onabort = () => reject(transaction.error || new Error('저장 작업이 중단되었습니다.'));
    });
  } catch (error) {
    // Reads can still use the backup. Never acknowledge a failed primary write.
    if (change) throw error;
    return backup;
  }
}

const liveRecords = rows => rows.filter(row => !row._deleted);

export async function getAllTransactions() {
  return liveRecords(await accessRecords('transactions', LS_TX_KEY));
}

export async function saveTransaction(item) {
  item.id ||= 'tx_' + crypto.randomUUID();
  item.createdAt ||= new Date().toISOString();
  await accessRecords('transactions', LS_TX_KEY, { id: item.id, record: item });
  return item;
}

export async function deleteTransaction(id) {
  await accessRecords('transactions', LS_TX_KEY, { id });
}

export async function getAllJournalNotes() {
  return liveRecords(await accessRecords('journal', LS_JOURNAL_KEY));
}

export async function saveJournalNote(note) {
  note.id ||= 'note_' + crypto.randomUUID();
  note.createdAt ||= new Date().toISOString();
  await accessRecords('journal', LS_JOURNAL_KEY, { id: note.id, record: note });
  return note;
}

export async function deleteJournalNote(id) {
  await accessRecords('journal', LS_JOURNAL_KEY, { id });
}

export function getSettings() {
  const defaults = {
    targetProfitUSD: 20000,
    targetReturnPercent: 25,
    maxAllowedMDD: 15,
    fxRate: 1425,
    colorMode: 'global', // 'global' (green profit/red loss) or 'korean' (red profit/blue loss)
    apiKeyFinnhub: '',
    apiKeyTwelveData: '',
    activeAccount: '기본 투자계좌'
  };
  try {
    const saved = localStorage.getItem(LS_SETTINGS_KEY);
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * 실전 샘플 데이터셋 (미국 주식 실전 투자 예시 데이터)
 */
export function getSampleData() {
  const sampleTransactions = [
    { id: 'tx_init_dep', date: '2026-01-05 09:30', type: 'DEPOSIT', ticker: '', name: '초기 투자 원금', qty: 0, price: 50000, fee: 0, tax: 0, memo: '새해 미국 주식 시드머니 입금' },
    // NVDA 분할 매수
    { id: 'tx_nvda_1', date: '2026-01-10 22:30', type: 'BUY', ticker: 'NVDA', name: 'NVIDIA Corp', qty: 50, price: 125.0, fee: 1.5, tax: 0, memo: 'AI 데이터센터 수요 지속 확인' },
    { id: 'tx_nvda_2', date: '2026-02-15 22:45', type: 'BUY', ticker: 'NVDA', name: 'NVIDIA Corp', qty: 30, price: 135.0, fee: 1.5, tax: 0, memo: '실적 발표 전 추가 매수' },
    // NVDA 일부 익절
    { id: 'tx_nvda_3', date: '2026-04-10 23:15', type: 'SELL', ticker: 'NVDA', name: 'NVIDIA Corp', qty: 30, price: 175.0, fee: 2.0, tax: 0, memo: '목표가 1차 도달 부분 익절' },
    // AAPL 매수
    { id: 'tx_aapl_1', date: '2026-02-01 23:00', type: 'BUY', ticker: 'AAPL', name: 'Apple Inc', qty: 60, price: 210.0, fee: 2.0, tax: 0, memo: '아이폰 신제품 및 AI 기능 출시 기대' },
    // TSLA 매수 및 손절
    { id: 'tx_tsla_1', date: '2026-03-05 22:30', type: 'BUY', ticker: 'TSLA', name: 'Tesla Inc', qty: 40, price: 240.0, fee: 1.8, tax: 0, memo: '로보택시 기대감 진입' },
    { id: 'tx_tsla_2', date: '2026-03-20 23:40', type: 'SELL', ticker: 'TSLA', name: 'Tesla Inc', qty: 40, price: 215.0, fee: 1.8, tax: 0, memo: '지시선 이탈 원칙적 손절' },
    // TSLA 숏 포지션 진입 및 숏커버
    { id: 'tx_tsla_short', date: '2026-04-02 22:40', type: 'SHORT', ticker: 'TSLA', name: 'Tesla Inc', qty: 25, price: 210.0, fee: 1.5, tax: 0, memo: '단기 하락 추세 숏 헤지' },
    { id: 'tx_tsla_cover', date: '2026-04-18 23:10', type: 'COVER', ticker: 'TSLA', name: 'Tesla Inc', qty: 25, price: 185.0, fee: 1.5, tax: 0, memo: '지지선 도달 전량 숏커버 성공' },
    // SPY & QQQ 장기 적립식
    { id: 'tx_spy_1', date: '2026-01-20 23:00', type: 'BUY', ticker: 'SPY', name: 'SPDR S&P 500 ETF', qty: 20, price: 580.0, fee: 1.0, tax: 0, memo: '인덱스 코어 자산 적립' },
    { id: 'tx_qqq_1', date: '2026-02-20 23:00', type: 'BUY', ticker: 'QQQ', name: 'Invesco QQQ Trust', qty: 25, price: 490.0, fee: 1.0, tax: 0, memo: '나스닥 코어 자산 적립' },
    // 배당금 수령
    { id: 'tx_aapl_div', date: '2026-05-15 10:00', type: 'DIVIDEND', ticker: 'AAPL', name: 'Apple Inc', qty: 60, price: 0.25, fee: 0, tax: 2.25, amount: 15.0, memo: '애플 분기 배당금 입금' }
  ];

  const sampleNotes = [
    {
      id: 'note_1',
      date: '2026-03-20',
      ticker: 'TSLA',
      side: 'SELL',
      buyReason: '로보택시 모멘텀 기대 매수',
      sellReason: '주요 지지선($220) 붕괴 시 기계적 손절',
      idea: '기술적 지표 과열 상태에서 섣부른 추격 매수였음',
      confidence: 3,
      emotion: '초조함, 아쉬움',
      pros: '계획된 손절선(-10%)을 지켜 더 큰 하락을 피함',
      cons: '진입 시 분할 매수가 아닌 일괄 매수를 진행함',
      improvements: '급등 후 횡보 구간에서 성급하게 진입하지 말고 눌림목 확인 후 진입하기',
      tags: ['기술적 분석', '계획된 손절']
    },
    {
      id: 'note_2',
      date: '2026-04-10',
      ticker: 'NVDA',
      side: 'SELL',
      buyReason: '빅테크 CapEx 증가 및 GPU 품귀 지속',
      sellReason: '수익률 +40% 도달로 리스크 관리 차원 분할 익절',
      idea: '비중이 전체 포트폴리오의 35%를 넘어가 분산 필요',
      confidence: 5,
      emotion: '차분함, 만족',
      pros: '평단가를 낮춰둔 덕에 큰 변동성에도 흔들리지 않음',
      cons: '조금 더 길게 끌고 가도 좋았으나 분할 매도로 잔여 물량 유지',
      improvements: '트레일링 스탑을 활용해 남은 물량은 추세 끝까지 홀딩',
      tags: ['실적 발표', 'AI 테마', '장기 투자']
    }
  ];

  return { transactions: sampleTransactions, journal: sampleNotes };
}

// v1 stored these examples in the real ledger. Preserve any rows the user edited.
export function isLegacySample(row, examples) {
  const example = examples.find(item => item.id === row.id);
  return Boolean(example && !row.accountId &&
    Object.entries(example).every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value)));
}

/**
 * 전체 데이터 JSON 백업 내보내기
 */
const forwardPrefix = 'hanriver.forward-benchmarks.';
export const getForwardBenchmarks = account => JSON.parse(localStorage.getItem(forwardPrefix + account) || '[]');
export const saveForwardBenchmarks = (account, records) =>
  localStorage.setItem(forwardPrefix + account, JSON.stringify(records));

function validForwardRecord(record) {
  const finite = Number.isFinite;
  return typeof record?.id === 'string' && typeof record.name === 'string' &&
    Array.isArray(record.allocation) && record.allocation.length > 0 &&
    record.allocation.every(row => /^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(row?.ticker ?? '') &&
      finite(row.units) && row.units > 0 && finite(row.weight) && row.weight > 0) &&
    Array.isArray(record.history) && record.history.length > 0 &&
    record.history.every(point => point && finite(Date.parse(point.at)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(point.day) && finite(Date.parse(point.day)) && finite(point.actualNav) &&
      finite(point.comparisonNav) && finite(point.principal) && finite(point.comparisonReturn) &&
      (point.actualReturn === null || finite(point.actualReturn)));
}

export async function exportAllData() {
  const transactions = await getAllTransactions();
  const journal = await getAllJournalNotes();
  const { apiKeyFinnhub, apiKeyTwelveData, ...settings } = getSettings();

  const data = {
    brand: '한강아니면 한강뷰 (Hanriver)',
    version: '1.2',
    manualPrices: getManualPrices(),
    benchmarkPrices: await getBenchmarkPrices(),
    forwardBenchmarks: Object.fromEntries(Object.keys(localStorage)
      .filter(key => key.startsWith(forwardPrefix))
      .map(key => [key.slice(forwardPrefix.length), getForwardBenchmarks(key.slice(forwardPrefix.length))])),
    exportedAt: new Date().toISOString(),
    transactions,
    journal,
    settings
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hanriver_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * JSON 데이터 가져오기 (복원)
 */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (record, fields) => fields.every(key => record[key] == null || typeof record[key] === 'string');
const validDate = date => typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(date) &&
  Number.isFinite(transactionTime(date)) && new Date(date.slice(0, 10)).toISOString().slice(0, 10) === date.slice(0, 10);
const positiveNumber = value => (typeof value === 'number' || typeof value === 'string') &&
  String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const validTicker = ticker => typeof ticker === 'string' && /^[A-Z0-9][A-Z0-9.:-]{0,24}$/i.test(ticker.trim());

function validTransaction(row) {
  if (!isRecord(row) || !validDate(row.date) || !Object.values(TX_TYPES).includes(row.type) ||
      !optionalText(row, ['id', 'accountId', 'ticker', 'name', 'memo', 'createdAt']) ||
      !['price', 'qty', 'amount', 'ratio', 'fee', 'tax'].every(key => row[key] == null ||
        row[key] === '' || row[key] === 0 || row[key] === '0' || positiveNumber(row[key]))) return false;
  if ([TX_TYPES.DEPOSIT, TX_TYPES.WITHDRAW, TX_TYPES.FEE].includes(row.type)) {
    return positiveNumber(row.amount || row.price || (row.type === TX_TYPES.FEE && row.fee));
  }
  if (!validTicker(row.ticker)) return false;
  if (row.type === TX_TYPES.SPLIT) return positiveNumber(row.ratio);
  if (row.type === TX_TYPES.DIVIDEND && positiveNumber(row.amount)) return true;
  return positiveNumber(row.qty) && positiveNumber(row.price);
}

function validJournal(note) {
  return isRecord(note) && validDate(note.date) &&
    optionalText(note, ['id', 'accountId', 'transactionId', 'ticker', 'side', 'buyReason',
      'sellReason', 'idea', 'emotion', 'pros', 'cons', 'improvements', 'createdAt']) &&
    (note.tags == null || (Array.isArray(note.tags) && note.tags.every(tag => typeof tag === 'string')));
}

function validSettings(settings) {
  if (!isRecord(settings)) return false;
  const validStocks = stocks => Array.isArray(stocks) && stocks.every(stock =>
    isRecord(stock) && validTicker(stock.ticker) && optionalText(stock, ['name', 'exchange']));
  return (settings.watchlist == null || validStocks(settings.watchlist)) &&
    (settings.watchlists == null || (Array.isArray(settings.watchlists) &&
      settings.watchlists.every(list => isRecord(list) && typeof list.id === 'string' &&
        typeof list.name === 'string' && validStocks(list.stocks)))) &&
    ['fxRate', 'targetProfitUSD', 'targetReturnPercent', 'maxAllowedMDD'].every(key =>
      settings[key] == null || (typeof settings[key] === 'number' && Number.isFinite(settings[key])));
}

function validManualPrices(prices) {
  return isRecord(prices) && Object.entries(prices).every(([ticker, quote]) =>
    /^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(ticker) && isRecord(quote) &&
    Number.isFinite(quote.price) && quote.price > 0 &&
    (quote.previousClose == null || (Number.isFinite(quote.previousClose) && quote.previousClose > 0)) &&
    (quote.changePercent == null || Number.isFinite(quote.changePercent)) &&
    (quote.updatedAt == null || (typeof quote.updatedAt === 'string' && Number.isFinite(Date.parse(quote.updatedAt)))));
}

function validBenchmarkPrices(prices) {
  const positive = n => Number.isFinite(n) && n > 0;
  return isRecord(prices) && Object.entries(prices).every(([ticker, days]) =>
    /^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(ticker) && isRecord(days) &&
    Object.entries(days).every(([day, row]) => day.length === 10 && validDate(day) && isRecord(row) &&
      (positive(row.close) || positive(row.adjusted)) &&
      (row.close == null || positive(row.close)) && (row.adjusted == null || positive(row.adjusted))));
}

export async function clearAllData() {
  return withStorageLock(clearAllDataUnlocked);
}

async function clearAllDataUnlocked() {
  const db = await initDB();
  if (db) {
    const stores = ['transactions', 'journal', 'settings'];
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('삭제 작업이 중단되었습니다.'));
      for (const store of stores) transaction.objectStore(store).clear();
    });
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('hanriver_') || key.startsWith(forwardPrefix)) localStorage.removeItem(key);
  }
}

export async function importAllData(jsonData) {
  if (!jsonData || !Array.isArray(jsonData.transactions)) {
    throw new Error('유효한 한강아니면 한강뷰 백업 파일 형식이 아닙니다.');
  }

  const invalidTransaction = jsonData.transactions.findIndex(row => !validTransaction(row));
  if (invalidTransaction >= 0) {
    throw new Error(`백업의 ${invalidTransaction + 1}번째 거래 기록에 잘못된 날짜, 유형 또는 금액이 있습니다.`);
  }
  if (jsonData.journal != null && (!Array.isArray(jsonData.journal) || !jsonData.journal.every(validJournal))) {
    throw new Error('백업의 복기 노트 형식을 확인해주세요.');
  }
  if (jsonData.settings != null && !validSettings(jsonData.settings)) {
    throw new Error('백업의 설정 형식을 확인해주세요.');
  }
  if (jsonData.manualPrices != null && !validManualPrices(jsonData.manualPrices)) {
    throw new Error('백업의 수동 시세 형식을 확인해주세요.');
  }
  if (jsonData.benchmarkPrices != null && !validBenchmarkPrices(jsonData.benchmarkPrices)) {
    throw new Error('백업의 과거 가격 형식을 확인해주세요.');
  }
  if (jsonData.forwardBenchmarks != null && !isRecord(jsonData.forwardBenchmarks)) {
    throw new Error('백업의 벤치마크 기록 형식을 확인해주세요.');
  }
  const forward = Object.entries(jsonData.forwardBenchmarks ?? {});
  if (forward.some(([account, records]) => !/^[a-zA-Z0-9_-]+$/.test(account) ||
      !Array.isArray(records) || !records.every(validForwardRecord))) {
    throw new Error('백업의 벤치마크 기록 형식을 확인해주세요.');
  }
  for (const t of jsonData.transactions) {
    await saveTransaction(t);
  }
  if (Array.isArray(jsonData.journal)) {
    for (const n of jsonData.journal) {
      await saveJournalNote(n);
    }
  }
  if (jsonData.settings) {
    const { apiKeyFinnhub, apiKeyTwelveData, ...settings } = jsonData.settings;
    saveSettings({ ...getSettings(), ...settings });
  }
  if (jsonData.manualPrices != null) restoreManualPrices(jsonData.manualPrices);
  if (jsonData.benchmarkPrices != null) await saveBenchmarkPrices(jsonData.benchmarkPrices);
  for (const [account, records] of forward) {
    const merged = new Map(getForwardBenchmarks(account).map(record => [record.id, record]));
    for (const record of records) {
      const existing = merged.get(record.id);
      if (!existing || Date.parse(record.history.at(-1).at) > Date.parse(existing.history.at(-1).at)) {
        merged.set(record.id, record);
      }
    }
    saveForwardBenchmarks(account, [...merged.values()]);
  }
}


export async function getBenchmarkPrices() {
  return withStorageLock(() => accessBenchmarkPrices());
}

export async function saveBenchmarkPrices(prices) {
  return withStorageLock(() => accessBenchmarkPrices(prices));
}

async function accessBenchmarkPrices(prices) {
  const db = await initDB();
  let backup;
  try { backup = JSON.parse(localStorage.getItem(LS_BENCHMARK_KEY)); } catch { /* Use primary copy. */ }
  const change = previous => ({ key: 'benchmark-prices', value: prices,
    updatedAt: new Date(Math.max(Date.now(), modifiedTime(previous) + 1)).toISOString() });
  if (!db) {
    if (prices !== undefined) {
      backup = change(backup);
      localStorage.setItem(LS_BENCHMARK_KEY, JSON.stringify(backup));
    }
    return backup?.value ?? null;
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('settings', 'readwrite');
    const store = transaction.objectStore('settings');
    const request = store.get('benchmark-prices');
    let selected;
    request.onsuccess = () => {
      const primary = request.result;
      selected = backup && (!primary || modifiedTime(backup) > modifiedTime(primary)) ? backup : primary;
      if (prices !== undefined) selected = change(selected);
      if (selected && selected !== primary) store.put(selected);
    };
    transaction.oncomplete = () => {
      if (selected) mirror(LS_BENCHMARK_KEY, selected);
      resolve(selected?.value ?? null);
    };
    transaction.onabort = () => {
      if (prices === undefined) resolve(backup?.value ?? null);
      else reject(transaction.error || new Error('과거 가격을 저장하지 못했습니다.'));
    };
  });
}
