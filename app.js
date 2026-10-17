/* ================= 工具 ================= */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const state = {
  session: null,
  currentProduct: null,
  pendingQty: null   // 語音識別出嘅數量，等用戶揀貨品後自動填入
};

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  return Number.isInteger(x) ? x : x.toFixed(1);
}

/* ================= 連線狀態 ================= */
function updateNet() {
  const el = $('#netState');
  if (navigator.onLine) { el.textContent = '●'; el.classList.remove('off'); }
  else { el.textContent = '● 離線'; el.classList.add('off'); }
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

/* ================= 盤點單 ================= */
async function getOrCreateSession() {
  const sid = localStorage.getItem('current_session');
  if (sid) {
    const rec = await DB.get('meta', 'session_' + sid);
    if (rec && rec.value) return rec.value;
  }
  const session = {
    id: uid(),
    name: '盤點 ' + todayStr(),
    date: todayStr(),
    createdAt: Date.now()
  };
  await DB.put('meta', { key: 'session_' + session.id, value: session });
  localStorage.setItem('current_session', session.id);
  return session;
}

async function newSession() {
  if (!confirm('開新盤點單？現有盤點記錄會保留，可以喺報表頁再匯出。')) return;
  const session = {
    id: uid(),
    name: '盤點 ' + todayStr() + ' ' + new Date().toLocaleTimeString('zh-HK', {hour:'2-digit',minute:'2-digit'}),
    date: todayStr(),
    createdAt: Date.now()
  };
  await DB.put('meta', { key: 'session_' + session.id, value: session });
  localStorage.setItem('current_session', session.id);
  state.session = session;
  await refreshAll();
  toast('已開新盤點單');
}

/* ================= 視圖切換 ================= */
function showView(id) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'view-report') refreshReport();
  if (id === 'view-products') refreshProducts();
}

/* ================= 貨品 ================= */
async function findProducts(q) {
  const all = await DB.all('products');
  q = (q || '').trim().toLowerCase();
  if (!q) return all.slice(0, 50);
  return all.filter(p =>
    (p.barcode && p.barcode.toLowerCase().includes(q)) ||
    (p.sku     && p.sku.toLowerCase().includes(q)) ||
    (p.name    && p.name.toLowerCase().includes(q))
  ).slice(0, 50);
}

async function findExact(code) {
  const all = await DB.all('products');
  code = String(code).trim();
  return all.find(p => p.barcode === code || p.sku === code) || null;
}

/* ================= 輸入面板 ================= */
function openEntry(product, qty) {
  state.currentProduct = product;
  $('#entryName').textContent = product.name || '(無名稱)';
  $('#entryMeta').textContent =
    `條碼 ${product.barcode || '—'} ｜ 編號 ${product.sku || '—'} ｜ 帳面 ${fmtQty(product.expectedQty) || 0} ${product.unit || ''}`;
  $('#qtyInput').value = (qty !== undefined && qty !== null && !isNaN(qty)) ? qty : 1;
  $('#locInput').value = '';
  $('#noteInput').value = '';
  $('#entryPanel').style.display = 'block';
  $('#searchResults').innerHTML = '';
  setTimeout(() => $('#qtyInput').select(), 100);
}

function closeEntry() {
  state.currentProduct = null;
  $('#entryPanel').style.display = 'none';
}

async function saveEntry() {
  if (!state.currentProduct) return;
  let qty = Number($('#qtyInput').value);
  if (!Number.isFinite(qty)) { toast('請輸入正確數量'); return; }
  qty = Math.round(qty * 10) / 10; // 1 位小數

  const p = state.currentProduct;
  const key = p.barcode || p.sku || p.name;

  const existing = (await DB.byIndex('counts', 'sessionId', state.session.id))
    .find(c => (c.barcode || c.sku || c.name) === key);

  const record = existing || {};
  Object.assign(record, {
    sessionId: state.session.id,
    barcode: p.barcode || '',
    sku: p.sku || '',
    name: p.name || '',
    unit: p.unit || '',
    expectedQty: Number(p.expectedQty) || 0,
    countedQty: qty,
    location: $('#locInput').value.trim(),
    note: $('#noteInput').value.trim(),
    countedAt: Date.now()
  });
  await DB.put('counts', record);

  closeEntry();
  toast(`已記錄：${p.name || p.barcode} = ${fmtQty(qty)}`);
  await refreshToday();
  $('#searchInput').value = '';
}

