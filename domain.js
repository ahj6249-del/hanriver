/**
 * 한강아니면 한강뷰 (Hanriver) - Financial Calculation Domain Engine
 * 미국 주식 포트폴리오 및 매매 성과 분석 계산 모듈
 */

export const TX_TYPES = {
  BUY: 'BUY',           // 매수 (롱 진입/추가)
  SELL: 'SELL',         // 매도 (롱 청산/부분청산)
  SHORT: 'SHORT',       // 공매도 (숏 진입/추가)
  COVER: 'COVER',       // 숏커버 (숏 청산/부분청산)
  DEPOSIT: 'DEPOSIT',   // 입금
  WITHDRAW: 'WITHDRAW', // 출금
  DIVIDEND: 'DIVIDEND', // 배당
  FEE: 'FEE',           // 기타 수수료
  SPLIT: 'SPLIT'        // 주식분할
};

export const TX_TYPE_LABELS = {
  BUY: '매수',
  SELL: '매도',
  SHORT: '공매도',
  COVER: '숏커버',
  DEPOSIT: '입금',
  WITHDRAW: '출금',
  DIVIDEND: '배당',
  FEE: '수수료',
  SPLIT: '주식분할'
};

/**
 * 거래내역 리스트를 시간순 정렬하여 포트폴리오 상태 및 손익을 계산
 * 이동평균법(Weighted Average Cost) 기반 원가 산출
 */
export function transactionTime(date) {
  if (typeof date !== 'string') return NaN;
  const local = date.replace(' ', 'T');
  return Date.parse(local.length === 10 ? local + 'T00:00' : local);
}

