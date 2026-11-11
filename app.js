/**
 * 한강아니면 한강뷰 (Hanriver) - Main Application Controller
 * UI 라우팅, 상태 관리, 캔버스 차트 렌더링, 거래/복기 인터랙션
 */

import {
  TX_TYPES,
  TX_TYPE_LABELS,
  calculatePortfolio,
  calculatePerformanceMetrics,
  calculateHabits,
  formatUSD,
  formatKRW,
  formatPercent,
  formatQty
} from './domain.js';

import {
  getAllTransactions,
  saveTransaction,
  deleteTransaction,
  getAllJournalNotes,
  saveJournalNote,
  deleteJournalNote,
  getSettings,
  saveSettings,
  getSampleData,
  isLegacySample,
  exportAllData,
  importAllData
} from './storage.js';

import {
  STOCK_DATABASE,
  getStoredPrices,
  saveManualPrice,
  fetchStockQuote,
  searchStock,
  TICKER_PATTERN,
  testFinnhubKey,
  refreshAllQuotes
} from './api.js';

// Keep filtering the sample rows that older releases wrote into the real ledger.
const legacySamples = getSampleData();
const DEFAULT_ACCOUNT = 'default';

function quoteLabel(quote) {
  if (!quote) return '시세 없음 · 평단 기준 추정';
  const timestamp = Date.parse(quote.updatedAt);
  if (!Number.isFinite(timestamp)) return quote.source ? quote.source + ' · 기준 시각 미확인' : '저장 시세 · 기준 날짜 미확인';
  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short'
  }).format(timestamp);
  return `${quote.source} · ${time} KST`;
}

function escapeHTML(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

// 전역 앱 상태
const state = {
  currentView: 'dashboard',
  accountId: DEFAULT_ACCOUNT,
  watchOnly: false,
  currency: 'USD', // 'USD' or 'KRW'
  transactions: [],
  journalNotes: [],
  settings: getSettings(),
  prices: getStoredPrices(),
  portfolio: null,
  performance: null,
  habits: null,
  txFilter: {
    query: '',
    type: 'ALL'
  }
};

// 헬퍼: 통화 포맷터 (현재 선택된 통화 기준)
function fmtMoney(usdVal, withSign = false) {
  if (state.currency === 'KRW') {
    return formatKRW(usdVal, state.settings.fxRate);
  }
  return formatUSD(usdVal, withSign);
}

// 헬퍼: 토스트 메시지
let toastTimer;
function showToast(msg, duration = 3000, action) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.type = 'button';
    button.textContent = '복기 쓰기';
    button.onclick = () => {
      toast.style.display = 'none';
      action();
    };
    toast.append(button);
  }
  toast.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, duration);
}

/**
 * 데이터 재계산 및 전역 갱신
 */
let refreshVersion = 0;

async function refreshState() {
  const version = ++refreshVersion;
  const [transactions, journal] = await Promise.all([getAllTransactions(), getAllJournalNotes()]);
  if (version !== refreshVersion) return;

  const belongsToAccount = row => (row.accountId || DEFAULT_ACCOUNT) === state.accountId;
  state.transactions = transactions.filter(row =>
    belongsToAccount(row) && !isLegacySample(row, legacySamples.transactions));
  state.journalNotes = journal.filter(row =>
    belongsToAccount(row) && !isLegacySample(row, legacySamples.journal));
  state.settings = getSettings();
  state.prices = getStoredPrices();
  document.body.classList.toggle('theme-korean', state.settings.colorMode === 'korean');
  document.getElementById('account-select').value = state.accountId;

  state.portfolio = calculatePortfolio(state.transactions, state.prices, state.settings.fxRate);
  state.performance = calculatePerformanceMetrics(state.portfolio.closedTrades, state.portfolio);
  state.habits = calculateHabits(state.portfolio.closedTrades, state.transactions);
  renderCurrentView();
}

/**
 * 뷰 라우팅
 */
function switchView(viewName) {
  state.currentView = viewName;

  // 사이드바 & 모바일 네비게이션 활성화 토글
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewName);
  });
  const mobileMore = document.getElementById('mobile-more');
  mobileMore.open = false;
  for (const button of document.querySelectorAll('.mobile-nav [data-view]')) {
    const active = button.dataset.view === viewName && (viewName !== 'stocks' ||
      (button.dataset.stockMode === 'watch') === state.watchOnly);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  mobileMore.querySelector('summary').classList.toggle('active', Boolean(mobileMore.querySelector('[aria-current]')));

  // 섹션 표시 토글
  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.remove('active');
  });
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  // 상단 헤더 타이틀 갱신
  const titles = {
    dashboard: '대시보드',
    portfolio: '내 포트폴리오',
    transactions: '거래내역',
    performance: '투자 성과 분석',
    habits: '매매 습관 분석',
    journal: '투자 복기 노트',
    stocks: '종목 검색 & 시세',
    settings: '설정'
  };
  const titleEl = document.getElementById('current-page-title');
  if (titleEl) titleEl.textContent = titles[viewName] || '한강아니면 한강뷰';

  renderCurrentView();
}

function renderCurrentView() {
  switch (state.currentView) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'portfolio':
      renderPortfolio();
      break;
    case 'transactions':
      renderTransactions();
      break;
    case 'performance':
      renderPerformance();
      break;
    case 'habits':
      renderHabits();
      break;
    case 'journal':
      renderJournal();
      break;
    case 'stocks':
      renderStocks();
      break;
    case 'settings':
      renderSettings();
      break;
  }
}

/**
 * 1. 대시보드 렌더링
 */
function formatRatio(value) {
  return value == null ? '—' : value.toFixed(2);
}

function renderDashboard() {
  const p = state.portfolio;
  const perf = state.performance;
  if (!p) return;

  // 목표 프로그레스 바
  const targetUSD = state.settings.targetProfitUSD || 20000;
  const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date());
  const currentProfit = p.closedTrades.filter(trade => trade.date.startsWith(String(year)))
    .reduce((sum, trade) => sum + trade.pnl, 0);
  document.getElementById('goal-banner-title').textContent = `${year}년 실현 매매손익 목표`;
  const goalPercent = targetUSD > 0 ? Math.min(100, Math.max(0, (currentProfit / targetUSD) * 100)) : 0;
  const progressText = document.getElementById('goal-progress-text');
  const progressBar = document.getElementById('goal-progress-bar');
  const targetDesc = document.getElementById('goal-target-desc');
  if (progressText) progressText.textContent = `${(currentProfit / targetUSD * 100).toFixed(1)}% 달성 (${fmtMoney(currentProfit, true)})`;
  if (progressBar) progressBar.style.width = `${goalPercent}%`;
  if (targetDesc) targetDesc.textContent = `(목표: ${fmtMoney(targetUSD)})`;

  // 메트릭 카드들
  const setEl = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = cls;
  };

  setEl('m-total-nav', fmtMoney(p.totalNav));
  setEl('m-total-nav-krw', state.currency === 'USD' ? formatKRW(p.totalNav, state.settings.fxRate) : formatUSD(p.totalNav));
  const quoteSummary = p.holdings.length ? [...new Set(p.holdings.map(h => quoteLabel(h.quote)))].join(' / ') : '보유 종목 없음';
  setEl('m-quote-status', quoteSummary);
  setEl('m-stock-eval', fmtMoney(p.totalStockEval));
  setEl('m-stock-count', `${p.holdings.length}개 종목 보유 중`);
  document.getElementById('ledger-warning').hidden = p.invalidCloseIds.length === 0;
  setEl('m-cash', fmtMoney(p.cash));
  const cashRatio = p.totalNav > 0 ? (p.cash / p.totalNav) * 100 : 0;
  const hasShort = p.holdings.some(holding => holding.side === 'SHORT');
  const cashDetail = p.cash < 0 ? '기록상 현금 부족' : hasShort ? '공매도 대금 포함' :
    p.totalNav > 0 ? `순자산 대비 ${cashRatio.toFixed(1)}%` : '입출금·매매 기록 기준';
  setEl('m-cash-ratio', cashDetail);
  document.getElementById('cash-ledger-note').hidden = p.cash >= 0;

  // 당일 손익
  const quoteDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const hasDailyQuotes = p.holdings.length > 0 && p.holdings.every(({quote}) =>
    ['Finnhub', 'Twelve Data'].includes(quote?.source) && quote.previousClose > 0 &&
    Number.isFinite(Date.parse(quote.updatedAt)) &&
    quoteDay.format(new Date(quote.updatedAt)) === quoteDay.format(new Date()));
  setEl('m-daily-pnl', !hasDailyQuotes ? '—' : fmtMoney(p.totalDailyPnL, true), `metric-value tabular ${p.totalDailyPnL >= 0 ? 'profit' : 'loss'}`);
  setEl('m-daily-rate', !hasDailyQuotes ? '당일 시세 필요' : formatPercent(p.dailyReturnRate, true), `metric-sub tabular ${p.dailyReturnRate >= 0 ? 'profit' : 'loss'}`);

  // 미실현손익
  setEl('m-unrealized-pnl', fmtMoney(p.totalUnrealizedPnL, true), `metric-value tabular ${p.totalUnrealizedPnL >= 0 ? 'profit' : 'loss'}`);
  const investedCost = p.holdings.reduce((sum, h) => sum + h.qty * h.costBasis, 0);
  const unRate = investedCost > 0 ? (p.totalUnrealizedPnL / investedCost) * 100 : 0;
  setEl('m-unrealized-rate', formatPercent(unRate, true), `metric-sub tabular ${unRate >= 0 ? 'profit' : 'loss'}`);

  // 실현손익
  setEl('m-realized-pnl', fmtMoney(p.totalRealizedPnL, true), `metric-value tabular ${p.totalRealizedPnL >= 0 ? 'profit' : 'loss'}`);
  setEl('m-closed-count', `${perf.totalTrades}건 청산 완료`);

  // 승률 및 손익비
  setEl('m-win-rate', `${perf.winRate.toFixed(1)}%`);
  setEl('m-win-loss-count', `${perf.winCount}승 ${perf.lossCount}패`);
  setEl('m-profit-factor', formatRatio(perf.profitFactor));
  setEl('m-payoff-ratio', `손익비 ${formatRatio(perf.payoffRatio)}`);

  // 차트 그리기
  drawAllocationDonut();
  drawMonthlyBarChart();
}