/* ================= 語音輸入 ================= */
let voiceRec = null;
let voiceText = '';

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('此瀏覽器唔支援語音輸入'); return; }
  if (voiceRec) { stopVoice(); return; }

  voiceText = '';
  voiceRec = new SR();
  voiceRec.lang = 'zh-HK';
  voiceRec.continuous = false;
  voiceRec.interimResults = true;
  voiceRec.maxAlternatives = 1;

  $('#voicePanel').style.display = 'block';
  $('#voiceText').textContent = '請講…';
  $('#btnVoice').classList.add('recording');

  voiceRec.onresult = (e) => {
    let interim = '', final = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    voiceText = final || interim;
    $('#voiceText').textContent = voiceText || '請講…';
  };

  voiceRec.onerror = (e) => {
    console.warn(e);
    if (e.error === 'not-allowed') toast('請允許麥克風權限');
    else if (e.error === 'no-speech') toast('冇聽到聲音');
    else if (e.error === 'network') toast('語音識別需要聯網');
    else toast('語音錯誤：' + e.error);
  };

  voiceRec.onend = () => {
    voiceRec = null;
    $('#btnVoice').classList.remove('recording');
    const text = voiceText.trim();
    voiceText = '';
    if (text) handleVoiceInput(text);
    else $('#voicePanel').style.display = 'none';
  };

  try { voiceRec.start(); }
  catch (err) { toast('無法啟動語音：' + err.message); }
}

function stopVoice() {
  if (voiceRec) { try { voiceRec.stop(); } catch (_) {} }
}

/* ---------- 中文數字解析 ---------- */
const CN_DIGIT = {
  '零':0,'〇':0,'O':0,'o':0,
  '一':1,'壹':1,'幺':1,
  '二':2,'貳':2,'贰':2,'兩':2,'两':2,
  '三':3,'參':3,'参':3,
  '四':4,'肆':4,
  '五':5,'伍':5,
  '六':6,'陸':6,'陆':6,
  '七':7,'柒':7,
  '八':8,'捌':8,
  '九':9,'玖':9
};
const CN_UNIT = {
  '十':10,'拾':10,
  '百':100,'佰':100,
  '千':1000,'仟':1000,
  '萬':10000,'万':10000
};

function parseCnNumber(str) {
  if (str === null || str === undefined) return null;
  str = String(str).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

  str = str.replace(/[點点\.]/g, '.');
  const dotIdx = str.indexOf('.');
  if (dotIdx >= 0) {
    const intPart = str.slice(0, dotIdx);
    const decPart = str.slice(dotIdx + 1);
    const intV = parseCnInteger(intPart);
    const decV = parseDecDigits(decPart);
    if (intV === null && decV === null) return null;
    return (intV || 0) + (decV || 0);
  }
  return parseCnInteger(str);
}

function parseCnInteger(str) {
  if (!str) return 0;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let total = 0, section = 0, current = 0, hasAny = false;
  for (const c of str) {
    if (CN_DIGIT[c] !== undefined) { current = CN_DIGIT[c]; hasAny = true; }
    else if (CN_UNIT[c] !== undefined) {
      const unit = CN_UNIT[c]; hasAny = true;
      if (unit >= 10000) {
        section = (section + current) * unit;
        total += section; section = 0; current = 0;
      } else {
        if (current === 0 && unit === 10) current = 1;
        section += (current || 1) * unit;
        current = 0;
      }
    }
  }
  return hasAny ? (total + section + current) : null;
}

function parseDecDigits(str) {
  if (!str) return 0;
  let digits = '';
  for (const c of str) {
    if (/\d/.test(c)) digits += c;
    else if (CN_DIGIT[c] !== undefined) digits += CN_DIGIT[c];
  }
  if (!digits) return 0;
  return parseFloat('0.' + digits);
}

