const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let fuse = null; // AI 匹配引擎
let catalogData = []; // 存貨品清單
let currentPage = 1; // 當前頁數
const pageSize = 50; // 每頁顯示數量

/* ================= 工具 ================= */
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ================= 視圖切換 ================= */
function showView(id) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'view-voice') loadPending();
  if (id === 'view-catalog') loadCatalog();
  if (id === 'view-report') loadReport();
}

/* ================= 中文數字解析 ================= */
const CN_DIGIT = {'零':0,'一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
function parseCnNumber(str) {
  if (!str) return null;
  str = str.replace(/[點点\.]/g, '.');
  if (!isNaN(parseFloat(str))) return parseFloat(str);
  let num = 0, tmp = 0;
  for (let c of str) {
    if (CN_DIGIT[c] !== undefined) tmp = CN_DIGIT[c];
    else if (c === '十') { if (tmp === 0) tmp = 1; num += tmp * 10; tmp = 0; }
    else if (c === '百') { num += tmp * 100; tmp = 0; }
    else if (c === '千') { num += tmp * 1000; tmp = 0; }
  }
  return num + tmp;
}

/* ================= 1. 錄音與解析 ================= */
let voiceRec = null, voiceText = '';

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('此瀏覽器唔支援語音'); return; }
  if (voiceRec) return;

  voiceText = '';
  voiceRec = new SR();
  voiceRec.lang = 'zh-HK';
  voiceRec.continuous = false;
  voiceRec.interimResults = true;

  $('#voicePanel').style.display = 'block';
  $('#voiceText').textContent = '請講：貨物名 + 數量';
  
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

  voiceRec.onerror = (e) => toast('語音錯誤：' + e.error);
  voiceRec.onend = () => {
    voiceRec = null;
    $('#voicePanel').style.display = 'none';
    if (voiceText.trim()) processVoiceInput(voiceText.trim());
  };

  try { voiceRec.start(); } catch (e) { toast('無法啟動'); }
}

function stopVoice() {
  if (voiceRec) voiceRec.stop();
}

async function processVoiceInput(text) {
  // 1. 提取數量：搵句字最尾嘅數字
  const numMatch = text.match(/(\d+(\.\d+)?|[零一二兩三四五六七八九十百千點]+)\s*$/);
  let qty = null;
  let nameStr = text;
  
  if (numMatch) {
    qty = parseCnNumber(numMatch[1]);
    nameStr = text.replace(numMatch[0], '').trim();
  }

  // 2. AI 匹配：用 Fuse.js 搵最相似嘅貨名
  let match = null;
  if (fuse && nameStr) {
    const results = fuse.search(nameStr);
    if (results.length > 0) {
      match = results[0].item; // 拎最高分嗰個
    }
  }

  // 3. 存入資料庫
  const record = {
    originalText: text,
    extractedName: nameStr,
    extractedQty: qty || 0,
    matchedCode: match ? match.code : '',
    matchedName: match ? match.name : '冇匹配結果',
    confirmed: false,
    timestamp: Date.now()
  };
  
  await DB.put('records', record);
  toast(`已記錄：${nameStr} ${qty !== null ? qty : ''}`);
  loadPending();
}

/* ================= 2. 貨品清單匯入 ================= */
async function importExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }); // 用 array 形式讀取
  
  if (rows.length < 2) { toast('Excel 冇資料'); return; }

  await DB.clear('catalog');
  let count = 0;

  // 假設第一行係標題，由第二行開始讀
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // 假設 A欄(0) 係 CODE，B欄(1) 係名稱
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    
    if (!code && !name) continue;
    // 如果得一欄，當佢係名，Code 留空
    const finalCode = name ? code : '';
    const finalName = name ? name : code;

    await DB.put('catalog', { code: finalCode, name: finalName });
    count++;
  }

  toast(`已成功匯入 ${count} 項貨品`);
  loadCatalog();
}

/* ================= 3. 刷新介面與 AI 匹配輔助 ================= */
async function loadCatalog() {
  catalogData = await DB.all('catalog');
  $('#catalogStat').textContent = `共 ${catalogData.length} 項貨品`;
  
  if (catalogData.length > 0) {
    fuse = new Fuse(catalogData, {
      keys: ['name', 'code'],
      threshold: 0.4, 
      includeScore: true
    });
  } else {
    fuse = null;
  }
  
  currentPage = 1; 
  renderCatalogList(); 
}