export function calculatePortfolio(transactions = [], currentPrices = {}, fxRate = 1420, now = Date.now()) {
  // 날짜/시간 순 정렬 (오름차순)
  const sorted = transactions.filter(tx => transactionTime(tx?.date) <= now)
    .sort((a, b) => transactionTime(a.date) - transactionTime(b.date) ||
    (a.createdAt || '').localeCompare(b.createdAt || ''));

  let cash = 0;
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalDividends = 0;
  let totalFees = 0;
  let totalRealizedPnL = 0;
  let standaloneFees = 0;

  // 종목별 포지션: ticker -> { qty: 0, costBasis: 0, shortQty: 0, shortPrice: 0, realizedPnL: 0, totalFees: 0, name: '' }
  const positions = Object.create(null);

  // 완료된 포지션(거래)별 기록 (성과 분석용)
  const closedTrades = [];
  const invalidCloseIds = [];

  for (const tx of sorted) {
    const type = tx.type;
    const ticker = (tx.ticker || '').toUpperCase().trim();
    const qty = parseFloat(tx.qty) || 0;
    const price = parseFloat(tx.price) || 0;
    const fee = parseFloat(tx.fee) || 0;
    const tax = parseFloat(tx.tax) || 0;
    const totalFee = fee + tax;

    totalFees += totalFee;

    if (!positions[ticker] && ticker) {
      positions[ticker] = {
        ticker,
        name: tx.name || ticker,
        qty: 0,            // 롱 보유 수량
        costBasis: 0,      // 롱 1주당 평균매수가 (수수료 포함)
        shortQty: 0,       // 숏 보유 수량
        shortPrice: 0,     // 숏 1주당 평균진입가
        realizedPnL: 0,    // 종목별 누적 실현손익
        totalFees: 0,
        tradeCount: 0
      };
    }

    const pos = positions[ticker];
    if (pos) pos.totalFees += totalFee;

    switch (type) {
      case TX_TYPES.DEPOSIT: {
        const amt = parseFloat(tx.amount || tx.price) || 0;
        cash += amt;
        totalDeposits += amt;
        break;
      }
      case TX_TYPES.WITHDRAW: {
        const amt = parseFloat(tx.amount || tx.price) || 0;
        cash -= amt;
        totalWithdrawals += amt;
        break;
      }
      case TX_TYPES.DIVIDEND: {
        const amt = parseFloat(tx.amount || (price * qty)) || 0;
        const netDiv = amt - totalFee;
        cash += netDiv;
        totalDividends += netDiv;
        if (pos) pos.realizedPnL += netDiv;
        break;
      }
      case TX_TYPES.FEE: {
        const amt = parseFloat(tx.amount || price || fee) || 0;
        cash -= amt;
        standaloneFees += amt;
        totalFees += amt - totalFee;
        break;
      }
      case TX_TYPES.BUY: {
        // 매수 총 지출 = 주가 * 수량 + 수수료 + 세금
        const totalCost = (price * qty) + totalFee;
        cash -= totalCost;

        if (pos) {
          pos.tradeCount++;
          if (pos.qty === 0) pos.longOpenedAt = tx.date;
          // 이동평균 단가 계산 (기존 보유비용 + 이번 매수비용) / 총 수량
          const prevTotalCost = pos.costBasis * pos.qty;
          pos.qty += qty;
          pos.costBasis = pos.qty > 0 ? (prevTotalCost + totalCost) / pos.qty : 0;
        }
        break;
      }
      case TX_TYPES.SELL: {
        if (!pos || qty <= 0 || qty - pos.qty > 1e-8) {
          invalidCloseIds.push(tx.id);
          totalFees -= totalFee;
          if (pos) pos.totalFees -= totalFee;
          break;
        }
        pos.tradeCount++;

        const sellQty = Math.min(qty, pos.qty);
        // 매도 순 수입 = 매도가 * 수량 - 수수료 - 세금
        const proceeds = (price * sellQty) - totalFee;
        const entryPrice = pos.costBasis;
        const cost = entryPrice * sellQty;
        const tradePnL = proceeds - cost;

        cash += proceeds;
        pos.qty = Math.max(0, pos.qty - sellQty);
        if (pos.qty < 1e-8) pos.qty = 0;
        pos.realizedPnL += tradePnL;
        totalRealizedPnL += tradePnL;

        if (pos.qty === 0) {
          pos.costBasis = 0;
        }

        closedTrades.push({
          id: tx.id,
          date: tx.date,
          ticker,
          name: pos.name,
          side: 'LONG',
          entryDate: pos.longOpenedAt,
          qty: sellQty,
          entryPrice,
          exitPrice: price,
          pnl: tradePnL,
          pnlPercent: cost > 0 ? (tradePnL / cost) * 100 : 0,
          fee: totalFee
        });
        break;
      }
      case TX_TYPES.SHORT: {
        // 공매도 진입: 현금 입금(마진) = 주가 * 수량 - 수수료
        const proceeds = (price * qty) - totalFee;
        cash += proceeds;

        if (pos) {
          pos.tradeCount++;
          if (pos.shortQty === 0) pos.shortOpenedAt = tx.date;
          const prevShortVal = pos.shortPrice * pos.shortQty;
          pos.shortQty += qty;
          pos.shortPrice = pos.shortQty > 0 ? (prevShortVal + proceeds) / pos.shortQty : 0;
        }
        break;
      }
      case TX_TYPES.COVER: {
        // 숏커버(환매수): 현금 지출 = 주가 * 수량 + 수수료
        if (!pos || qty <= 0 || qty - pos.shortQty > 1e-8) {
          invalidCloseIds.push(tx.id);
          totalFees -= totalFee;
          if (pos) pos.totalFees -= totalFee;
          break;
        }
        pos.tradeCount++;

        const coverQty = Math.min(qty, pos.shortQty);
        const costToCover = (price * coverQty) + totalFee;
        const entryPrice = pos.shortPrice;
        const shortVal = entryPrice * coverQty;
        const tradePnL = shortVal - costToCover; // 진입가보다 낮게 사면 이익

        cash -= costToCover;
        pos.shortQty = Math.max(0, pos.shortQty - coverQty);
        if (pos.shortQty < 1e-8) pos.shortQty = 0;
        pos.realizedPnL += tradePnL;
        totalRealizedPnL += tradePnL;

        if (pos.shortQty === 0) {
          pos.shortPrice = 0;
        }

        closedTrades.push({
          id: tx.id,
          date: tx.date,
          ticker,
          name: pos.name,
          side: 'SHORT',
          entryDate: pos.shortOpenedAt,
          qty: coverQty,
          entryPrice,
          exitPrice: price,
          pnl: tradePnL,
          pnlPercent: shortVal > 0 ? (tradePnL / shortVal) * 100 : 0,
          fee: totalFee
        });
        break;
      }
      case TX_TYPES.SPLIT: {
        // ratio: 분할 비율 (예: 4 for 4-for-1 split, 0.5 for reverse split)
        const ratio = parseFloat(tx.ratio) || 1;
        if (pos && ratio > 0) {
          if (pos.qty > 0) {
            pos.qty *= ratio;
            pos.costBasis /= ratio;
          }
          if (pos.shortQty > 0) {
            pos.shortQty *= ratio;
            pos.shortPrice /= ratio;
          }
        }
        break;
      }
    }
  }

  // 현재가 기준 평가금액 및 미실현손익 계산
  let totalStockEval = 0;
  let totalUnrealizedPnL = 0;
  let totalDailyPnL = 0;

  const activeHoldings = [];

  for (const [ticker, pos] of Object.entries(positions)) {
    const quote = currentPrices[ticker];

    // 롱 포지션 계산
    if (pos.qty > 0) {
      const curPrice = quote?.price || pos.costBasis;
      const prevClose = quote?.previousClose || curPrice;
      const evalValue = pos.qty * curPrice;
      const totalCost = pos.qty * pos.costBasis;
      const unrealizedPnL = evalValue - totalCost;
      const returnRate = totalCost > 0 ? (unrealizedPnL / totalCost) * 100 : 0;
      const dailyPnL = pos.qty * (curPrice - prevClose);

      totalStockEval += evalValue;
      totalUnrealizedPnL += unrealizedPnL;
      totalDailyPnL += dailyPnL;

      activeHoldings.push({
        ticker,
        name: pos.name,
        side: 'LONG',
        qty: pos.qty,
        costBasis: pos.costBasis,
        currentPrice: curPrice,
        quote,
        previousClose: prevClose,
        evalValue,
        unrealizedPnL,
        returnRate,
        changePercent: quote?.changePercent || 0,
        dailyPnL,
        realizedPnL: pos.realizedPnL
      });
    }

    // 숏 포지션 계산
    if (pos.shortQty > 0) {
      const curPrice = quote?.price || pos.shortPrice;
      const prevClose = quote?.previousClose || curPrice;
      const shortLiability = pos.shortQty * curPrice;
      const shortEntryVal = pos.shortQty * pos.shortPrice;
      const unrealizedPnL = shortEntryVal - shortLiability;
      const returnRate = shortEntryVal > 0 ? (unrealizedPnL / shortEntryVal) * 100 : 0;
      const dailyPnL = pos.shortQty * (prevClose - curPrice);

      totalUnrealizedPnL += unrealizedPnL;
      totalDailyPnL += dailyPnL;

      activeHoldings.push({
        ticker,
        name: pos.name,
        side: 'SHORT',
        qty: pos.shortQty,
        costBasis: pos.shortPrice,
        currentPrice: curPrice,
        quote,
        previousClose: prevClose,
        evalValue: -shortLiability,
        unrealizedPnL,
        returnRate,
        changePercent: quote?.changePercent || 0,
        dailyPnL,
        realizedPnL: pos.realizedPnL
      });
    }
  }

  // 현금에 롱 평가액을 더하고 숏 상환 의무의 평가액을 뺀다.
  const totalNav = cash + activeHoldings.reduce((sum, holding) => sum + holding.evalValue, 0);
  
  // 비중(%) 계산
  for (const h of activeHoldings) {
    h.weightPercent = totalNav > 0 ? (Math.abs(h.evalValue) / totalNav) * 100 : 0;
  }

  // 순 원금 = 총 입금 - 총 출금
  const netPrincipal = totalDeposits - totalWithdrawals;
  // 총 누적 투자손익 = 실현손익 + 미실현손익 + 배당 - 수수료
  const totalInvestmentPnL = totalRealizedPnL + totalUnrealizedPnL + totalDividends - standaloneFees;
  const cumulativeReturnRate = netPrincipal > 0 ? (totalInvestmentPnL / netPrincipal) * 100 : 0;
  const dailyReturnRate = (totalNav - totalDailyPnL) > 0 ? (totalDailyPnL / (totalNav - totalDailyPnL)) * 100 : 0;

  return {
    cash,
    totalDeposits,
    totalWithdrawals,
    netPrincipal,
    totalStockEval,
    totalNav,
    totalRealizedPnL,
    totalUnrealizedPnL,
    totalDividends,
    totalFees,
    totalInvestmentPnL,
    cumulativeReturnRate,
    totalDailyPnL,
    dailyReturnRate,
    holdings: activeHoldings,
    positions,
    closedTrades,
    invalidCloseIds,
    fxRate
  };
}