/* ---------- 貨名歸一化（比對用） ---------- */
const T2S = {
  '樂':'乐','個':'个','點':'点','兩':'两','萬':'万','與':'与','來':'来',
  '說':'说','時':'时','過':'过','對':'对','這':'这','為':'为','產':'产',
  '開':'开','關':'关','門':'门','問':'问','號':'号','線':'线','組':'组',
  '裝':'装','貨':'货','條':'条','碼':'码','單':'单','數':'数','量':'量',
  '種':'种','類':'类','級':'级','鐵':'铁','銅':'铜','鋁':'铝','膠':'胶',
  '罐':'罐','瓶':'瓶','袋':'袋','箱':'箱','機':'机','電':'电','車':'车',
  '筆':'笔','紙':'纸','書':'书','寫':'写','記':'记','錄':'录','設':'设',
  '備':'备','體':'体','價':'价','錢':'钱','總':'总','計':'计','會':'会',
  '員':'员','長':'长','張':'张','發':'发','進':'进','點':'点','還':'还',
  '運':'运','輸':'输','輸':'输','轉':'转','幫':'帮','廠':'厂','庫':'库',
  '臺':'台','檯':'台','櫃':'柜','廚':'厨','廳':'厅','間':'间','樓':'楼',
  '層':'层','畫':'画','號':'号','東':'东','馬':'马','鳥':'鸟','龍':'龙',
  '鳳':'凤','龜':'龟','麥':'麦','麵':'面','飯':'饭','麵':'面','雞':'鸡',
  '鴨':'鸭','豬':'猪','蝦':'虾','魚':'鱼','鮮':'鲜','飲':'饮','醬':'酱',
  '鹽':'盐','糖':'糖','醋':'醋','油':'油','茶':'茶','葉':'叶','煙':'烟',
  '酒':'酒','藥':'药','醫':'医','療':'疗','護':'护','養':'养','營':'营',
  '纖':'纤','維':'维','鈣':'钙','鋅':'锌','鎂':'镁','鉀':'钾','鈉':'钠',
  '標':'标','籤':'签','簽':'签','證':'证','憑':'凭','資':'资','訊':'讯',
  '網':'网','絡':'络','連':'连','結':'结','繫':'系','統':'统','軟':'软',
  '體':'体','硬':'硬','碟':'碟','盤':'盘','鍵':'键','鼠':'鼠','屏':'屏',
  '幕':'幕','顯':'显','示':'示','器':'器','頭':'头','燈':'灯','風':'风',
  '扇':'扇','冷':'冷','熱':'热','暖':'暖','氣':'气','爐':'炉','鍋':'锅',
  '碗':'碗','筷':'筷','匙':'匙','刀':'刀','叉':'叉','盤':'盘','杯':'杯'
};
function normalizeCn(s) {
  if (!s) return '';
  let out = String(s).replace(/\s+/g, '');
  out = out.replace(/[，。、！？：；「」『』（）()《》【】\[\]{}·,.\-_/\\!?:;"'`~@#$%^&*+=|<>]/g, '');
  out = out.toLowerCase();
  let res = '';
  for (const c of out) res += (T2S[c] || c);
  return res;
}

/* ---------- 解析語音句子 ---------- */
function parseVoiceInput(rawText, products) {
  const raw = rawText.trim();
  if (!raw) return null;
  const normText = normalizeCn(raw);

  // 1. 最長貨名匹配
  let best = null, bestLen = 0;
  for (const p of products) {
    const nameNorm = normalizeCn(p.name || '');
    if (!nameNorm || nameNorm.length < 2) continue;
    if (normText.includes(nameNorm) && nameNorm.length > bestLen) {
      best = p; bestLen = nameNorm.length;
    }
  }

  let qty = null;
  let remaining = raw;

  if (best) {
    remaining = removeCharsForProduct(raw, best.name);
    qty = parseQtyFromText(remaining);
    // 若去掉货名后仍找不到数量，退回从原句末尾找
    if (qty === null) {
      const m = raw.match(/(\d+(?:\.\d+)?|[一二三四五六七八九十百千萬万兩两零点點]+)\s*$/);
      if (m) qty = parseCnNumber(m[1]);
    }
  } else {
    // 冇匹配到货品 → 从末尾抽数量
    const m = raw.match(/(.+?)\s*(\d+(?:\.\d+)?|[一二三四五六七八九十百千萬万兩两零点點]+)\s*$/);
    if (m) {
      qty = parseCnNumber(m[2]);
      remaining = m[1].trim();
    }
  }

  return { product: best, qty: qty, query: best ? '' : remaining, raw };
}

function removeCharsForProduct(text, productName) {
  if (!productName) return text;
  const nameChars = [...productName.replace(/\s+/g, '')];
  let result = '';
  for (const c of text) {
    if (/\s/.test(c)) continue;
    const i = nameChars.indexOf(c);
    if (i >= 0) nameChars.splice(i, 1);
    else result += c;
  }
  return result;
}

function parseQtyFromText(text) {
  if (!text) return null;
  let s = String(text).replace(/\s+/g, '');
  s = s.replace(/^(數量|数量|共|總|总|計|计|有|係|是|個|个|件|箱|包|罐|支|瓶|袋|隻|只)/, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const q = parseCnNumber(s);
  if (q !== null && !isNaN(q) && q >= 0 && q < 1000000) return q;
  const m = s.match(/(\d+(?:\.\d+)?|[一二三四五六七八九十百千萬万兩两零点點]+)$/);
  if (m) {
    const q2 = parseCnNumber(m[1]);
    if (q2 !== null && !isNaN(q2)) return q2;
  }
  return null;
}

/* ---------- 語音結果處理 ---------- */
async function handleVoiceInput(text) {
  $('#voicePanel').style.display = 'none';
  const products = await DB.all('products');
  const parsed = parseVoiceInput(text, products);

  if (!parsed) { toast('解析失敗，請再試'); return; }

  if (parsed.product) {
    openEntry(parsed.product, parsed.qty);
    toast(`匹配：${parsed.product.name}${parsed.qty !== null ? ' = ' + fmtQty(parsed.qty) : ''}`);
    return;
  }

  if (parsed.qty !== null) {
    state.pendingQty = parsed.qty;
    $('#searchInput').value = parsed.query;
    await onSearch(parsed.query);
    toast(`搵唔到貨品，請從清單揀（數量 ${fmtQty(parsed.qty)}）`);
    return;
  }

  $('#searchInput').value = text;
  await onSearch(text);
}

/* ================= 搜尋 ================= */
async function onSearch(q) {
  q = (q || '').trim();
  if (!q) { $('#searchResults').innerHTML = ''; return; }

  const exact = await findExact(q);
  if (exact) {
    const pq = state.pendingQty; state.pendingQty = null;
    openEntry(exact, pq);
    return;
  }

  const list = await findProducts(q);
  if (!list.length) {
    $('#searchResults').innerHTML =
      `<div class="item"><div class="n">找不到貨品</div><div class="m">請先喺「貨品」頁匯入 Excel</div></div>`;
    return;
  }
  $('#searchResults').innerHTML = list.map(p => `
    <div class="item" data-id="${p.id}">
      <div class="n">${esc(p.name || '(無名稱)')}</div>
      <div class="m">條碼 ${esc(p.barcode||'—')} ｜ 編號 ${esc(p.sku||'—')} ｜ 帳面 ${fmtQty(p.expectedQty)||0} ${esc(p.unit||'')}</div>
    </div>
  `).join('');
  $$('#searchResults .item').forEach(el => {
    el.onclick = async () => {
      const p = (await DB.all('products')).find(x => String(x.id) === el.dataset.id);
      if (p) {
        const pq = state.pendingQty; state.pendingQty = null;
        openEntry(p, pq);
      }
    };
  });
}

/* ================= 刷新 UI ================= */
async function refreshToday() {
  const list = await DB.byIndex('counts', 'sessionId', state.session.id);
  list.sort((a,b) => (b.countedAt||0) - (a.countedAt||0));
  $('#countBadge').textContent = list.length;
  $('#todayList').innerHTML = list.map(c => {
    const diff = (Number(c.countedQty)||0) - (Number(c.expectedQty)||0);
    let tag = 'none', txt = '未盤';
    if (diff === 0) { tag='ok'; txt='一致'; }
    else if (diff > 0) { tag='more'; txt='+'+fmtQty(diff); }
    else { tag='less'; txt=fmtQty(diff); }
    return `<div class="row">
      <div class="left">
        <div class="n">${esc(c.name || c.barcode || '—')}</div>
        <div class="m">${esc(c.barcode||'')} ${c.location?('｜'+esc(c.location)):''} ${c.note?('｜'+esc(c.note)):''}</div>
      </div>
      <div class="right">
        <div class="q">${fmtQty(c.countedQty)}</div>
        <div><span class="tag ${tag}">${txt}</span></div>
      </div>
    </div>`;
  }).join('') || '<div class="stat">尚未有任何記錄</div>';
}

async function refreshProducts() {
  const all = await DB.all('products');
  $('#productStat').textContent = `共 ${all.length} 項貨品`;
  $('#productList').innerHTML = all.slice(0, 500).map(p => `
    <div class="row">
      <div class="left">
        <div class="n">${esc(p.name || '(無名稱)')}</div>
        <div class="m">條碼 ${esc(p.barcode||'—')} ｜ 編號 ${esc(p.sku||'—')}</div>
      </div>
      <div class="right"><div class="q">${fmtQty(p.expectedQty)||0}</div><div class="m">${esc(p.unit||'')}</div></div>
    </div>
  `).join('') || '<div class="stat">未有貨品，請先匯入 Excel</div>';
}

async function refreshReport() {
  const counts = await DB.byIndex('counts', 'sessionId', state.session.id);
  const products = await DB.all('products');
  const map = new Map();
  const keyOf = o => o.barcode || o.sku || o.name;

  for (const p of products) {
    const k = keyOf(p); if (!k) continue;
    map.set(k, {
      barcode: p.barcode||'', sku: p.sku||'', name: p.name||'', unit: p.unit||'',
      expectedQty: Number(p.expectedQty)||0,
      countedQty: null, location:'', note:'', countedAt:null
    });
  }
  for (const c of counts) {
    const k = keyOf(c); if (!k) continue;
    const row = map.get(k) || {
      barcode:c.barcode||'', sku:c.sku||'', name:c.name||'', unit:c.unit||'',
      expectedQty: Number(c.expectedQty)||0, countedQty:null, location:'', note:'', countedAt:null
    };
    row.countedQty = Number(c.countedQty)||0;
    row.location = c.location||'';
    row.note = c.note||'';
    row.countedAt = c.countedAt;
    map.set(k, row);
  }

  const rows = [...map.values()];
  const done = rows.filter(r => r.countedQty !== null);
  const more = done.filter(r => r.countedQty - r.expectedQty > 0).length;
  const less = done.filter(r => r.countedQty - r.expectedQty < 0).length;
  const ok   = done.filter(r => r.countedQty - r.expectedQty === 0).length;

  $('#reportStat').innerHTML =
    `盤點單：${esc(state.session.name)}<br>` +
    `貨品總數 ${rows.length} ｜ 已盤 ${done.length} ｜ 未盤 ${rows.length - done.length}<br>` +
    `一致 ${ok} ｜ 盤多 ${more} ｜ 盤少 ${less}`;

  $('#reportList').innerHTML = rows.map(r => {
    if (r.countedQty === null) {
      return `<div class="row"><div class="left"><div class="n">${esc(r.name||r.barcode)}</div>
        <div class="m">帳面 ${fmtQty(r.expectedQty)}</div></div>
        <div class="right"><span class="tag none">未盤</span></div></div>`;
    }
    const diff = r.countedQty - r.expectedQty;
    const tag = diff === 0 ? 'ok' : (diff > 0 ? 'more' : 'less');
    const txt = diff === 0 ? '一致' : (diff > 0 ? '+' + fmtQty(diff) : fmtQty(diff));
    return `<div class="row"><div class="left"><div class="n">${esc(r.name||r.barcode)}</div>
      <div class="m">帳面 ${fmtQty(r.expectedQty)} → 實盤 ${fmtQty(r.countedQty)}</div></div>
      <div class="right"><div class="q">${fmtQty(r.countedQty)}</div><div><span class="tag ${tag}">${txt}</span></div></div></div>`;
  }).join('') || '<div class="stat">尚未有任何資料</div>';
}

async function refreshAll() {
  $('#topSub').textContent = state.session ? `${state.session.name}（${state.session.date}）` : '';
  await refreshToday();
  await refreshProducts();
}

/* ================= 匯入 Excel ================= */
async function importExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) { toast('Excel 冇資料'); return; }

  const pick = (row, ...keys) => {
    for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k];
    return '';
  };

  await DB.clear('products');
  let n = 0;
  for (const row of rows) {
    const barcode = String(pick(row,'條碼','条码','barcode','Barcode','BarCode')).trim();
    const sku     = String(pick(row,'編號','编号','sku','SKU','貨號','货号','貨品編號')).trim();
    const name    = String(pick(row,'名稱','名称','name','Name','品名','貨品名稱','商品名稱')).trim();
    const unit    = String(pick(row,'單位','单位','unit','Unit')).trim();
    const expRaw  = pick(row,'帳面數量','账面数量','expected_qty','expectedQty','庫存','库存','數量','数量','qty');
    const expectedQty = Number(String(expRaw).replace(/[^\d.\-]/g,'')) || 0;
    if (!barcode && !sku && !name) continue;
    await DB.put('products', { barcode, sku, name, unit, expectedQty });
    n++;
  }
  toast(`已匯入 ${n} 項貨品`);
  await refreshProducts();
}

