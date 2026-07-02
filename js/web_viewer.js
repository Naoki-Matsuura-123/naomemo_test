// Webビューア制御・状態同期・自動検知・一括スキャン

let domainCache = []; // キャッシュ { id: number, domain: string, can_sync: boolean, last_verified_at: string }

// APIからドメイン互換性リストを取得してキャッシュ
async function loadDomainCompatibilityList() {
  try {
    const res = await fetch(`${API_URL}/admin/domains`, {
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'ngrok-skip-browser-warning': 'true'
      }
    });
    if (res.ok) {
      const data = await res.json();
      domainCache = data;
    }
  } catch (e) {
    console.error("Failed to load domain compatibility list", e);
  }
}

// 起動時にドメインリストをロード
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (state.token) {
      loadDomainCompatibilityList();
    }
  }, 1000);
});

// コマンド実行ハンドラー (/web [base_url] [subpath])
function executeWebCommand(args) {
  const paneId = state.activePaneId;
  let url = '';
  
  if (args && args.length > 0) {
    const arg1 = args[0];
    const arg2 = args[1];
    
    if (arg2) {
      if (arg2.startsWith('http://') || arg2.startsWith('https://')) {
        url = arg2;
      } else {
        let base = arg1.replace(/\/$/, '');
        let sub = arg2.replace(/^\//, '');
        url = base + '/' + sub;
      }
    } else if (arg1) {
      url = arg1;
    }
  }
  
  if (url) {
    openWebViewer(url, paneId);
  } else {
    toggleWebViewer(paneId);
  }
}

// Webビューアの表示トグル
function toggleWebViewer(paneId = state.activePaneId) {
  const pel = getPaneEl(paneId);
  const isWebActive = pel.externalWebPane.style.display === 'flex';
  
  if (isWebActive) {
    // Webを閉じてエディタに戻る
    pel.externalWebPane.style.display = 'none';
    syncPreviewUI(paneId);
    pel.webBtn.classList.remove('active');
  } else {
    // エディタ類を隠してWebを開く
    hideEditorInputs(paneId);
    pel.externalWebPane.style.display = 'flex';
    pel.webBtn.classList.add('active');
    
    // アドレスバーの初期URL設定（もしメモ本文にURLが含まれていれば自動セット）
    const content = pel.memoContent ? pel.memoContent.value : '';
    const urlMatch = content.match(/https?:\/\/[^\s\)\#]+/);
    if (urlMatch && !pel.webAddressInput.value) {
      pel.webAddressInput.value = urlMatch[0];
    }
    safeCreateIcons();
  }
}

function hideEditorInputs(paneId) {
  const pel = getPaneEl(paneId);
  pel.memoTitle.style.display = 'none';
  pel.memoContent.style.display = 'none';
  pel.markdownPreview.style.display = 'none';
  if (pel.emptyState) pel.emptyState.style.display = 'none';
  
  const banner = pel.memoTitle.parentNode.querySelector('.readonly-banner');
  if (banner) banner.style.display = 'none';
}

// WebビューアにURLをロード
function openWebViewer(url, paneId = state.activePaneId) {
  const pel = getPaneEl(paneId);
  const paneState = state.panes[paneId];
  const webTabId = `web-${url}`;
  
  if (!paneState.openMemoIds.includes(webTabId)) {
    paneState.openMemoIds.push(webTabId);
  }
  paneState.activeMemoId = webTabId;
  if (paneId === state.activePaneId) {
    state.activeMemoId = webTabId;
  }
  
  if (pel.externalWebPane.style.display !== 'flex') {
    hideEditorInputs(paneId);
    pel.externalWebPane.style.display = 'flex';
    pel.webBtn.classList.add('active');
  }
  
  pel.webAddressInput.value = url;
  
  const iframeId = `${paneId}-webIframe`;
  const existingIframe = document.getElementById(iframeId);
  const proxyUrl = `${API_URL}/proxy-html?url=${encodeURIComponent(url)}`;
  
  if (!existingIframe || existingIframe.src !== proxyUrl) {
    pel.webIframeContainer.innerHTML = `<iframe id="${iframeId}" src="${proxyUrl}" allow="clipboard-read; clipboard-write"></iframe>`;
  }
  
  renderPaneTabs(paneId);
}

// 指定ドメインの同期可否ステータスを取得（null = 未知）
function getDomainCompatibility(domain) {
  const item = domainCache.find(d => d.domain.toLowerCase() === domain.toLowerCase());
  return item ? item.can_sync : null;
}

// クラウドDBにドメイン結果を登録・更新
async function saveDomainCompatibility(domain, canSync) {
  try {
    const res = await fetch(`${API_URL}/admin/domains`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({
        domain: domain,
        can_sync: canSync
      })
    });
    if (res.ok) {
      const updatedItem = await res.json();
      // キャッシュ更新
      const idx = domainCache.findIndex(d => d.domain.toLowerCase() === domain.toLowerCase());
      if (idx !== -1) {
        domainCache[idx] = updatedItem;
      } else {
        domainCache.push(updatedItem);
      }
      if (typeof renderAdminDomains === 'function') {
        renderAdminDomains();
      }
    }
  } catch (e) {
    console.error("Failed to save domain compatibility", e);
  }
}

// 左右ペイン間での表示移動と状態同期（postMessage）
function transferWebViewer(fromPaneId) {
  const toPaneId = fromPaneId === 'left' ? 'right' : 'left';
  
  if (!state.isSplitView) {
    // 分割解除状態なら自動で分割を有効化
    el.splitViewBtn.click();
  }
  
  const fromPel = getPaneEl(fromPaneId);
  const fromIframe = document.getElementById(`${fromPaneId}-webIframe`);
  const url = fromPel.webAddressInput.value;
  
  if (!url || !fromIframe) {
    showToast("移動元のWebサイトURLがありません", "shield-alert");
    return;
  }
  
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch (e) {
    showToast("無効なURL形式です", "shield-alert");
    return;
  }
  
  const compatibility = getDomainCompatibility(domain);
  
  if (compatibility === false) {
    // 同期不可ドメインの場合：
    // 同期をスキップし、移動先に同じURLをロード、移動元もそのまま残す（2画面同時展開）
    showToast("同期不可ドメインのため、同期なしで両画面展開します", "globe");
    openWebViewer(url, toPaneId);
    return;
  }
  
  showToast(compatibility === null ? "未知のドメイン：同期互換性を自動検知中..." : "状態同期を実行中...", "refresh-cw");
  
  let stateReceived = false;
  let stateData = null;
  let timeoutId = null;
  
  const messageHandler = function(event) {
    const data = event.data;
    if (data && data.type === 'STATE_RESPONSE') {
      stateReceived = true;
      stateData = data.state;
      window.removeEventListener('message', messageHandler);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      proceedToLoadAndRestore(url, toPaneId, stateData, fromPaneId, domain, compatibility === null);
    }
  };
  
  window.addEventListener('message', messageHandler);
  
  // 状態要求を送信
  fromIframe.contentWindow.postMessage({ type: 'REQUEST_STATE' }, '*');
  
  // 2秒の応答タイムアウト
  timeoutId = setTimeout(() => {
    if (!stateReceived) {
      window.removeEventListener('message', messageHandler);
      showToast("同期応答タイムアウト。同期なしで両画面展開します", "shield-alert");
      
      openWebViewer(url, toPaneId);
      
      if (compatibility === null) {
        saveDomainCompatibility(domain, false);
      }
    }
  }, 2000);
}

function proceedToLoadAndRestore(url, toPaneId, stateData, fromPaneId, domain, isUnknown) {
  openWebViewer(url, toPaneId);
  
  const toIframe = document.getElementById(`${toPaneId}-webIframe`);
  if (!toIframe) return;
  
  let restoreCompleted = false;
  let timeoutId = null;
  
  const restoreHandler = function(event) {
    const data = event.data;
    if (data && data.type === 'RESTORE_COMPLETE') {
      restoreCompleted = true;
      window.removeEventListener('message', restoreHandler);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      showToast("状態同期が完了しました！", "check");
      
      // 復元成功：移動元の iframe をクリアしてエディタに戻る
      const fromPel = getPaneEl(fromPaneId);
      fromPel.webIframeContainer.innerHTML = '';
      toggleWebViewer(fromPaneId);
      
      if (isUnknown) {
        saveDomainCompatibility(domain, true);
      }
    }
  };
  
  window.addEventListener('message', restoreHandler);
  
  toIframe.onload = () => {
    setTimeout(() => {
      if (toIframe.contentWindow) {
        toIframe.contentWindow.postMessage({
          type: 'RESTORE_STATE',
          state: stateData
        }, '*');
      }
    }, 200);
  };
  
  // 3秒の Ack 復元タイムアウト
  timeoutId = setTimeout(() => {
    if (!restoreCompleted) {
      window.removeEventListener('message', restoreHandler);
      showToast("復元完了応答タイムアウト。移動元も残します", "shield-alert");
      
      if (isUnknown) {
        saveDomainCompatibility(domain, false);
      }
    }
  }, 3000);
}

// プレビュー内のURLクリックをフックしてWebビューアで開く処理
function setupMarkdownPreviewLinkHook(previewEl, paneId) {
  previewEl.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    
    const href = anchor.getAttribute('href');
    if (!href) return;
    
    if (href.includes('youtube.com') || href.includes('youtu.be') || href.startsWith('memo://')) {
      return;
    }
    
    if (href.startsWith('http://') || href.startsWith('https://')) {
      e.preventDefault();
      
      // 分割表示中の場合、クリックされたペインの反対側で開く（ブックマーク連動）
      let targetPaneId = paneId;
      if (state.isSplitView) {
        targetPaneId = paneId === 'left' ? 'right' : 'left';
      }
      
      openWebViewer(href, targetPaneId);
    }
  });
}