/**
 * 투자 성과 상세 통계 지표 계산
 */
const marketDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' });

export function calculateAccountDay(transactions, quotes, current, now = Date.now()) {
  const day = marketDay.format(now);
  const earlier = [];
  let splitToday = false;
  for (const tx of transactions) {
    const time = transactionTime(tx.date);
    if (!Number.isFinite(time) || time > now) continue;
    if (marketDay.format(time) < day) earlier.push(tx);
    else if (tx.type === TX_TYPES.SPLIT) splitToday = true;
  }
  const previousPrices = Object.create(null);
  for (const [ticker, quote] of Object.entries(quotes)) {
    previousPrices[ticker] = { price: quote?.previousClose };
  }
  const opening = calculatePortfolio(earlier, previousPrices, undefined, now);
  const tickers = [...new Set([...opening.holdings, ...current.holdings].map(item => item.ticker))];
  if (splitToday) return { tickers, reason: '오늘 주식분할 기록이 있어 계산을 보류했어요.' };
  const isTodayQuote = quote => ['Finnhub', 'Twelve Data'].includes(quote?.source) &&
    Number.isFinite(Date.parse(quote.updatedAt)) && marketDay.format(Date.parse(quote.updatedAt)) === day;
  if (opening.holdings.some(({ticker}) => !isTodayQuote(quotes[ticker]) || !(quotes[ticker].previousClose > 0)) ||
      current.holdings.some(({ticker}) => !isTodayQuote(quotes[ticker]) || !(quotes[ticker].price > 0))) {
    return { tickers, reason: '당일 시세 필요' };
  }
  const pnl = current.totalNav - opening.totalNav - (current.netPrincipal - opening.netPrincipal);
  return { tickers, pnl, rate: opening.totalNav > 0 ? pnl / opening.totalNav * 100 : null };
}