// 🔽 呢個係新加嘅函數，專門負責處理搜尋同分頁 🔽
function renderCatalogList() {
  const keyword = $('#catalogSearch') ? $('#catalogSearch').value.toLowerCase().trim() : '';
  let filtered = catalogData;

  if (keyword) {
    filtered = catalogData.filter(item => 
      item.name.toLowerCase().includes(keyword) || 
      (item.code && item.code.toLowerCase().includes(keyword))
    );
  }

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * pageSize;
  const pageData = filtered.slice(startIdx, startIdx + pageSize);

  $('#catalogList').innerHTML = pageData.map(item => `
    <div class="row" style="padding:8px 12px; font-size:14px; display:flex; justify-content:space-between; border-bottom:1px solid #eee;">
      <div class="left">
        <div class="n">${esc(item.name)}</div>
        <div class="m">CODE: <span style="color:#0d6efd;font-weight:bold">${esc(item.code || '無')}</span></div>
      </div>
    </div>
  `).join('') || '<div class="stat">搵唔到符合嘅貨品</div>';

  const paginationEl = $('#catalogPagination');
  if (!paginationEl) return;
  
  if (totalPages > 1) {
    paginationEl.innerHTML = `
      <button id="btnPrevPage" ${currentPage === 1 ? 'disabled' : ''}>上一頁</button>
      <span class="page-info">第 ${currentPage} / ${totalPages} 頁</span>
      <button id="btnNextPage" ${currentPage === totalPages ? 'disabled' : ''}>下一頁</button>
    `;

    $('#btnPrevPage').onclick = () => {
      if (currentPage > 1) {
        currentPage--;
        renderCatalogList();
        $('#catalogList').scrollTop = 0;
      }
    };
    $('#btnNextPage').onclick = () => {
      if (currentPage < totalPages) {
        currentPage++;
        renderCatalogList();
        $('#catalogList').scrollTop = 0;
      }
    };
  } else {
    paginationEl.innerHTML = '';
  }
}
async function loadPending() {
  const records = await DB.all('records');
  records.sort((a,b) => b.timestamp - a.timestamp);
  $('#pendingBadge').textContent = records.length;

  if (records.length === 0) {
    $('#pendingList').innerHTML = '<div class="stat">未有記錄，請撳上面個掣講嘢。</div>';
    return;
  }

  $('#pendingList').innerHTML = records.map(r => {
    // 如果匹配到，提供下拉選單俾佢改
    let selectHtml = '';
    if (fuse) {
      const results = fuse.search(r.extractedName);
      let options = `<option value="">-- 請選擇 (AI 推薦) --</option>`;
      
      // 將 AI 推薦嘅頭 5 個放入選單
      results.slice(0, 5).forEach((res, idx) => {
        const isSelected = res.item.code === r.matchedCode ? 'selected' : '';
        options += `<option value="${esc(res.item.code)}|${esc(res.item.name)}" ${isSelected}>
          ${esc(res.item.name)} (CODE: ${esc(res.item.code)})
        </option>`;
      });
      // 加個全部清單以防萬一
      options += `<option disabled>--- 全部清單 ---</option>`;
      catalogData.slice(0, 50).forEach(item => {
        options += `<option value="${esc(item.code)}|${esc(item.name)}">${esc(item.name)}</option>`;
      });

      selectHtml = `<select class="code-select" data-id="${r.id}">${options}</select>`;
    }

    const borderClass = r.matchedCode ? 'matched' : 'unmatched';

    return `<div class="pending-card ${borderClass}" data-id="${r.id}">
      <div class="row">
        <div>
          <div class="label">你講咗：</div>
          <div class="val">"${esc(r.originalText)}"</div>
        </div>
        <div style="text-align:right">
          <div class="label">提取數量：</div>
          <input type="number" class="qty-input" value="${r.extractedQty}" data-id="${r.id}" style="width:60px; text-align:center; font-size:16px; padding:4px;">
        </div>
      </div>
      <div class="code-box">
        <div class="label">AI 匹配結果：</div>
        ${selectHtml}
        <div style="margin-top:5px; font-size:12px; color:#666;">
          目前 CODE: <span style="font-weight:bold; color:#dc3545">${esc(r.matchedCode || '未匹配')}</span>
        </div>
      </div>
      <div class="pending-actions">
        <button class="btn-delete" onclick="deleteRecord(${r.id})">刪除</button>
        <button class="btn-confirm" onclick="confirmRecord(${r.id})">確認無誤</button>
      </div>
    </div>`;
  }).join('');

  // 綁定下拉選單事件
  $$('.code-select').forEach(sel => {
    sel.onchange = async (e) => {
      const id = Number(sel.dataset.id);
      const val = e.target.value;
      if (!val) return;
      const [code, name] = val.split('|');
      const rec = records.find(x => x.id === id);
      if (rec) {
        rec.matchedCode = code;
        rec.matchedName = name;
        await DB.put('records', rec);
        toast('已更新匹配 Code');
        loadPending();
      }
    };
  });

  // 綁定數量修改事件
  $$('.qty-input').forEach(inp => {
    inp.onchange = async (e) => {
      const id = Number(inp.dataset.id);
      const val = Number(e.target.value);
      const rec = records.find(x => x.id === id);
      if (rec) {
        rec.extractedQty = val;
        await DB.put('records', rec);
      }
    };
  });
}