/* ================= 匯出 Excel ================= */
async function exportExcel() {
  const counts = await DB.byIndex('counts', 'sessionId', state.session.id);
  const products = await DB.all('products');
  const keyOf = o => o.barcode || o.sku || o.name;
  const map = new Map();

  for (const p of products) {
    const k = keyOf(p); if (!k) continue;
    map.set(k, {
      '條碼': p.barcode, '編號': p.sku, '名稱': p.name, '單位': p.unit,
      '帳面數量': Number(p.expectedQty)||0,
      '實盤數量': '', '差異': '', '狀態': '未盤',
      '位置': '', '備註': '', '盤點時間': ''
    });
  }
  for (const c of counts) {
    const k = keyOf(c); if (!k) continue;
    const row = map.get(k) || {
      '條碼': c.barcode, '編號': c.sku, '名稱': c.name, '單位': c.unit,
      '帳面數量': Number(c.expectedQty)||0,
      '實盤數量': '', '差異': '', '狀態': '', '位置':'', '備註':'', '盤點時間':''
    };
    const counted = Number(c.countedQty)||0;
    const diff = counted - row['帳面數量'];
    row['實盤數量'] = counted;
    row['差異'] = diff;
    row['狀態'] = diff === 0 ? '一致' : (diff > 0 ? '盤多' : '盤少');
    row['位置'] = c.location || '';
    row['備註'] = c.note || '';
    row['盤點時間'] = c.countedAt ? new Date(c.countedAt).toLocaleString('zh-HK') : '';
    map.set(k, row);
  }

  const allRows = [...map.values()];
  const diffRows = allRows.filter(r => r['狀態'] === '盤多' || r['狀態'] === '盤少');

  const ws1 = XLSX.utils.json_to_sheet(allRows);
  const ws2 = XLSX.utils.json_to_sheet(diffRows.length ? diffRows : [{ '提示': '無差異' }]);
  ws1['!cols'] = [{wch:16},{wch:14},{wch:26},{wch:6},{wch:10},{wch:10},{wch:8},{wch:8},{wch:12},{wch:16},{wch:20}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '盤點結果');
  XLSX.utils.book_append_sheet(wb, ws2, '差異');

  const fname = `盤點_${state.session.date}_${state.session.name.replace(/[\\/:*?"<>|]/g,'_')}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast('已匯出 ' + fname);
}

/* ================= 綁定事件 ================= */
function bindEvents() {
  $$('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));

  // 盤點頁
  let searchTimer;
  $('#searchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onSearch(e.target.value), 200);
  });
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); onSearch(e.target.value); }
  });
  $('#btnVoice').onclick = startVoice;
  $('#btnVoiceStop').onclick = stopVoice;

  $$('.qbtn').forEach(b => b.onclick = () => {
    const inp = $('#qtyInput');
    let v = Number(inp.value) || 0;
    v = Math.max(0, v + Number(b.dataset.delta));
    inp.value = Math.round(v * 10) / 10;
  });
  $('#btnCancelEntry').onclick = closeEntry;
  $('#btnSaveEntry').onclick = saveEntry;

  // 貨品頁
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async e => {
    const f = e.target.files[0];
    if (f) await importExcel(f);
    e.target.value = '';
  };
  $('#btnClearProducts').onclick = async () => {
    if (!confirm('確定清空所有貨品？（盤點記錄唔會刪）')) return;
    await DB.clear('products');
    await refreshProducts();
    toast('已清空');
  };
  $('#productSearch').addEventListener('input', async e => {
    const list = await findProducts(e.target.value);
    $('#productList').innerHTML = list.map(p => `
      <div class="row"><div class="left">
        <div class="n">${esc(p.name||'(無名稱)')}</div>
        <div class="m">條碼 ${esc(p.barcode||'—')} ｜ 編號 ${esc(p.sku||'—')}</div>
      </div><div class="right"><div class="q">${fmtQty(p.expectedQty)||0}</div><div class="m">${esc(p.unit||'')}</div></div></div>
    `).join('') || '<div class="stat">無結果</div>';
  });

  // 報表頁
  $('#btnExport').onclick = exportExcel;
  $('#btnNewSession').onclick = newSession;
}

/* ================= 啟動 ================= */
async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn(e); }
  }
  updateNet();
  bindEvents();
  state.session = await getOrCreateSession();
  await refreshAll();
}
init();