export function calculatePerformanceMetrics(closedTrades = [], portfolio = {}) {
  const totalTrades = closedTrades.length;
  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      profitFactor: null,
      avgWin: 0,
      avgLoss: 0,
      payoffRatio: null,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      maxDrawdown: null,
      monthlyPnL: {},
      tickerPnL: {}
    };
  }

  let winCount = 0;
  let lossCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  let consecutiveWins = 0;
  let maxConsecutiveWins = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;

  const monthlyPnL = {};
  const tickerPnL = {};

  for (const trade of closedTrades) {
    const pnl = trade.pnl;
    const month = trade.date.slice(0, 7); // YYYY-MM
    monthlyPnL[month] = (monthlyPnL[month] || 0) + pnl;

    tickerPnL[trade.ticker] = (tickerPnL[trade.ticker] || 0) + pnl;

    if (pnl > 0) {
      winCount++;
      grossProfit += pnl;
      consecutiveWins++;
      consecutiveLosses = 0;
      if (consecutiveWins > maxConsecutiveWins) maxConsecutiveWins = consecutiveWins;
    } else if (pnl < 0) {
      lossCount++;
      grossLoss += Math.abs(pnl);
      consecutiveLosses++;
      consecutiveWins = 0;
      if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
    }
  }

  const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
  const avgWin = winCount > 0 ? grossProfit / winCount : 0;
  const avgLoss = lossCount > 0 ? grossLoss / lossCount : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  return {
    totalTrades,
    winCount,
    lossCount,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    payoffRatio,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    maxDrawdown: null,
    monthlyPnL,
    tickerPnL
  };
}

/**
 * 매매 습관 분석 (보유기간별, 롱/숏별 성과 분석)
 */