window.deleteRecord = async (id) => {
  await DB.del('records', id);
  loadPending();
};

window.confirmRecord = async (id) => {
  const records = await DB.all('records');
  const rec = records.find(x => x.id === id);
  if (rec) {
    if (!rec.matchedCode) { toast('請先選擇正確嘅貨品 CODE'); return; }
    rec.confirmed = true;
    await DB.put('records', rec);
    toast('已確認');
    loadPending();
  }
};

/* ================= 4. 導出報表 ================= */
async function loadReport() {
  const records = await DB.all('records');
  const confirmed = records.filter(r => r.confirmed);
  
  $('#reportStat').textContent = `已確認 ${confirmed.length} 項，待確認 ${records.length - confirmed.length} 項`;

  $('#reportList').innerHTML = records.map(r => {
    const status = r.confirmed ? '✅ 已確認' : '⏳ 未確認';
    return `<div class="row">
      <div class="left">
        <div class="n">${esc(r.matchedName)}</div>
        <div class="m">CODE: ${esc(r.matchedCode)} ｜ 數量: ${r.extractedQty}</div>
      </div>
      <div class="right">
        <span class="tag ${r.confirmed ? 'ok' : 'none'}">${status}</span>
      </div>
    </div>`;
  }).join('') || '<div class="stat">未有任何記錄</div>';
}

async function exportExcel() {
  const records = await DB.all('records');
  const confirmed = records.filter(r => r.confirmed);
  
  if (confirmed.length === 0) {
    toast('未有已確認嘅記錄，請先返上一頁確認');
    return;
  }

  // 組合你要嘅格式：CODE 及 數量
  const exportData = confirmed.map(r => ({
    'CODE': r.matchedCode,
    '數量': r.extractedQty,
    '名稱 (參考)': r.matchedName
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  ws['!cols'] = [{wch:20},{wch:10},{wch:30}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '盤點結果');
  
  XLSX.writeFile(wb, `盤點結果_${new Date().toLocaleDateString('zh-HK')}.xlsx`);
  toast('已導出 Excel');
}

/* ================= 啟動與綁定 ================= */
function bindEvents() {
  $$('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));

  // 錄音
  $('#btnBigVoice').onclick = startVoice;
  $('#btnVoiceStop').onclick = stopVoice;

  // 綁定貨品清單搜尋框
  if ($('#catalogSearch')) {
    $('#catalogSearch').addEventListener('input', () => {
      currentPage = 1; // 打字搜尋時跳返第一頁
      renderCatalogList();
    });
  }

  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async e => {
    const f = e.target.files[0];
    if (f) await importExcel(f);
    e.target.value = '';
  };
  $('#btnClearCatalog').onclick = async () => {
    if (!confirm('確定清空貨品清單？')) return;
    await DB.clear('catalog');
    fuse = null;
    loadCatalog();
    toast('已清空');
  };

  // 報表
  $('#btnExport').onclick = exportExcel;
  $('#btnClearAll').onclick = async () => {
    if (!confirm('確定清空所有盤點記錄？（清空後不能復原）')) return;
    await DB.clear('records');
    loadPending();
    loadReport();
    toast('已清空所有記錄');
  };
}

async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) {}
  }
  bindEvents();
  
  // 檢查清單並載入
  const catalog = await DB.all('catalog');
  if (catalog.length > 0) {
    await loadCatalog();
  }
  await loadPending();
}
init();