/**
 * 2. 포트폴리오 뷰 렌더링
 */
function renderPortfolio() {
  const tbody = document.getElementById('holdings-tbody');
  if (!tbody) return;
  const p = state.portfolio;

  if (!p || p.holdings.length === 0) {
    document.getElementById('holdings-cards-mobile').innerHTML = '<p class="mobile-empty muted">이 계좌에 보유 종목이 없습니다.</p>';
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">현재 보유 중인 주식 포지션이 없습니다.<br><button class="btn-primary" id="btn-empty-port-add" style="margin-top: 12px;">첫 매수 기록하기</button></td></tr>`;
    const btn = document.getElementById('btn-empty-port-add');
    if (btn) btn.onclick = () => openTransactionModal('BUY');
    return;
  }

  tbody.innerHTML = p.holdings.map(h => {
    const isProfit = h.unrealizedPnL >= 0;
      return `
      <tr>
        <td>
          <div style="display: flex; flex-direction: column;">
            <strong style="font-size: 14px;">${escapeHTML(h.ticker)}</strong>
            <span class="muted" style="font-size: 11px;">${escapeHTML(h.name || h.ticker)}</span>
          </div>
        </td>
        <td>
          <span class="badge ${h.side === 'LONG' ? 'badge-buy' : 'badge-short'}">${h.side === 'LONG' ? '롱 (매수)' : '숏 (공매도)'}</span>
        </td>
        <td style="text-align: right;" class="tabular">${formatQty(h.qty)}</td>
        <td style="text-align: right;" class="tabular">${fmtMoney(h.costBasis)}</td>
        <td style="text-align: right;" class="tabular">
          <div>${fmtMoney(h.currentPrice)}</div>
          <span class="muted" style="font-size: 11px;">${escapeHTML(quoteLabel(h.quote))}</span>
        </td>
        <td style="text-align: right;" class="tabular"><strong>${fmtMoney(h.evalValue)}</strong></td>
        <td style="text-align: right;" class="tabular ${isProfit ? 'profit' : 'loss'}">
          <strong>${fmtMoney(h.unrealizedPnL, true)}</strong>
        </td>
        <td style="text-align: right;" class="tabular ${isProfit ? 'profit' : 'loss'}">
          <strong>${formatPercent(h.returnRate, true)}</strong>
        </td>
        <td style="text-align: right;" class="tabular">${h.weightPercent.toFixed(1)}%</td>
        <td style="text-align: center;">
          <div style="display: flex; gap: 4px; justify-content: center;">
            <button class="btn-secondary btn-port-action" data-ticker="${escapeHTML(h.ticker)}" data-action="${h.side === 'SHORT' ? 'SHORT' : 'BUY'}" style="padding: 4px 8px; font-size: 11px;">${h.side === 'SHORT' ? '공매도' : '매수'}</button>
            <button class="btn-secondary btn-port-action" data-ticker="${escapeHTML(h.ticker)}" data-action="${h.side === 'SHORT' ? 'COVER' : 'SELL'}" style="padding: 4px 8px; font-size: 11px;">${h.side === 'SHORT' ? '숏커버' : '매도'}</button>
            <button class="btn-secondary btn-price-edit" data-ticker="${escapeHTML(h.ticker)}" data-price="${h.currentPrice}" style="padding: 4px 8px; font-size: 11px;" title="현재가 수동 수정">시세</button>
            <button class="btn-secondary btn-tv-chart-open" data-ticker="${escapeHTML(h.ticker)}" style="padding: 4px 8px; font-size: 11px;" title="TradingView 실시간 차트">📈 차트</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // 모바일 전용 카드뷰 렌더링
  const mobileContainer = document.getElementById('holdings-cards-mobile');
  if (mobileContainer) {
    mobileContainer.innerHTML = p.holdings.map(h => {
      const isProfit = h.unrealizedPnL >= 0;
          return `
        <div class="port-card">
          <div class="port-card-header">
            <div class="port-card-title">
              <strong class="port-ticker">${escapeHTML(h.ticker)}</strong>
              <span class="port-name">${escapeHTML(h.name || h.ticker)}</span>
              <span class="badge ${h.side === 'LONG' ? 'badge-buy' : 'badge-short'}">${h.side === 'LONG' ? '롱' : '숏'}</span>
            </div>
            <div class="port-card-price">
              <span class="cur-price">${fmtMoney(h.currentPrice)}</span>
              <span class="price-change muted">${escapeHTML(quoteLabel(h.quote))}</span>
            </div>
          </div>
          <div class="port-card-grid">
            <div class="port-metric">
              <span class="label">보유수량</span>
              <span class="val">${formatQty(h.qty)}주</span>
            </div>
            <div class="port-metric">
              <span class="label">평균단가</span>
              <span class="val">${fmtMoney(h.costBasis)}</span>
            </div>
            <div class="port-metric">
              <span class="label">평가금액 (비중)</span>
              <span class="val"><strong>${fmtMoney(h.evalValue)}</strong> <small class="muted">(${h.weightPercent.toFixed(1)}%)</small></span>
            </div>
            <div class="port-metric">
              <span class="label">미실현손익 (수익률)</span>
              <span class="val ${isProfit ? 'profit' : 'loss'}"><strong>${fmtMoney(h.unrealizedPnL, true)}</strong> <small>(${formatPercent(h.returnRate, true)})</small></span>
            </div>
          </div>
          <div class="port-card-actions">
            <button class="btn-primary btn-port-action" data-ticker="${escapeHTML(h.ticker)}" data-action="${h.side === 'SHORT' ? 'SHORT' : 'BUY'}">＋ ${h.side === 'SHORT' ? '공매도' : '매수'}</button>
            <button class="btn-secondary btn-port-action" data-ticker="${escapeHTML(h.ticker)}" data-action="${h.side === 'SHORT' ? 'COVER' : 'SELL'}">－ ${h.side === 'SHORT' ? '숏커버' : '매도'}</button>
            <button class="btn-secondary btn-tv-chart-open" data-ticker="${escapeHTML(h.ticker)}">📈 차트</button>
            <button class="btn-secondary btn-price-edit" data-ticker="${escapeHTML(h.ticker)}" data-price="${h.currentPrice}">시세</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 데스크톱 + 모바일 버튼 이벤트 일괄 바인딩
  document.querySelectorAll('.btn-tv-chart-open').forEach(b => {
    b.onclick = () => openTradingViewModal(b.dataset.ticker);
  });
  document.querySelectorAll('.btn-port-action').forEach(b => {
    b.onclick = () => {
      openTransactionModal(b.dataset.action, b.dataset.ticker);
    };
  });
  document.querySelectorAll('.btn-price-edit').forEach(b => {
    b.onclick = () => {
      const ticker = b.dataset.ticker;
      const curPrice = b.dataset.price;
      const newPrice = prompt(`${ticker}의 현재 주가를 입력하세요 (USD $):`, curPrice);
      if (Number.isFinite(Number(newPrice)) && Number(newPrice) > 0) {
        saveManualPrice(ticker, parseFloat(newPrice));
        showToast(`${ticker} 현재가가 $${parseFloat(newPrice).toFixed(2)}로 업데이트되었습니다.`);
        refreshState();
      }
    };
  });
}

/**
 * 3. 거래내역 뷰 렌더링
 */
function settlement(t) {
  const amount = Number(t.amount || t.price) || 0;
  const gross = (Number(t.price) || 0) * (Number(t.qty) || 0);
  const charges = (Number(t.fee) || 0) + (Number(t.tax) || 0);
  switch (t.type) {
    case 'DEPOSIT': return amount;
    case 'WITHDRAW': return -amount;
    case 'FEE': return -(amount || Number(t.fee) || 0);
    case 'BUY':
    case 'COVER': return -gross - charges;
    case 'SELL':
    case 'SHORT': return gross - charges;
    case 'DIVIDEND': return (Number(t.amount) || gross) - charges;
    default: return 0;
  }
}

function tradeSummary(trade) {
  const closed = state.portfolio.closedTrades.find(item => item.id === trade.id);
  const details = [
    `${trade.ticker} ${TX_TYPE_LABELS[trade.type]}`,
    `${formatQty(closed?.qty ?? trade.qty)}주 · ${fmtMoney(trade.price)}`
  ];
  if (closed) details.push(`실현손익 ${fmtMoney(closed.pnl, true)}`);
  return details.join(' · ');
}

function linkedNoteMarkup(trade, notes, closedTrades) {
  const note = notes.get(trade.id);
  const closed = closedTrades.get(trade.id);
  const reason = note && (note.sellReason || note.buyReason || note.idea || note.improvements);
  return `${closed ? `<div class="trade-review-pnl ${closed.pnl >= 0 ? 'profit' : 'loss'}">실현손익 ${fmtMoney(closed.pnl, true)}</div>` : ''}
    ${reason ? `<div class="trade-review-snippet">${escapeHTML(reason)}</div>` : ''}
    ${trade.ticker ? `<button type="button" class="btn-secondary btn-tx-review" data-id="${escapeHTML(trade.id)}">${note ? '복기 보기·수정' : '복기 쓰기'}</button>` : ''}`;
}

function renderTransactions() {
  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  let list = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

  // 필터 적용
  if (state.txFilter.query) {
    const q = state.txFilter.query.toUpperCase();
    list = list.filter(t => (t.ticker && t.ticker.includes(q)) || (t.name && t.name.toUpperCase().includes(q)) || (t.memo && t.memo.toUpperCase().includes(q)));
  }
  if (state.txFilter.type && state.txFilter.type !== 'ALL') {
    list = list.filter(t => t.type === state.txFilter.type);
  }

  if (list.length === 0) {
    document.getElementById('tx-cards-mobile').innerHTML = '<p class="mobile-empty muted">표시할 거래내역이 없습니다.</p>';
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 30px; color: var(--text-muted);">표시할 거래내역이 없습니다.</td></tr>`;
    return;
  }

  const notesByTrade = new Map(state.journalNotes.filter(note => note.transactionId)
    .map(note => [note.transactionId, note]));
  const closedById = new Map(state.portfolio.closedTrades.map(trade => [trade.id, trade]));
  tbody.innerHTML = list.map(t => {
        const badgeClass = {
      BUY: 'badge-buy',
      SELL: 'badge-sell',
      SHORT: 'badge-short',
      COVER: 'badge-cover',
      DIVIDEND: 'badge-dividend',
      DEPOSIT: 'badge-deposit',
      WITHDRAW: 'badge-short'
    }[t.type] || 'badge-buy';

    const qty = parseFloat(t.qty) || 0;
    const price = parseFloat(t.price) || 0;
    const fee = parseFloat(t.fee || 0) + parseFloat(t.tax || 0);
    const totalSettle = settlement(t);

    return `
      <tr>
        <td class="tabular" style="font-size: 12px; color: var(--text-secondary);">${escapeHTML(t.date || '-')}</td>
        <td><span class="badge ${badgeClass}">${escapeHTML(TX_TYPE_LABELS[t.type] || t.type)}</span></td>
        <td><strong>${escapeHTML(t.ticker || '-')}</strong></td>
        <td style="color: var(--text-secondary);">${escapeHTML(t.name || '-')}</td>
        <td style="text-align: right;" class="tabular">${qty > 0 ? formatQty(qty) : '-'}</td>
        <td style="text-align: right;" class="tabular">${price > 0 ? fmtMoney(price) : '-'}</td>
        <td style="text-align: right;" class="tabular" style="color: var(--text-muted);">${fee > 0 ? fmtMoney(fee) : '$0'}</td>
        <td style="text-align: right;" class="tabular"><strong>${fmtMoney(totalSettle)}</strong></td>
        <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary);">${escapeHTML(t.memo || '-')}</td>
        <td style="text-align: center;">
          <div class="trade-review">${linkedNoteMarkup(t, notesByTrade, closedById)}</div>
          <div style="display: flex; gap: 4px; justify-content: center;">
            <button class="btn-secondary btn-tx-edit" data-id="${escapeHTML(t.id)}" style="padding: 3px 8px; font-size: 11px;">수정</button>
            <button class="btn-secondary btn-tx-del" data-id="${escapeHTML(t.id)}" style="padding: 3px 8px; font-size: 11px; color: #ef4444;">삭제</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // 모바일 전용 거래 카드뷰 렌더링
  const txMobileContainer = document.getElementById('tx-cards-mobile');
  if (txMobileContainer) {
    txMobileContainer.innerHTML = list.map(t => {
      const badgeClass = {
        BUY: 'badge-buy',
        SELL: 'badge-sell',
        SHORT: 'badge-short',
        COVER: 'badge-cover',
        DIVIDEND: 'badge-dividend',
        DEPOSIT: 'badge-deposit',
        WITHDRAW: 'badge-short'
      }[t.type] || 'badge-buy';

      const qty = parseFloat(t.qty) || 0;
      const price = parseFloat(t.price) || 0;
      const totalSettle = settlement(t);

      return `
        <div class="tx-card">
          <div class="tx-card-header">
            <div class="tx-card-left">
              <span class="badge ${badgeClass}">${escapeHTML(TX_TYPE_LABELS[t.type] || t.type)}</span>
              <strong class="tx-ticker">${escapeHTML(t.ticker || '-')}</strong>
              <span class="tx-name">${escapeHTML(t.name || '')}</span>
            </div>
            <span class="tx-date tabular" style="font-size: 11px; color: var(--text-muted);">${t.date ? t.date.slice(0, 16).replace('T', ' ') : '-'}</span>
          </div>
          <div class="tx-card-body">
            <div class="tx-card-details">
              <span>수량: <strong>${qty > 0 ? formatQty(qty) + '주' : '-'}</strong></span>
              <span>단가: <strong>${price > 0 ? fmtMoney(price) : '-'}</strong></span>
              <span>정산액: <strong class="tx-total" style="color: var(--text-main); font-size: 13.5px;">${fmtMoney(totalSettle)}</strong></span>
            </div>
            ${t.memo ? `<div class="tx-memo">💬 ${escapeHTML(t.memo)}</div>` : ''}
          </div>
          <div class="trade-review">${linkedNoteMarkup(t, notesByTrade, closedById)}</div>
          <div class="tx-card-actions">
            <button class="btn-secondary btn-tx-edit" data-id="${escapeHTML(t.id)}">수정</button>
            <button class="btn-secondary btn-tx-del" data-id="${escapeHTML(t.id)}" style="color: #ef4444;">삭제</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 데스크톱 + 모바일 공통 수정/삭제 이벤트 바인딩
  document.querySelectorAll('.btn-tx-del').forEach(b => {
    b.onclick = async () => {
      if (introducesInvalidClose(state.transactions.filter(t => t.id !== b.dataset.id))) {
        alert('이 거래를 삭제하면 이후 매도 또는 숏커버에 필요한 보유 수량이 부족해집니다.');
        return;
      }
      if (confirm('이 거래 기록을 삭제하시겠습니까? 관련된 모든 평단가와 손익이 재계산됩니다.')) {
        await deleteTransaction(b.dataset.id);
        showToast('거래 기록이 삭제되었습니다.');
        refreshState();
      }
    };
  });

  document.querySelectorAll('.btn-tx-review').forEach(button => {
    button.onclick = () => {
      const trade = state.transactions.find(item => item.id === button.dataset.id);
      if (trade) openJournalModal(trade);
    };
  });

  document.querySelectorAll('.btn-tx-edit').forEach(b => {
    b.onclick = () => {
      const tx = state.transactions.find(t => t.id === b.dataset.id);
      if (tx) openTransactionModal(tx.type, tx.ticker, tx);
    };
  });
}

/**
 * 4. 투자 성과 분석 뷰 렌더링
 */
function renderPerformance() {
  const perf = state.performance;
  const p = state.portfolio;
  if (!perf || !p) return;

  document.getElementById('perf-total-trades').textContent = state.transactions.length;
  document.getElementById('perf-closed-trades').textContent = `${perf.totalTrades}건 청산 완료`;
  document.getElementById('perf-win-rate').textContent = `${perf.winRate.toFixed(1)}%`;
  document.getElementById('perf-win-loss-ratio').textContent = `${perf.winCount}승 ${perf.lossCount}패`;
  document.getElementById('perf-avg-win').textContent = fmtMoney(perf.avgWin);
  document.getElementById('perf-avg-loss').textContent = fmtMoney(-perf.avgLoss);
  document.getElementById('perf-profit-factor').textContent = formatRatio(perf.profitFactor);
  document.getElementById('perf-consecutive').textContent = `${perf.maxConsecutiveWins}연승 / ${perf.maxConsecutiveLosses}연패`;
  document.getElementById('perf-mdd').textContent = '데이터 부족';

  // 롱 vs 숏 실현손익
  const longPnL = p.closedTrades.filter(t => t.side === 'LONG').reduce((sum, t) => sum + t.pnl, 0);
  const shortPnL = p.closedTrades.filter(t => t.side === 'SHORT').reduce((sum, t) => sum + t.pnl, 0);
  document.getElementById('perf-side-pnl').textContent = `${fmtMoney(longPnL, true)} / ${fmtMoney(shortPnL, true)}`;

  drawTickerPnLChart();
  drawPnLDistributionChart();
}

/**
 * 5. 매매 습관 분석 뷰 렌더링
 */
function renderHabits() {
  const h = state.habits;
  const tbody = document.getElementById('habits-holding-tbody');
  const diagContainer = document.getElementById('habits-diagnosis-content');
  if (!h || !tbody || !diagContainer) return;

  const buckets = Object.values(h.holdingPeriods);
  tbody.innerHTML = buckets.map(b => {
    const isProfit = b.totalPnL >= 0;
    const avg = b.count > 0 ? b.totalPnL / b.count : 0;
    return `
      <tr>
        <td><strong>${b.label}</strong></td>
        <td style="text-align: center;" class="tabular">${b.count}건</td>
        <td style="text-align: right;" class="tabular"><strong>${b.winRate.toFixed(1)}%</strong></td>
        <td style="text-align: right;" class="tabular ${isProfit ? 'profit' : 'loss'}"><strong>${fmtMoney(b.totalPnL, true)}</strong></td>
        <td style="text-align: right;" class="tabular ${avg >= 0 ? 'profit' : 'loss'}">${fmtMoney(avg, true)}</td>
      </tr>
    `;
  }).join('');

  // 거래 지표를 기반으로 복기 항목 생성
  const bestBucket = [...buckets].filter(b => b.count > 0).sort((a, b) => b.totalPnL - a.totalPnL)[0];
  const worstBucket = [...buckets].filter(b => b.count > 0).sort((a, b) => a.totalPnL - b.totalPnL)[0];
  const perf = state.performance;
  const p = state.portfolio;

  const topHolding = p?.holdings?.reduce((top, holding) => !top || holding.weightPercent > top.weightPercent ? holding : top, null);
  const cashRatio = p && p.totalNav > 0 ? (p.cash / p.totalNav) * 100 : 0;
  const isHealthyCash = cashRatio >= 10 && cashRatio <= 30;

  let diagnosisHtml = `
    <div style="background: rgba(16, 185, 129, 0.08); border-left: 4px solid var(--accent-emerald); padding: 14px 18px; border-radius: var(--radius-sm);">
      <h4 style="font-size: 14px; font-weight: 700; color: var(--accent-emerald); margin-bottom: 4px;">📊 1. 보유 기간별 매매 성과 & 최적 호흡</h4>
      <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
        ${bestBucket ? `<strong>${bestBucket.label}</strong> 구간에서 누적 실현손익 <strong>${fmtMoney(bestBucket.totalPnL, true)}</strong> (승률 ${bestBucket.winRate.toFixed(1)}%)로 가장 안정적인 성과를 내고 계십니다. 조급한 단타보다 이 호흡을 메인 전략으로 유지하시는 것을 추천합니다.` : '아직 충분한 청산 거래 기록이 없습니다.'}
      </p>
    </div>

    <div style="background: rgba(59, 130, 246, 0.08); border-left: 4px solid var(--accent-blue); padding: 14px 18px; border-radius: var(--radius-sm);">
      <h4 style="font-size: 14px; font-weight: 700; color: var(--accent-blue); margin-bottom: 4px;">⚖️ 2. 손익비 & 수학적 기대값 (Edge) 진단</h4>
      <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
        현재 매매 승률은 <strong>${perf.winRate.toFixed(1)}%</strong>, 손익비(Profit Factor)는 <strong>${formatRatio(perf.profitFactor)}</strong>입니다.
        ${perf.profitFactor >= 1.5 ? '이기는 거래의 이익이 지는 거래의 손실보다 1.5배 이상 커서 장기 복리 우상향이 가능한 매우 건강한 구조입니다.' : '손실 대비 수익 크기를 조금 더 키우거나, 손절 기준을 타이트하게 잡으면 승률이 다소 낮아도 계좌가 안정적으로 우상향합니다.'}
      </p>
    </div>

    <div style="background: rgba(14, 165, 233, 0.08); border-left: 4px solid var(--accent-cyan); padding: 14px 18px; border-radius: var(--radius-sm);">
      <h4 style="font-size: 14px; font-weight: 700; color: var(--accent-cyan); margin-bottom: 4px;">🛡️ 3. 자산 배분 건전성 & 현금 버퍼</h4>
      <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
        현재 계좌 내 현금 비중은 <strong>${cashRatio.toFixed(1)}%</strong>이며, 최대 비중 종목은 <strong>${topHolding ? `${escapeHTML(topHolding.ticker)} (${topHolding.weightPercent.toFixed(1)}%)` : '없음'}</strong>입니다.
        ${isHealthyCash ? '이상적인 10~30% 수준의 현금 완충 버퍼를 유지하고 있어 시장 급락 시 저가 매수 기회를 잡을 수 있습니다.' : (cashRatio < 10 ? '현금 비중이 10% 미만으로 낮아 급격한 변동성 발생 시 대응 여력이 제한될 수 있습니다.' : '현금 비중이 충분하여 안정적입니다.')}
      </p>
    </div>
  `;

  if (worstBucket && worstBucket.totalPnL < 0) {
    diagnosisHtml += `
      <div style="background: rgba(239, 68, 68, 0.08); border-left: 4px solid #ef4444; padding: 14px 18px; border-radius: var(--radius-sm);">
        <h4 style="font-size: 14px; font-weight: 700; color: #ef4444; margin-bottom: 4px;">⚠️ 4. 주의가 필요한 취약 구간 & 행동 처방</h4>
        <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
          <strong>${worstBucket.label}</strong> 구간에서 누적 손실 <strong>${fmtMoney(worstBucket.totalPnL, true)}</strong>이 발생했습니다. 손실 버티기나 뇌동매매가 없었는지 복기 노트를 점검하시고, 진입 전 손절선을 미리 정해두는 원칙을 권장합니다.
        </p>
      </div>
    `;
  } else {
    diagnosisHtml += `
      <div style="background: rgba(168, 85, 247, 0.08); border-left: 4px solid #a855f7; padding: 14px 18px; border-radius: var(--radius-sm);">
        <h4 style="font-size: 14px; font-weight: 700; color: #a855f7; margin-bottom: 4px;">🎯 4. 한강뷰를 향한 원칙 행동 수칙</h4>
        <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">
          뇌동 매매를 차단하고 사전 계획된 타점(TradingView 차트 지지선/돌파선)에서만 진입하세요. 복기 노트를 꾸준히 적으면 치명적인 실수를 방지할 수 있습니다.
        </p>
      </div>
    `;
  }

  diagContainer.innerHTML = diagnosisHtml;
}

/**
 * 6. 투자 복기 노트 뷰 렌더링
 */
function renderJournal() {
  const container = document.getElementById('journal-cards-container');
  if (!container) return;

  const notes = [...state.journalNotes].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (notes.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        작성된 투자 복기 노트가 없습니다.<br>
        매매 당시의 심리와 실수, 개선점을 기록하면 한강뷰에 한 걸음 더 가까워집니다.<br>
        <button class="btn-primary" id="btn-empty-journal-add" style="margin-top: 12px;">첫 복기 작성하기</button>
      </div>
    `;
    const btn = document.getElementById('btn-empty-journal-add');
    if (btn) btn.onclick = () => openJournalModal();
    return;
  }

  const transactionsById = new Map(state.transactions.map(trade => [trade.id, trade]));
  container.innerHTML = notes.map(n => {
    const trade = transactionsById.get(n.transactionId);
    const context = trade ? tradeSummary(trade) : (n.transactionId ? '연결된 거래가 장부에 없습니다.' : '');
    const stars = '⭐'.repeat(Math.max(0, Math.min(5, Number(n.confidence) || 3)));
    const tags = (n.tags || []).map(t => `<span class="badge" style="background: rgba(59,130,246,0.15); color: #60a5fa;">#${escapeHTML(t.trim())}</span>`).join(' ');

    return `
      <div class="card" style="padding: 18px 22px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <strong style="font-size: 16px; color: var(--accent-emerald);">${escapeHTML(n.ticker)}</strong>
              <span class="muted" style="font-size: 12px;">${escapeHTML(n.date)}</span>
              <span title="확신도">${stars}</span>
            </div>
            <div style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap;">
              ${tags}
            </div>
          </div>
          <div class="journal-actions"><button type="button" class="btn-secondary btn-edit-journal" data-id="${escapeHTML(n.id)}">수정</button>
          <button class="btn-secondary btn-del-journal" data-id="${escapeHTML(n.id)}" style="padding: 4px 10px; font-size: 11px; color: #ef4444;">삭제</button></div>
        </div>
        ${context ? `<p class="journal-trade-context">${escapeHTML(context)}</p>` : ''}

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; font-size: 13px;">
          ${n.buyReason ? `<div><span class="muted" style="font-size: 11.5px; display:block;">매수 이유</span><strong>${escapeHTML(n.buyReason)}</strong></div>` : ''}
          ${n.sellReason ? `<div><span class="muted" style="font-size: 11.5px; display:block;">매도 이유</span><strong>${escapeHTML(n.sellReason)}</strong></div>` : ''}
          ${n.emotion ? `<div><span class="muted" style="font-size: 11.5px; display:block;">당시 심리</span><span>${escapeHTML(n.emotion)}</span></div>` : ''}
        </div>

        ${n.idea ? `
          <div style="margin-top: 12px; padding: 10px 14px; background: var(--bg-input); border-radius: var(--radius-sm); font-size: 12.5px;">
            <span class="muted" style="font-size: 11px; display: block; margin-bottom: 2px;">투자 가설 및 아이디어</span>
            ${escapeHTML(n.idea)}
          </div>
        ` : ''}

        <div style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12.5px;">
          ${n.pros ? `
            <div style="background: rgba(16,185,129,0.06); padding: 8px 12px; border-radius: 6px; border-left: 3px solid var(--accent-emerald);">
              <span style="color: var(--accent-emerald); font-weight: 700; display: block; font-size: 11px;">잘한 점</span>
              ${escapeHTML(n.pros)}
            </div>
          ` : ''}
          ${n.improvements ? `
            <div style="background: rgba(239,68,68,0.06); padding: 8px 12px; border-radius: 6px; border-left: 3px solid #ef4444;">
              <span style="color: #ef4444; font-weight: 700; display: block; font-size: 11px;">개선할 점 (다음 원칙)</span>
              ${escapeHTML(n.improvements)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-edit-journal').forEach(button => {
    button.onclick = () => {
      const note = state.journalNotes.find(item => item.id === button.dataset.id);
      if (note) openJournalModal(transactionsById.get(note.transactionId), note);
    };
  });

  container.querySelectorAll('.btn-del-journal').forEach(b => {
    b.onclick = async () => {
      if (confirm('이 복기 노트를 삭제하시겠습니까?')) {
        await deleteJournalNote(b.dataset.id);
        showToast('복기 노트가 삭제되었습니다.');
        refreshState();
      }
    };
  });
}

/**
 * 7. 종목 검색 및 시세 뷰 렌더링
 */
let stockSearchVersion = 0;
let visibleStockTickers = [];
let refreshingQuotes = false;

function updateQuoteButtons() {
  const button = document.getElementById('btn-stock-refresh-all');
  button.disabled = refreshingQuotes || visibleStockTickers.length === 0;
  button.textContent = refreshingQuotes ? '조회 중…' : '전체 시세 조회';
  document.getElementById('btn-header-refresh').disabled = refreshingQuotes;
}

async function renderStocks() {
  const container = document.getElementById('stock-search-results');
  const status = document.getElementById('stock-search-status');
  const searchForm = document.getElementById('stock-search-form');
  const watchlist = Array.isArray(state.settings.watchlist) ? state.settings.watchlist.filter(stock =>
    stock && typeof stock.ticker === 'string' && TICKER_PATTERN.test(stock.ticker)) : [];
  const watched = new Set(watchlist.map(stock => stock.ticker));
  const watchOnly = state.watchOnly;
  const query = searchForm.querySelector('input').value.trim();
  searchForm.hidden = watchOnly;
  const listLayout = state.settings.watchlistLayout === 'list';
  container.classList.toggle('stock-results-list', watchOnly && listLayout);
  document.getElementById('watchlist-layout').hidden = !watchOnly;
  document.getElementById('watch-layout-card').setAttribute('aria-pressed', String(!listLayout));
  document.getElementById('watch-layout-list').setAttribute('aria-pressed', String(listLayout));
  visibleStockTickers = [];
  updateQuoteButtons();
  for (const button of document.querySelectorAll('.mobile-nav [data-view="stocks"]')) {
    const active = (button.dataset.stockMode === 'watch') === watchOnly;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.getElementById('current-page-title').textContent = watchOnly ? '관심종목' : '종목 검색 & 시세';
  document.getElementById('stock-mode-search').setAttribute('aria-pressed', String(!watchOnly));
  document.getElementById('stock-mode-watch').setAttribute('aria-pressed', String(watchOnly));
  const version = ++stockSearchVersion;
  if (query && !watchOnly) status.textContent = '종목 검색 중…';
  const { matches, directoryAvailable } = query && !watchOnly ? await searchStock(query) :
    { matches: [], directoryAvailable: true };
  if (version !== stockSearchVersion || query !== document.getElementById('stock-search-input').value.trim()) return;

  const manualTicker = query.toUpperCase();
  const canUseTicker = TICKER_PATTERN.test(manualTicker) && !matches.some(stock => stock.ticker === manualTicker ||
    stock.ticker.replaceAll('.', '-') === manualTicker);
  const results = watchOnly ? watchlist : canUseTicker ? [...matches, { ticker: manualTicker, name: '티커 직접 입력' }] : matches;
  status.textContent = watchOnly ? (watchlist.length ? '' : '검색 결과에서 별표를 눌러 관심종목을 추가할 수 있습니다.') : !directoryAvailable ? '상장 목록을 불러오지 못했습니다. 티커를 직접 입력할 수 있습니다.' :
    !query ? '티커나 회사명을 입력해 종목을 검색하세요.' :
    !matches.length ? '상장 목록에서 일치하는 종목을 찾지 못했습니다.' : '';

  visibleStockTickers = [...new Set(results.map(stock => stock.ticker))];
  updateQuoteButtons();
  container.innerHTML = results.map(stock => {
    const ticker = escapeHTML(stock.ticker);
    const quote = state.prices[stock.ticker];
    const isWatched = watched.has(stock.ticker);
    const market = [stock.exchange, stock.etf ? 'ETF' : ''].filter(Boolean).join(' · ');
    return `
      <article class="card stock-result">
        <div class="stock-result-title"><strong>${ticker}</strong><span class="muted">${escapeHTML(market)}</span>
          <button type="button" class="btn-secondary watch-toggle" data-ticker="${ticker}" aria-label="${ticker} 관심종목" aria-pressed="${isWatched}">${isWatched ? '★' : '☆'}</button>
        </div>
        <div class="stock-result-name">${escapeHTML(stock.name)}</div>
        <div class="stock-result-quote">
          <strong>${quote ? fmtMoney(quote.price) : '—'}</strong>
          <span class="muted">${escapeHTML(quote ? quoteLabel(quote) : '시세 없음')}</span>
        </div>
        <div class="stock-result-actions">
          <button type="button" class="btn-primary btn-quick-buy" data-ticker="${ticker}">매수 기록</button>
          <button type="button" class="btn-secondary btn-quick-tv" data-ticker="${ticker}">차트</button>
          <button type="button" class="btn-secondary btn-quick-quote" data-ticker="${ticker}">시세 조회</button>
        </div>
      </article>`;
  }).join('');

  renderWatchlistChart(watchlist);

  for (const button of container.querySelectorAll('.watch-toggle')) {
    button.onclick = async () => {
      const stock = results.find(item => item.ticker === button.dataset.ticker);
      const settings = getSettings();
      const saved = Array.isArray(settings.watchlist) ? settings.watchlist.filter(Boolean) : [];
      const exists = saved.some(item => item.ticker === stock.ticker);
      settings.watchlist = exists ? saved.filter(item => item.ticker !== stock.ticker) : [
        ...saved, { ticker: stock.ticker, name: stock.name === '티커 직접 입력' ? '' : stock.name,
          exchange: stock.exchange, etf: stock.etf }
      ];
      try {
        saveSettings(settings);
      } catch {
        showToast('관심종목을 저장하지 못했습니다.');
        return;
      }
      state.settings = settings;
      await renderStocks();
      const toggles = [...container.querySelectorAll('.watch-toggle')];
      (toggles.find(item => item.dataset.ticker === stock.ticker) ||
        toggles[0] || document.getElementById('stock-mode-watch')).focus();
    };
  }

  for (const button of container.querySelectorAll('.btn-quick-buy')) {
    button.onclick = () => {
      const stock = results.find(row => row.ticker === button.dataset.ticker);
      openTransactionModal('BUY', stock.ticker, null, stock.name === '티커 직접 입력' ? '' : stock.name);
    };
  }
  for (const button of container.querySelectorAll('.btn-quick-tv')) {
    button.onclick = () => openTradingViewModal(button.dataset.ticker);
  }
  for (const button of container.querySelectorAll('.btn-quick-quote')) {
    button.onclick = async () => {
      if (refreshingQuotes) return;
      button.disabled = true;
      button.textContent = '조회 중…';
      try {
        const ticker = button.dataset.ticker;
        const quote = await fetchStockQuote(ticker, state.settings);
        showToast(quote.price > 0 ? `${ticker}: ${fmtMoney(quote.price)} (${quoteLabel(quote)})` :
          `${ticker}: 시세를 가져오지 못했습니다. 시세 API 설정을 확인해주세요.`);
        await refreshState();
      } finally {
        button.disabled = false;
        button.textContent = '시세 조회';
      }
    };
  }
}

/**
 * 8. 설정 뷰 렌더링
 */
function renderSettings() {
  const s = state.settings;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };

  setVal('setting-color-mode', s.colorMode || 'global');
  setVal('setting-target-profit', s.targetProfitUSD || 20000);
  setVal('setting-target-rate', s.targetReturnPercent || 25);
  setVal('setting-max-mdd', s.maxAllowedMDD || 15);
  setVal('setting-fx-rate', s.fxRate || 1425);
  setVal('setting-twelve-key', s.apiKeyTwelveData || '');
  setVal('setting-finnhub-key', s.apiKeyFinnhub || '');
}

/**
 * Canvas 경량 차트 렌더링 (호버 툴팁 & 십자선 인터랙션 지원)
 */
function drawAllocationDonut() {
  const canvas = document.getElementById('chart-allocation');
  const legend = document.getElementById('allocation-legend');
  if (!canvas || !legend) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = 280;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const p = state.portfolio;
  const colors = ['#10b981', '#3b82f6', '#06b6d4', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];
  const items = p.holdings.filter(holding => holding.evalValue > 0).map((holding, index) => ({
    ticker: holding.ticker,
    val: holding.evalValue,
    color: colors[index % colors.length]
  }));
  if (p.cash > 0) items.push({ ticker: '현금', val: p.cash, color: '#475569' });

  const liabilities = p.holdings.filter(holding => holding.evalValue < 0).map(holding => ({
    label: `${holding.ticker} 공매도 상환액`, value: holding.evalValue
  }));
  if (p.cash < 0) liabilities.push({ label: '현금 부족액', value: p.cash });

  const assets = items.reduce((sum, item) => sum + item.val, 0);
  for (const item of items) item.pct = item.val / assets * 100;

  if (!assets) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('표시할 자산 비중이 없습니다.', w / 2, h / 2);
  }

  const cx = w / 2;
  const cy = h / 2;
  const rOut = Math.min(cx, cy) - 20;
  const rIn = rOut * 0.62;

  let startAngle = -Math.PI / 2;

  for (const item of items) {
    const sliceAngle = (item.pct / 100) * (Math.PI * 2);
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, startAngle, startAngle + sliceAngle);
    ctx.arc(cx, cy, rIn, startAngle + sliceAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.strokeStyle = '#07090e';
    ctx.lineWidth = 2;
    ctx.stroke();

    startAngle += sliceAngle;
  }

  // 중앙 텍스트
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  if (assets) ctx.fillText('자산 합계', cx, cy - 6);
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 13px monospace';
  if (assets) ctx.fillText(fmtMoney(assets), cx, cy + 14);

  // 범례 생성
  legend.innerHTML = items.map(item => `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="width: 10px; height: 10px; border-radius: 2px; background: ${item.color};"></span>
        <span style="font-weight: 600; color: var(--text-main);">${escapeHTML(item.ticker)}</span>
      </div>
      <span class="tabular muted">${item.pct.toFixed(1)}% (${fmtMoney(item.val)})</span>
    </div>
  `).join('') + liabilities.map(item => `
    <div class="allocation-offset"><span>${escapeHTML(item.label)}</span><strong>${fmtMoney(item.value)}</strong></div>
  `).join('');
}

function drawMonthlyBarChart() {
  const canvas = document.getElementById('chart-monthly-pnl');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = 200;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const monthly = state.performance?.monthlyPnL || {};
  const months = Object.keys(monthly).sort();

  if (months.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('월별 실현손익 데이터가 아직 없습니다.', w / 2, h / 2);
    return;
  }

  const pad = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  const vals = months.map(m => monthly[m]);
  const maxAbs = Math.max(...vals.map(v => Math.abs(v))) * 1.2 || 100;
  const zeroY = pad.top + chartH / 2;

  // 제로 라인
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(w - pad.right, zeroY);
  ctx.stroke();

  const barW = Math.min(40, (chartW / months.length) * 0.6);
  const gap = chartW / months.length;

  months.forEach((m, i) => {
    const val = monthly[m];
    const isProfit = val >= 0;
    const barH = (Math.abs(val) / maxAbs) * (chartH / 2);
    const x = pad.left + gap * i + (gap - barW) / 2;
    const y = isProfit ? zeroY - barH : zeroY;

    ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
    ctx.fillRect(x, y, barW, barH);

    // 라벨
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10.5px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(m.slice(5), x + barW / 2, h - 10);

    // 금액 표시
    ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
    ctx.fillText(fmtMoney(val, true), x + barW / 2, isProfit ? y - 4 : y + barH + 12);
  });
}

function drawTickerPnLChart() {
  const canvas = document.getElementById('chart-ticker-pnl');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = 280;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const tpnl = state.performance?.tickerPnL || {};
  const tickers = Object.keys(tpnl).sort((a, b) => tpnl[b] - tpnl[a]);

  if (tickers.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('종목별 청산 실현손익 데이터가 없습니다.', w / 2, h / 2);
    return;
  }

  const rowH = 36;
  const maxAbs = Math.max(...tickers.map(t => Math.abs(tpnl[t]))) * 1.2 || 100;
  const midX = w / 2;

  tickers.slice(0, 6).forEach((t, i) => {
    const val = tpnl[t];
    const isProfit = val >= 0;
    const y = 20 + i * rowH;
    const barLen = (Math.abs(val) / maxAbs) * (w / 2 - 80);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = isProfit ? 'right' : 'left';
    ctx.fillText(t, isProfit ? midX - 10 : midX + 10, y + 14);

    ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
    if (isProfit) {
      ctx.fillRect(midX, y + 4, barLen, 14);
      ctx.fillText(fmtMoney(val, true), midX + barLen + 8, y + 14);
    } else {
      ctx.fillRect(midX - barLen, y + 4, barLen, 14);
      ctx.fillText(fmtMoney(val, true), midX - barLen - 8, y + 14);
    }
  });
}

function drawPnLDistributionChart() {
  const canvas = document.getElementById('chart-pnl-distribution');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = 280;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const trades = state.portfolio?.closedTrades || [];
  if (trades.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('완료된 매매 거래가 없습니다.', w / 2, h / 2);
    return;
  }

  // 손익 분포 버킷 (대형 손실, 중형 손실, 소형 손실, 소형 익절, 중형 익절, 대형 익절)
  const buckets = [
    { label: '< -$500', count: 0, color: '#dc2626' },
    { label: '-$500~-$100', count: 0, color: '#ef4444' },
    { label: '-$100~$0', count: 0, color: '#f87171' },
    { label: '$0~$100', count: 0, color: '#34d399' },
    { label: '$100~$500', count: 0, color: '#10b981' },
    { label: '> +$500', count: 0, color: '#059669' }
  ];

  trades.forEach(t => {
    const p = t.pnl;
    if (p < -500) buckets[0].count++;
    else if (p < -100) buckets[1].count++;
    else if (p < 0) buckets[2].count++;
    else if (p < 100) buckets[3].count++;
    else if (p < 500) buckets[4].count++;
    else buckets[5].count++;
  });

  const maxC = Math.max(...buckets.map(b => b.count), 1);
  const pad = { top: 20, right: 10, bottom: 40, left: 30 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const gap = chartW / buckets.length;
  const barW = gap * 0.7;

  buckets.forEach((b, i) => {
    const x = pad.left + i * gap + (gap - barW) / 2;
    const bH = (b.count / maxC) * chartH;
    const y = pad.top + chartH - bH;

    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, barW, bH);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    if (b.count > 0) ctx.fillText(b.count, x + barW / 2, y - 6);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.fillText(b.label, x + barW / 2, h - 16);
  });
}

/**
 * 모달 열기 및 제어
 */
function openTransactionModal(type = 'BUY', ticker = '', editTx = null, stockName = '') {
  const modal = document.getElementById('modal-transaction');
  if (!modal) return;

  document.getElementById('modal-tx-title').textContent = editTx ? '거래 기록 수정' : (TX_TYPE_LABELS[type] || '거래') + ' 기록';
  document.getElementById('tx-id').value = editTx ? editTx.id : '';
  document.getElementById('tx-date').value = editTx ? editTx.date.replace(' ', 'T') : localDateTime();
  document.getElementById('tx-type').value = editTx ? editTx.type : type;
  document.getElementById('tx-ticker').value = editTx ? editTx.ticker : ticker;
  document.getElementById('tx-name').value = editTx ? (editTx.name || '') : stockName;
  document.getElementById('tx-qty').value = editTx ? editTx.qty : '';
  document.getElementById('tx-price').value = editTx ? (editTx.type === 'SPLIT' ? editTx.ratio : (editTx.type === 'FEE' ? (editTx.amount || editTx.price || editTx.fee) : editTx.price)) : '';
  document.getElementById('tx-fee').value = editTx ? (editTx.fee || 0) : 0;
  document.getElementById('tx-tax').value = editTx ? (editTx.tax || 0) : 0;
  document.getElementById('tx-memo').value = editTx ? (editTx.memo || '') : '';

  const matchedStock = STOCK_DATABASE.find(stock => stock.ticker === ticker);
  if (!editTx && !stockName && matchedStock) document.getElementById('tx-name').value = matchedStock.name;
  document.getElementById('tx-details').open = type !== TX_TYPES.BUY || Boolean(editTx);
  clearTradeQuote(false);
  resetSymbolResults();
  renderRecentTickers();
  updateTxModalFields();
  modal.showModal();
  if (window.matchMedia('(max-width: 860px) and (pointer: coarse)').matches) {
    document.getElementById('btn-close-tx-modal').focus();
  } else {
    document.getElementById(ticker && type === TX_TYPES.BUY ? 'tx-qty' : 'tx-ticker').focus();
  }
}

let symbolSearchVersion = 0;
let symbolSearchTimer;

function resetSymbolResults() {
  ++symbolSearchVersion;
  clearTimeout(symbolSearchTimer);
  const results = document.getElementById('tx-symbol-results');
  results.replaceChildren();
  results.hidden = true;
  document.getElementById('tx-symbol-status').textContent = '';
}

function selectTradeSymbol(ticker, name) {
  document.getElementById('tx-ticker').value = ticker;
  document.getElementById('tx-name').value = name;
  prefillTradeQuote();
  resetSymbolResults();
  document.getElementById('quick-ticker-chips').hidden = true;
  document.getElementById(document.getElementById('tx-type').value === 'SPLIT' ? 'tx-price' : 'tx-qty').focus();
}

function renderRecentTickers() {
  const chips = document.getElementById('quick-ticker-chips');
  chips.replaceChildren();
  const recent = [...state.transactions].filter(trade => trade.ticker).sort((a, b) => b.date.localeCompare(a.date));
  const seen = new Set();
  for (const stock of [...recent, ...STOCK_DATABASE]) {
    if (seen.has(stock.ticker)) continue;
    seen.add(stock.ticker);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary';
    button.textContent = stock.ticker;
    button.onclick = () => selectTradeSymbol(stock.ticker, stock.name || '');
    chips.append(button);
    if (seen.size === 5) break;
  }
  chips.hidden = Boolean(document.getElementById('tx-ticker').value);
}

function searchTradeSymbol() {
  resetSymbolResults();
  const field = document.getElementById('tx-ticker');
  const query = field.value.trim();
  prefillTradeQuote();
  const status = document.getElementById('tx-symbol-status');
  document.getElementById('tx-name').value = '';
  document.getElementById('quick-ticker-chips').hidden = Boolean(query);
  if (!query) return;
  const version = symbolSearchVersion;
  symbolSearchTimer = setTimeout(async () => {
    const { matches, directoryAvailable } = await searchStock(query, 6);
    if (version !== symbolSearchVersion || !field.closest('dialog').open) return;
    const results = document.getElementById('tx-symbol-results');
    for (const stock of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      const ticker = document.createElement('strong');
      ticker.textContent = stock.ticker;
      const name = document.createElement('span');
      name.textContent = stock.name;
      button.append(ticker, name);
      button.onclick = () => selectTradeSymbol(stock.ticker, stock.name);
      results.append(button);
    }
    results.hidden = !matches.length;
    if (!matches.length) status.textContent = directoryAvailable ?
      '일치하는 종목이 없습니다. 정확한 티커를 직접 입력할 수 있습니다.' : '상장 목록을 불러오지 못했습니다. 티커를 직접 입력할 수 있습니다.';
  }, 100);
}

function clearTradeQuote(clearValue = true) {
  const price = document.getElementById('tx-price');
  if (clearValue && price.dataset.quoteTicker) price.value = '';
  delete price.dataset.quoteTicker;
  document.getElementById('tx-quote-hint').textContent = '';
}

function prefillTradeQuote() {
  const price = document.getElementById('tx-price');
  const ticker = document.getElementById('tx-ticker').value.trim().toUpperCase();
  const type = document.getElementById('tx-type').value;
  const isNewTrade = !document.getElementById('tx-id').value;
  const canPrefill = isNewTrade && (type === TX_TYPES.BUY || type === TX_TYPES.SELL);
  if (price.dataset.quoteTicker && (!canPrefill || price.dataset.quoteTicker !== ticker)) {
    clearTradeQuote();
  }
  const quote = state.prices[ticker];
  const value = Number(quote?.price);
  if (canPrefill && !price.value && Number.isFinite(value) && value > 0) {
    price.value = String(value);
    price.dataset.quoteTicker = ticker;
    document.getElementById('tx-quote-hint').textContent =
      `시세 자동 입력 · ${quoteLabel(quote)} · 체결가 수정 가능`;
  }
  updateTradeTotal();
}

function updateTradeTotal() {
  const type = document.getElementById('tx-type').value;
  const qty = Number(document.getElementById('tx-qty').value);
  const price = Number(document.getElementById('tx-price').value);
  const fee = Number(document.getElementById('tx-fee').value);
  const tax = Number(document.getElementById('tx-tax').value);
  const total = document.getElementById('tx-total');
  total.textContent = type === 'SPLIT' ? '' : (price > 0 ?
    `예상 정산액 ${formatUSD(settlement({ type, qty, price, fee, tax }))}` : '');
}

function updateTxModalFields() {
  const type = document.getElementById('tx-type')?.value;
  const rowTicker = document.getElementById('row-ticker-name');
  const groupQty = document.getElementById('group-tx-qty');
  const labelPrice = document.getElementById('label-tx-price');
  const rowFees = document.getElementById('row-fees');

  const cashOnly = ['DEPOSIT', 'WITHDRAW', 'FEE'].includes(type);
  const isSplit = type === 'SPLIT';
  rowTicker.hidden = cashOnly;
  document.getElementById('group-tx-name').hidden = cashOnly;
  if (groupQty) groupQty.style.display = cashOnly || isSplit ? 'none' : 'flex';
  if (labelPrice) labelPrice.textContent = isSplit ? '분할 비율 (예: 4 또는 0.5)' :
    cashOnly ? '금액 (USD)' : type === 'DIVIDEND' ? '주당 배당금 (USD)' : '체결 가격 (USD)';
  if (rowFees) rowFees.style.display = cashOnly || isSplit ? 'none' : 'grid';
  const editing = Boolean(document.getElementById('tx-id').value);
  document.getElementById('btn-save-tx').textContent = editing ? '수정 저장' : `${TX_TYPE_LABELS[type]} 저장`;
  if (!editing) document.getElementById('modal-tx-title').textContent = `${TX_TYPE_LABELS[type]} 기록`;
  prefillTradeQuote();

}

function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openJournalModal(trade, existingNote) {
  if (trade && (trade.accountId || DEFAULT_ACCOUNT) !== state.accountId) return;
  const modal = document.getElementById('modal-journal');
  const note = existingNote || (trade && state.journalNotes.find(item => item.transactionId === trade.id));
  const fields = {
    id: note?.id,
    'transaction-id': trade?.id || note?.transactionId,
    date: note?.date || trade?.date.slice(0, 10) || localDateTime().slice(0, 10),
    ticker: trade?.ticker || note?.ticker,
    'buy-reason': note?.buyReason,
    'sell-reason': note?.sellReason,
    idea: note?.idea,
    confidence: note?.confidence || 3,
    emotion: note?.emotion,
    pros: note?.pros,
    improvements: note?.improvements,
    tags: note?.tags?.join(', ')
  };
  for (const [name, value] of Object.entries(fields)) {
    document.getElementById('journal-' + name).value = value ?? '';
  }
  document.getElementById('journal-ticker').readOnly = Boolean(trade);
  document.getElementById('modal-journal-title').textContent = note ? '복기 노트 수정' : '복기 노트 작성';
  document.getElementById('journal-trade-context').textContent = trade ? tradeSummary(trade) : '';
  modal.showModal();
}

/**
 * TradingView 실시간 캔들 차트 임베드 로더
 */
export function loadTradingViewChart(containerId, rawSymbol = 'NASDAQ:NVDA') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const symbol = (rawSymbol || 'NVDA').trim().toUpperCase();
  const cleanSym = encodeURIComponent(symbol);
  const iframe = document.createElement('iframe');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.src = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${cleanSym}&interval=D&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=111726&theme=dark&style=1&timezone=Asia%2FSeoul&locale=kr`;
  container.appendChild(iframe);
}

let chartTicker = '';

function renderWatchlistChart(watchlist) {
  const chart = document.getElementById('tradingview-main-container');
  const chips = document.getElementById('tv-symbol-chips');
  const empty = document.getElementById('tv-watch-empty');
  const nextTicker = watchlist.some(stock => stock.ticker === chartTicker) ?
    chartTicker : (watchlist[0]?.ticker || '');
  if (nextTicker !== chartTicker) {
    chartTicker = nextTicker;
    if (chartTicker) loadTradingViewChart(chart.id, chartTicker);
    else chart.replaceChildren();
  }
  chart.hidden = !chartTicker;
  empty.hidden = Boolean(chartTicker);
  chips.replaceChildren();
  document.getElementById('tv-main-title').textContent = chartTicker ?
    `TradingView 캔들차트 · ${chartTicker}` : 'TradingView 캔들차트';
  for (const { ticker } of watchlist) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary btn-tv-chip';
    button.textContent = ticker;
    button.setAttribute('aria-pressed', String(ticker === chartTicker));
    button.addEventListener('click', () => {
      if (ticker === chartTicker) return;
      loadTradingViewChart(chart.id, ticker);
      chartTicker = ticker;
      document.getElementById('tv-main-title').textContent = `TradingView 캔들차트 · ${ticker}`;
      for (const chip of chips.querySelectorAll('button')) {
        chip.setAttribute('aria-pressed', String(chip === button));
      }
    });
    chips.append(button);
  }
}

function openTradingViewModal(ticker) {
  const modal = document.getElementById('modal-tradingview');
  if (!modal) return;
  document.getElementById('modal-tv-title').textContent = `${ticker} 실시간 캔들 차트`;
  document.getElementById('modal-tv-desc').textContent = `${ticker} TradingView 실시간 시세 및 지표`;
  modal.showModal();
  loadTradingViewChart('tradingview-modal-container', ticker);
}

/**
 * 이벤트 리스너 등록
 */
function introducesInvalidClose(transactions) {
  const invalid = new Set(state.portfolio.invalidCloseIds);
  return calculatePortfolio(transactions).invalidCloseIds.some(id => !invalid.has(id));
}

function initEvents() {
  // 네비게이션 탭 클릭
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'stocks') state.watchOnly = btn.dataset.stockMode === 'watch';
      switchView(btn.dataset.view);
      window.scrollTo(0, 0);
    });
  });

  // 상단 새 거래 버튼
  const mobileMore = document.getElementById('mobile-more');
  document.addEventListener('click', event => {
    if (mobileMore.open && !mobileMore.contains(event.target)) mobileMore.open = false;
  });
  mobileMore.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobileMore.open) {
      mobileMore.open = false;
      mobileMore.querySelector('summary').focus();
    }
  });
  document.getElementById('mobile-install').addEventListener('click', () => {
    mobileMore.open = false;
    document.getElementById('btn-install-pwa').click();
  });
  document.getElementById('btn-mobile-buy')?.addEventListener('click', () => openTransactionModal('BUY'));
  document.getElementById('btn-quick-new-tx')?.addEventListener('click', () => openTransactionModal('BUY'));
  document.getElementById('btn-new-tx')?.addEventListener('click', () => openTransactionModal('BUY'));
  document.getElementById('btn-add-tx-from-port')?.addEventListener('click', () => openTransactionModal('BUY'));

  document.getElementById('account-select').addEventListener('change', async (event) => {
    state.accountId = event.target.value;
    await refreshState();
  });

  // 통화 토글
  document.getElementById('btn-curr-usd')?.addEventListener('click', () => {
    state.currency = 'USD';
    document.getElementById('btn-curr-usd').classList.add('active');
    document.getElementById('btn-curr-krw').classList.remove('active');
    renderCurrentView();
  });
  document.getElementById('btn-curr-krw')?.addEventListener('click', () => {
    state.currency = 'KRW';
    document.getElementById('btn-curr-krw').classList.add('active');
    document.getElementById('btn-curr-usd').classList.remove('active');
    renderCurrentView();
  });

  // 거래 모달 타입 변경 시 UI 반응
  document.getElementById('tx-type')?.addEventListener('change', updateTxModalFields);

  document.getElementById('tx-ticker').addEventListener('input', searchTradeSymbol);
  document.getElementById('tx-ticker').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      const first = document.querySelector('#tx-symbol-results button');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const ticker = event.currentTarget.value.trim().toUpperCase();
      const exact = [...document.querySelectorAll('#tx-symbol-results button')].find(button =>
        button.querySelector('strong').textContent === ticker);
      if (exact) exact.click();
      else if (TICKER_PATTERN.test(ticker)) selectTradeSymbol(ticker, '');
      else document.querySelector('#tx-symbol-results button')?.click();
    }
  });
  document.getElementById('tx-price').addEventListener('input', () => clearTradeQuote(false));
  for (const id of ['tx-qty', 'tx-price', 'tx-fee', 'tx-tax']) {
    document.getElementById(id).addEventListener('input', updateTradeTotal);
  }
  document.getElementById('modal-transaction').addEventListener('close', resetSymbolResults);

  // 거래 모달 닫기
  document.getElementById('btn-close-tx-modal')?.addEventListener('click', () => document.getElementById('modal-transaction')?.close());
  document.getElementById('btn-cancel-tx')?.addEventListener('click', () => document.getElementById('modal-transaction')?.close());

  // 거래 폼 제출
  document.getElementById('form-transaction')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('tx-id').value;
    const dateVal = document.getElementById('tx-date').value;
    const type = document.getElementById('tx-type').value;
    const ticker = document.getElementById('tx-ticker').value.toUpperCase().trim();
    const name = document.getElementById('tx-name').value.trim();
    const qty = parseFloat(document.getElementById('tx-qty').value) || 0;
    const price = parseFloat(document.getElementById('tx-price').value) || 0;
    const fee = parseFloat(document.getElementById('tx-fee').value) || 0;
    const tax = parseFloat(document.getElementById('tx-tax').value) || 0;
    const memo = document.getElementById('tx-memo').value.trim();

    if (!dateVal) {
      alert('거래 날짜를 입력해주세요.');
      return;
    }

    const cashOnly = ['DEPOSIT', 'WITHDRAW', 'FEE'].includes(type);
    const isSplit = type === 'SPLIT';
    if (!cashOnly && !TICKER_PATTERN.test(ticker)) {
      document.getElementById('tx-symbol-status').textContent = '검색 결과에서 종목을 선택하거나 정확한 티커를 입력해주세요.';
      document.getElementById('tx-ticker').focus();
      return;
    }
    if (price <= 0 || (!cashOnly && !isSplit && qty <= 0) ||
        (!cashOnly && !isSplit && (fee < 0 || tax < 0))) {
      alert('유형에 맞는 종목, 양수 금액과 수량, 0 이상의 수수료와 세금을 입력해주세요.');
      return;
    }

    const previous = state.transactions.find(item => item.id === id);
    const txItem = {
      ...previous,
      accountId: state.accountId,
      id: id || undefined,
      date: dateVal.replace('T', ' '),
      type,
      ticker: cashOnly ? '' : ticker,
      name: cashOnly ? '' : name,
      qty: cashOnly || isSplit ? 0 : qty,
      price: isSplit ? 0 : price,
      ratio: isSplit ? price : undefined,
      amount: cashOnly ? price : undefined,
      fee: cashOnly || isSplit ? 0 : fee,
      tax: cashOnly || isSplit ? 0 : tax,
      createdAt: previous?.createdAt || new Date().toISOString(),
      memo
    };

    const ledger = state.transactions.filter(item => item.id !== id);
    const candidate = { ...txItem, id: txItem.id || 'pending' };
    if (introducesInvalidClose([...ledger, candidate])) {
      alert('해당 시점의 보유 수량을 초과하는 매도 또는 숏커버가 생깁니다. 날짜와 수량을 확인해주세요.');
      return;
    }
    const saveButton = document.getElementById('btn-save-tx');
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    try {
      await saveTransaction(txItem);
    } catch {
      alert('거래를 저장하지 못했습니다. 브라우저 저장 공간을 확인해주세요.');
      return;
    } finally {
      saveButton.disabled = false;
    }
    document.getElementById('modal-transaction')?.close();
    await refreshState();
    const canReview = !id && [TX_TYPES.SELL, TX_TYPES.COVER].includes(type);
    showToast(`${ticker ? ticker + ' ' : ''}${TX_TYPE_LABELS[type]} 기록을 저장했습니다.`,
      canReview ? 8000 : 3000, canReview ? () => openJournalModal(txItem) : undefined);
  });

  // 복기 노트 모달 제어
  document.getElementById('btn-new-journal-note')?.addEventListener('click', () => openJournalModal());
  document.getElementById('btn-close-journal-modal')?.addEventListener('click', () => document.getElementById('modal-journal')?.close());
  document.getElementById('btn-cancel-journal')?.addEventListener('click', () => document.getElementById('modal-journal')?.close());

  document.getElementById('form-journal')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('journal-id').value;
    const transactionId = document.getElementById('journal-transaction-id').value;
    const previous = state.journalNotes.find(item => item.id === id);
    const note = {
      ...previous,
      transactionId: transactionId || undefined,
      accountId: state.accountId,
      id: id || undefined,
      date: document.getElementById('journal-date').value,
      ticker: document.getElementById('journal-ticker').value.toUpperCase().trim(),
      buyReason: document.getElementById('journal-buy-reason').value.trim(),
      sellReason: document.getElementById('journal-sell-reason').value.trim(),
      idea: document.getElementById('journal-idea').value.trim(),
      confidence: parseInt(document.getElementById('journal-confidence').value) || 3,
      emotion: document.getElementById('journal-emotion').value.trim(),
      pros: document.getElementById('journal-pros').value.trim(),
      improvements: document.getElementById('journal-improvements').value.trim(),
      tags: document.getElementById('journal-tags').value.split(',').map(s => s.trim()).filter(Boolean)
    };

    const saveButton = document.getElementById('btn-save-journal');
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    try {
      await saveJournalNote(note);
    } catch {
      showToast('복기 노트를 저장하지 못했습니다.');
      return;
    } finally {
      saveButton.disabled = false;
    }
    document.getElementById('modal-journal')?.close();
    showToast('투자 복기 노트가 저장되었습니다.');
    refreshState();
  });

  // 거래 검색 및 필터
  document.getElementById('tx-search-input')?.addEventListener('input', (e) => {
    state.txFilter.query = e.target.value;
    renderTransactions();
  });
  document.getElementById('tx-type-filter')?.addEventListener('change', (e) => {
    state.txFilter.type = e.target.value;
    renderTransactions();
  });

  // CSV 내보내기
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    if (state.transactions.length === 0) {
      alert('내보낼 거래내역이 없습니다.');
      return;
    }
    const headers = ['날짜', '유형', '티커', '종목명', '수량', '체결단가', '수수료', '세금', '메모'];
    const rows = state.transactions.map(t => [
      `"${t.date || ''}"`,
      `"${t.type || ''}"`,
      `"${t.ticker || ''}"`,
      `"${t.name || ''}"`,
      t.qty || 0,
      t.price || 0,
      t.fee || 0,
      t.tax || 0,
      `"${(t.memo || '').replace(/"/g, '""')}"`
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hanriver_transactions_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV 파일이 다운로드되었습니다.');
  });

  // JSON 백업 & 복원
  document.getElementById('btn-export-json')?.addEventListener('click', exportAllData);
  document.getElementById('btn-import-json-trigger')?.addEventListener('click', () => {
    document.getElementById('json-file-input')?.click();
  });
  document.getElementById('json-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await importAllData(json);
      showToast('백업 데이터가 성공적으로 복원되었습니다.');
      refreshState();
    } catch (err) {
      alert('백업 파일 가져오기 실패: ' + err.message);
    }
    e.target.value = '';
  });

  // 전체 데이터 삭제
  document.getElementById('btn-clear-all')?.addEventListener('click', async () => {
    if (confirm('정말로 모든 거래내역과 복기 노트를 삭제하시겠습니까? 이 작업은 취소할 수 없습니다.')) {
      localStorage.clear();
      showToast('모든 데이터가 초기화되었습니다.');
      refreshState();
    }
  });

  // 설정 저장
  document.getElementById('btn-save-settings')?.addEventListener('click', () => {
    const s = {
      ...state.settings,
      colorMode: document.getElementById('setting-color-mode').value,
      targetProfitUSD: parseFloat(document.getElementById('setting-target-profit').value) || 20000,
      targetReturnPercent: parseFloat(document.getElementById('setting-target-rate').value) || 25,
      maxAllowedMDD: parseFloat(document.getElementById('setting-max-mdd').value) || 15,
      fxRate: parseFloat(document.getElementById('setting-fx-rate').value) || 1425,
      apiKeyTwelveData: document.getElementById('setting-twelve-key').value.trim(),
      apiKeyFinnhub: document.getElementById('setting-finnhub-key').value.trim()
    };
    saveSettings(s);
    showToast('일반 설정이 저장되었습니다.');
    refreshState();
  });

  // Finnhub 키 검증 및 저장 버튼
  document.getElementById('btn-test-finnhub')?.addEventListener('click', async () => {
    const keyInput = document.getElementById('setting-finnhub-key');
    const resultEl = document.getElementById('finnhub-test-result');
    const key = keyInput ? keyInput.value.trim() : '';
    
    if (!key) {
      if (resultEl) {
        resultEl.style.color = '#ef4444';
        resultEl.innerHTML = '⚠️ Finnhub API 키를 입력해주세요.';
      }
      return;
    }

    if (resultEl) {
      resultEl.style.color = 'var(--text-secondary)';
      resultEl.innerHTML = '⏳ Finnhub 서버 연결 및 API 키 검증 중...';
    }

    const res = await testFinnhubKey(key);
    if (res.ok) {
      state.settings.apiKeyFinnhub = key;
      saveSettings(state.settings);
      if (resultEl) {
        resultEl.style.color = 'var(--accent-emerald)';
        resultEl.innerHTML = `✅ ${res.message} - API 키가 저장되었습니다!`;
      }
      showToast('Finnhub 실시간 시세가 성공적으로 연동되었습니다!');
      await refreshVisibleQuotes();
    } else {
      if (resultEl) {
        resultEl.style.color = '#ef4444';
        resultEl.innerHTML = `❌ ${res.message}`;
      }
      showToast('API 키 검증 실패: 키를 다시 확인해주세요.');
    }
  });

  async function refreshVisibleQuotes() {
    if (refreshingQuotes) return;
    const viewingStocks = state.currentView === 'stocks';
    const holdings = (state.portfolio?.holdings || []).map(holding => holding.ticker);
    const tickers = [...new Set(viewingStocks ? visibleStockTickers : holdings)];
    if (!tickers.length) {
      showToast(viewingStocks ? '시세를 조회할 종목이 없습니다.' : '보유 종목이 없습니다.');
      return;
    }
    if (!state.settings.apiKeyFinnhub && !state.settings.apiKeyTwelveData) {
      showToast('설정에서 시세 API 키를 등록해주세요.');
      return;
    }

    const spinIcon = document.getElementById('refresh-spin-icon');
    refreshingQuotes = true;
    updateQuoteButtons();
    spinIcon.style.animation = 'spin 1s infinite linear';
    try {
      const quotes = await refreshAllQuotes(tickers, state.settings);
      const refreshed = Object.values(quotes).filter(quote => quote.refreshed).length;
      await refreshState();
      showToast(`시세 조회 ${refreshed}/${tickers.length}개 갱신`);
    } finally {
      refreshingQuotes = false;
      updateQuoteButtons();
      spinIcon.style.animation = 'none';
    }
  }

  document.getElementById('btn-header-refresh').addEventListener('click', refreshVisibleQuotes);
  document.getElementById('btn-stock-refresh-all').addEventListener('click', refreshVisibleQuotes);
  for (const layout of ['card', 'list']) {
    document.getElementById('watch-layout-' + layout).addEventListener('click', () => {
      const settings = { ...getSettings(), watchlistLayout: layout };
      try {
        saveSettings(settings);
      } catch {
        showToast('보기 설정을 저장하지 못했습니다.');
        return;
      }
      state.settings = settings;
      renderStocks();
    });
  }

  // 헤더 설정 버튼
  document.getElementById('btn-header-settings')?.addEventListener('click', () => switchView('settings'));

  // 종목 검색
  for (const id of ['stock-mode-search', 'stock-mode-watch']) {
    document.getElementById(id).addEventListener('click', () => {
      state.watchOnly = id === 'stock-mode-watch';
      renderStocks();
    });
  }
  document.getElementById('stock-search-form').addEventListener('submit', event => {
    event.preventDefault();
    renderStocks();
  });
  document.getElementById('stock-search-input').addEventListener('input', event => {
    if (!event.target.value.trim()) renderStocks();
  });

  // TradingView 모달 닫기
  document.getElementById('btn-close-tv-modal')?.addEventListener('click', () => {
    document.getElementById('modal-tradingview')?.close();
  });

  // PWA Service Worker 및 설치 프롬프트
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      console.log('Hanriver PWA ServiceWorker ready:', reg.scope);
    }).catch((err) => {
      console.warn('PWA ServiceWorker error:', err);
    });
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('btn-install-pwa');
    if (btn) btn.style.display = 'flex';
  });

  document.getElementById('btn-install-pwa')?.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        showToast('한강아니면 한강뷰 앱이 설치되었습니다!');
      }
      deferredPrompt = null;
    } else {
      alert("크롬 주소창 우측 상단의 '설치' 아이콘(컴퓨터 모니터 모양)을 클릭하시거나, 브라우저 메뉴(⋮) > '앱 설치'를 누르시면 PC/모바일 홈 화면에 독립 앱으로 바로 설치할 수 있습니다!");
    }
  });

  // 윈도우 리사이즈 시 차트 다시 그리기
  window.addEventListener('resize', () => {
    if (state.currentView === 'dashboard') {
      drawAllocationDonut();
      drawMonthlyBarChart();
    } else if (state.currentView === 'performance') {
      drawTickerPnLChart();
      drawPnLDistributionChart();
    }
  });
}

// 초기 기동
document.addEventListener('DOMContentLoaded', async () => {
  initEvents();
  await refreshState();

});
