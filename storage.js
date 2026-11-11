/**
 * 한강아니면 한강뷰 (Hanriver) - Data Storage & Persistence Module
 * IndexedDB + LocalStorage 이중 영구 보관 및 JSON/CSV 내보내기/가져오기 지원
 */

const DB_NAME = 'hanriver_db';
const DB_VERSION = 1;

let dbPromise = null;

export function initDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported, falling back to LocalStorage');
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

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

    request.onsuccess = (e) => resolve(e.target.result);
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

export async function getAllTransactions() {
  const db = await initDB();
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction('transactions', 'readonly');
      const store = tx.objectStore('transactions');
      const req = store.getAll();
      req.onsuccess = () => {
        const data = req.result || [];
        // LocalStorage 동기화 백업
        localStorage.setItem(LS_TX_KEY, JSON.stringify(data));
        resolve(data);
      };
      req.onerror = () => {
        resolve(getFallbackTransactions());
      };
    });
  }
  return getFallbackTransactions();
}

function getFallbackTransactions() {
  try {
    const raw = localStorage.getItem(LS_TX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveTransaction(item) {
  const db = await initDB();
  if (!item.id) item.id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  if (!item.createdAt) item.createdAt = new Date().toISOString();

  // LocalStorage 즉시 갱신
  const list = getFallbackTransactions().filter(t => t.id !== item.id);
  list.push(item);
  localStorage.setItem(LS_TX_KEY, JSON.stringify(list));

  if (db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('transactions', 'readwrite');
      const store = tx.objectStore('transactions');
      store.put(item);
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => resolve(item);
    });
  }
  return item;
}

export async function deleteTransaction(id) {
  const list = getFallbackTransactions().filter(t => t.id !== id);
  localStorage.setItem(LS_TX_KEY, JSON.stringify(list));

  const db = await initDB();
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction('transactions', 'readwrite');
      const store = tx.objectStore('transactions');
      store.delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(true);
    });
  }
  return true;
}

export async function getAllJournalNotes() {
  const db = await initDB();
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction('journal', 'readonly');
      const store = tx.objectStore('journal');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(getFallbackJournal());
    });
  }
  return getFallbackJournal();
}

function getFallbackJournal() {
  try {
    const raw = localStorage.getItem(LS_JOURNAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveJournalNote(note) {
  if (!note.id) note.id = 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  if (!note.createdAt) note.createdAt = new Date().toISOString();

  const list = getFallbackJournal().filter(n => n.id !== note.id);
  list.push(note);
  localStorage.setItem(LS_JOURNAL_KEY, JSON.stringify(list));

  const db = await initDB();
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction('journal', 'readwrite');
      const store = tx.objectStore('journal');
      store.put(note);
      tx.oncomplete = () => resolve(note);
      tx.onerror = () => resolve(note);
    });
  }
  return note;
}

export async function deleteJournalNote(id) {
  const list = getFallbackJournal().filter(n => n.id !== id);
  localStorage.setItem(LS_JOURNAL_KEY, JSON.stringify(list));

  const db = await initDB();
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction('journal', 'readwrite');
      const store = tx.objectStore('journal');
      store.delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(true);
    });
  }
  return true;
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
export async function loadSampleData() {
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

  // 저장 처리
  for (const t of sampleTransactions) {
    await saveTransaction(t);
  }
  for (const n of sampleNotes) {
    await saveJournalNote(n);
  }
}

/**
 * 전체 데이터 JSON 백업 내보내기
 */
export async function exportAllData() {
  const transactions = await getAllTransactions();
  const journal = await getAllJournalNotes();
  const settings = getSettings();

  const data = {
    brand: '한강아니면 한강뷰 (Hanriver)',
    version: '1.0',
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
export async function importAllData(jsonData) {
  if (!jsonData || !Array.isArray(jsonData.transactions)) {
    throw new Error('유효한 한강아니면 한강뷰 백업 파일 형식이 아닙니다.');
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
    saveSettings(jsonData.settings);
  }
}