export function calculateHabits(closedTrades = [], allTransactions = []) {
  // 거래별 진입일과 청산일 매칭하여 보유일수 계산
  const buckets = {
    DAY: { label: '당일 매매 (데이)', count: 0, wins: 0, totalPnL: 0 },
    SHORT_TERM: { label: '1~3일 (초단기)', count: 0, wins: 0, totalPnL: 0 },
    MEDIUM_TERM: { label: '4~7일 (스윙)', count: 0, wins: 0, totalPnL: 0 },
    MONTH: { label: '8~30일 (중기)', count: 0, wins: 0, totalPnL: 0 },
    LONG_TERM: { label: '31일 이상 (장기)', count: 0, wins: 0, totalPnL: 0 }
  };

  const sideStats = {
    LONG: { count: 0, wins: 0, totalPnL: 0 },
    SHORT: { count: 0, wins: 0, totalPnL: 0 }
  };

  const entryDates = closedTrades.some(trade => !trade.entryDate) ?
    new Map(calculatePortfolio(allTransactions).closedTrades.map(trade => [trade.id, trade.entryDate])) : new Map();
  for (const trade of closedTrades) {
    // 롱/숏 성과
    const side = trade.side || 'LONG';
    sideStats[side].count++;
    sideStats[side].totalPnL += trade.pnl;
    if (trade.pnl > 0) sideStats[side].wins++;

    // Holding period is the continuous position cycle, separately for long/short.
    // Additions and partial closes retain its start; a full close resets it.
    const entryDate = trade.entryDate || entryDates.get(trade.id);
    const start = entryDate ? Date.parse(entryDate.slice(0, 10)) : NaN;
    const end = Date.parse(trade.date.slice(0, 10));
    const days = Number.isFinite(start) && Number.isFinite(end) ?
      Math.max(0, Math.round((end - start) / 86400000)) : null;

    let bKey = 'DAY';
    if (days === null) {
      bKey = 'UNKNOWN';
      buckets.UNKNOWN ||= { label: '보유기간 미확인', count: 0, wins: 0, totalPnL: 0 };
    } else if (days === 0) bKey = 'DAY';
    else if (days <= 3) bKey = 'SHORT_TERM';
    else if (days <= 7) bKey = 'MEDIUM_TERM';
    else if (days <= 30) bKey = 'MONTH';
    else bKey = 'LONG_TERM';

    buckets[bKey].count++;
    buckets[bKey].totalPnL += trade.pnl;
    if (trade.pnl > 0) buckets[bKey].wins++;
  }

  // 각 버킷별 승률 계산
  for (const key in buckets) {
    const b = buckets[key];
    b.winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
  }
  for (const key in sideStats) {
    const s = sideStats[key];
    s.winRate = s.count > 0 ? (s.wins / s.count) * 100 : 0;
  }

  return {
    holdingPeriods: buckets,
    sides: sideStats
  };
}

/**
 * 숫자 및 통화 포맷팅 헬퍼
 */
export function formatUSD(val, withSign = false) {
  if (val === null || val === undefined || isNaN(val)) return '$0.00';
  const num = parseFloat(val);
  const formatted = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (withSign && num > 0) return `+$${formatted}`;
  if (num < 0) return `-$${formatted}`;
  return `$${formatted}`;
}

export function formatKRW(valUSD, fxRate = 1420) {
  if (valUSD === null || valUSD === undefined || isNaN(valUSD)) return '₩0';
  const krw = Math.round(valUSD * fxRate);
  return `₩${krw.toLocaleString('ko-KR')}`;
}

export function formatPercent(val, withSign = true) {
  if (val === null || val === undefined || isNaN(val)) return '0.00%';
  const num = parseFloat(val);
  const formatted = Math.abs(num).toFixed(2);
  if (withSign && num > 0) return `+${formatted}%`;
  if (num < 0) return `-${formatted}%`;
  return `${formatted}%`;
}

export function formatQty(val) {
  if (!val || isNaN(val)) return '0';
  return parseFloat(val).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Cash from short sales is encumbered; it is not a safe cash buffer. */
export function assessCashBuffer(portfolio) {
  const { cash = 0, totalNav = 0, holdings = [] } = portfolio || {};
  const shortLiability = holdings.reduce((sum, h) => sum + Math.max(0, -h.evalValue), 0);
  const cashRatio = totalNav > 0 ? cash / totalNav * 100 : null;
  const status = !Number.isFinite(totalNav) || totalNav <= 0 ? 'unknown' :
    shortLiability > 0 ? 'short' : cash < 0 ? 'deficit' :
    cashRatio < 10 ? 'low' : cashRatio <= 30 ? 'buffer' : 'high';
  return { status, cashRatio, shortLiability, cashAfterCover: cash - shortLiability };
}

/** Encode every CSV field uniformly, including quotes, commas and newlines. */
export function transactionsToCSV(transactions) {
  const headers = ['날짜', '유형', '티커', '종목명', '수량', '체결단가', '수수료', '세금', '메모', '금액', '분할비율', '계좌ID'];
  const rows = transactions.map(t => {
    const amount = t.amount ?? ([TX_TYPES.DEPOSIT, TX_TYPES.WITHDRAW, TX_TYPES.FEE].includes(t.type) ?
      (t.price || t.fee || 0) : t.type === TX_TYPES.DIVIDEND ? (t.qty || 0) * (t.price || 0) : '');
    return [t.date, t.type, t.ticker, t.name, t.qty ?? 0, t.price ?? 0, t.fee ?? 0, t.tax ?? 0,
      t.memo, amount, t.type === TX_TYPES.SPLIT ? t.ratio : '', t.accountId || 'default'];
  });
  const cell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