// アドレスバーやトグルボタンのイベントリスナー設定
function initWebViewer() {
  ['left', 'right'].forEach(paneId => {
    const pel = getPaneEl(paneId);
    if (!pel.webBtn) return;
    
    // トグルボタン
    pel.webBtn.addEventListener('click', () => {
      toggleWebViewer(paneId);
    });
    
    // アドレスバー移動ボタン
    pel.webGoBtn.addEventListener('click', () => {
      const url = pel.webAddressInput.value.trim();
      if (url) {
        let fullUrl = url;
        if (!/^https?:\/\//i.test(url)) {
          fullUrl = 'https://' + url;
        }
        openWebViewer(fullUrl, paneId);
      }
    });
    
    // 追加ボタン
    const addBtn = document.getElementById(`${paneId}-webAddMemoBtn`);
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        addCurrentUrlToMemo(paneId);
      });
    }
    
    pel.webAddressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        pel.webGoBtn.click();
      }
    });
    
    // 反対ペイン移動ボタン
    pel.webTransferBtn.addEventListener('click', () => {
      transferWebViewer(paneId);
    });
    
    // リンククリックフックの適用
    setupMarkdownPreviewLinkHook(pel.markdownPreview, paneId);
  });
}

// ドキュメントロード完了状態に応じたバインド実行
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(initWebViewer, 200);
  });
} else {
  setTimeout(initWebViewer, 200);
}

function addCurrentUrlToMemo(paneId = state.activePaneId) {
  const pel = getPaneEl(paneId);
  const paneState = state.panes[paneId];
  const url = pel.webAddressInput.value.trim();
  if (!url) {
    showToast("追加するURLがありません", "shield-alert");
    return;
  }

  // 1. 現在開いているメモが通常のメモで、かつ書き込み権限があるかチェック
  const activeMemoId = paneState.activeMemoId;
  const isWebMemo = typeof activeMemoId === 'string' && activeMemoId.startsWith('web-');
  const memo = (!isWebMemo && activeMemoId) ? state.memos.find(m => m.id === activeMemoId) : null;

  if (memo && memo.permission !== 'read') {
    // 追記する
    const currentContent = pel.memoContent.value;
    const separator = currentContent ? '\n\n' : '';
    const newContent = currentContent + separator + `[参考リンク](${url})`;
    pel.memoContent.value = newContent;
    
    // キャッシュ更新と保存トリガー
    memo.content = newContent;
    memo.updated_at = new Date().toISOString();
    saveCache();
    
    // 自動保存を即時トリガー
    if (typeof triggerAutosave === 'function') {
      triggerAutosave(paneId);
    }
    
    // ビューアからエディタに戻る
    toggleWebViewer(paneId);
    selectMemo(memo.id, paneId);
    showToast("メモの末尾にURLを追記しました！", "check");
  } else {
    // 新規メモ作成
    const tempId = 'offline_' + Date.now();
    const nowStr = new Date().toISOString();
    const preFolderId = (state.activeFolderId !== 'all' && state.activeFolderId !== 'uncategorized') ? state.activeFolderId : null;

    const shareModeToggle = document.getElementById('defaultShareModeToggle');
    const shareMode = (shareModeToggle && shareModeToggle.checked) ? 'whitelist' : 'blacklist';

    let domain = '新規Webメモ';
    try {
      domain = new URL(url).hostname;
    } catch(e) {
      domain = url;
    }

    const newMemo = {
      id: tempId,
      title: domain,
      content: `[参考リンク](${url})`,
      folder_id: preFolderId,
      tags: [],
      share_mode: shareMode,
      created_at: nowStr,
      updated_at: nowStr,
      permission: 'owner'
    };

    state.memos.unshift(newMemo);
    saveCache();
    renderList();
    
    // ビューアを閉じてエディタに戻る
    toggleWebViewer(paneId);
    selectMemo(tempId, paneId);

    // 新規作成時は編集可能にする
    paneState.isEditModeExplicit = true;
    paneState.isPreviewActive = false;
    if (typeof syncPreviewUI === 'function') {
      syncPreviewUI(paneId);
    }

    // 同期キュー登録
    if (typeof addQueue === 'function') {
      addQueue('CREATE', tempId, newMemo.title, newMemo.content, preFolderId, [], shareMode);
    }

    if (state.isOnline && typeof processSyncQueue === 'function') {
      processSyncQueue();
    } else {
      if (typeof updateStatusUI === 'function') {
        updateStatusUI('offline');
      }
    }
    showToast("URLから新規メモを作成しました！", "check");
  }
}
window.addCurrentUrlToMemo = addCurrentUrlToMemo;

// iframeからのメッセージ監視（リンクホバーおよびURL同期）
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  
  // 左右どちらのiframeからかを特定
  let paneId = null;
  ['left', 'right'].forEach(pid => {
    const iframe = document.getElementById(`${pid}-webIframe`);
    if (iframe && iframe.contentWindow === event.source) {
      paneId = pid;
    }
  });
  
  if (!paneId) return;
  
  if (data.type === 'LINK_HOVER') {
    // 受信した URL を state.panes[paneId].hoveredUrl に格納
    if (!state.panes[paneId]) {
      state.panes[paneId] = {};
    }
    state.panes[paneId].hoveredUrl = data.url;
    
    // 対応するステータスバーのテキストを更新し表示
    const statusEl = document.getElementById(`${paneId}-webHoverStatus`);
    if (statusEl) {
      if (data.url) {
        statusEl.textContent = data.url;
        statusEl.style.display = 'block';
      } else {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
      }
    }
  } else if (data.type === 'URL_CHANGED') {
    const newUrl = data.url;
    const pel = getPaneEl(paneId);
    const oldUrl = pel.webAddressInput.value;
    
    // アドレス入力欄を更新
    pel.webAddressInput.value = newUrl;
    
    const paneState = state.panes[paneId];
    if (paneState) {
      const oldTabId = `web-${oldUrl}`;
      const newTabId = `web-${newUrl}`;
      
      // openMemoIds 内の oldTabId を newTabId に置換
      const idx = paneState.openMemoIds.indexOf(oldTabId);
      if (idx !== -1) {
        paneState.openMemoIds[idx] = newTabId;
      } else if (!paneState.openMemoIds.includes(newTabId)) {
        paneState.openMemoIds.push(newTabId);
      }
      
      // activeMemoId の更新
      if (paneState.activeMemoId === oldTabId) {
        paneState.activeMemoId = newTabId;
      }
      if (paneId === state.activePaneId && state.activeMemoId === oldTabId) {
        state.activeMemoId = newTabId;
      }
      
      // タブの描画を更新
      if (typeof renderPaneTabs === 'function') {
        renderPaneTabs(paneId);
      }
    }
  }
});

