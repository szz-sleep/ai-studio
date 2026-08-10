/**
 * AI Studio - 素材库管理模块
 * 素材同步流程：
 *   用户上传 → uguu.se 托管 → MaaS CreateAsset → 火山素材库审核 → MaaS 轮询状态 → 同步回 AI Studio
 * 数据存储：localStorage（存 MaaS 返回的完整素材信息，含审核状态）
 */

const MaterialLib = {
    STORAGE_KEY: 'aistudio_material_library',
    _pendingCallback: null,   // 当前弹窗的 onSelect 回调
    _pendingFilter: 'all',    // 当前筛选类型
    _pollingTimer: null,      // 轮询定时器
    _pollingIds: new Set(),   // 正在轮询的素材 ID 集合

    // ===== MaaS 素材 API 基础 URL =====
    _getMaaSUrl() {
        // 复用当前平台配置的 baseUrl，去掉末尾 /v1 等后缀
        const base = (typeof Config !== 'undefined' ? Config.getBaseUrl() : '') || '';
        const clean = base.replace(/\/+$/, '').replace(/\/v\d+$/, '');
        return clean;
    },

    _getApiKey() {
        return (typeof Config !== 'undefined' ? Config.getApiKey() : '') || '';
    },

    // ===== 本地存储（缓存 MaaS 返回的素材数据）=====

    /**
     * 获取所有素材（从 localStorage 缓存读取）
     * @returns {Array} [{ id, name, url, sourceUrl, type, mimeType, size, status, time }]
     */
    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
    },

    /** 保存到 localStorage */
    _save(list) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
    },

    /**
     * 添加/更新一条素材（本地缓存）
     */
    _upsert(item) {
        const list = this.getAll();
        const idx = list.findIndex(i => i.id === item.id);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...item };
        } else {
            list.unshift(item);
            if (list.length > 200) list.length = 200;
        }
        this._save(list);
        return list;
    },

    /**
     * 删除一条素材（本地缓存）
     */
    remove(id) {
        let list = this.getAll();
        this._pollingIds.delete(id);
        list = list.filter(i => i.id !== id);
        this._save(list);
        return list;
    },

    /** 清空所有素材记录 */
    clear() {
        this._pollingIds.clear();
        this._stopPolling();
        localStorage.removeItem(this.STORAGE_KEY);
    },

    /** 根据类型过滤 */
    getByType(type) {
        if (type === 'all') return this.getAll();
        return this.getAll().filter(i => i.type === type);
    },

    // ===== MaaS API 调用 =====

    /**
     * 调 MaaS 创建素材（同步到火山素材库）
     * @param {object} params - { assetName, assetType, assetUrl }
     * @returns {Promise<object>} { id, status, sourceUrl }
     */
    async _maasCreateAsset({ assetName, assetType, assetUrl }) {
        const baseUrl = this._getMaaSUrl();
        const apiKey = this._getApiKey();
        if (!baseUrl || !apiKey) {
            throw new Error('未配置平台地址或 API Key，无法同步到素材库');
        }

        const resp = await fetch(`${baseUrl}/api/v1/assets/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                assetName,
                assetType,
                assetUrl,
            }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ message: `HTTP ${resp.status}` }));
            throw new Error(err?.error?.message || err?.message || `同步失败 (${resp.status})`);
        }

        const data = await resp.json();
        if (!data?.success || !data?.data) {
            throw new Error(data?.error?.message || '素材同步返回异常');
        }

        return {
            id: data.data.assetId,
            status: data.data.status || 'processing',
            sourceUrl: data.data.sourceUrl || assetUrl,
        };
    },

    /**
     * 调 MaaS 查询素材状态
     * @param {string} assetId
     * @returns {Promise<object>} { status, sourceUrl, errorMsg }
     */
    async _maasGetAsset(assetId) {
        const baseUrl = this._getMaaSUrl();
        const apiKey = this._getApiKey();
        if (!baseUrl || !apiKey) throw new Error('未配置平台');

        const resp = await fetch(`${baseUrl}/api/v1/assets/${assetId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });

        if (!resp.ok) throw new Error(`查询素材状态失败 (${resp.status})`);

        const data = await resp.json();
        if (!data?.success || !data?.data) {
            throw new Error(data?.error?.message || '查询返回异常');
        }

        return {
            status: data.data.status || 'processing',
            sourceUrl: data.data.sourceUrl || '',
            errorMsg: data.data.errorMsg || '',
        };
    },

    /**
     * 调 MaaS 删除素材
     * @param {string} assetId
     */
    async _maasDeleteAsset(assetId) {
        const baseUrl = this._getMaaSUrl();
        const apiKey = this._getApiKey();
        if (!baseUrl || !apiKey) return; // 没配置就跳过

        try {
            await fetch(`${baseUrl}/api/v1/assets/${assetId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
        } catch {
            // 删除失败不阻塞本地操作
        }
    },

    // ===== 轮询审核状态 =====

    /**
     * 启动轮询：检查所有 processing 状态的素材，定时更新
     */
    _startPolling() {
        // 先停止旧的
        this._stopPolling();

        // 检查是否有需要轮询的素材
        const pending = this.getAll().filter(i => i.status === 'processing' || i.status === 'pending');
        pending.forEach(i => this._pollingIds.add(i.id));

        if (this._pollingIds.size === 0) return;

        // 每 10 秒轮询一次
        this._pollingTimer = setInterval(async () => {
            if (this._pollingIds.size === 0) {
                this._stopPolling();
                return;
            }
            const ids = Array.from(this._pollingIds);
            for (const id of ids) {
                try {
                    const result = await this._maasGetAsset(id);
                    this._upsert({ id, status: result.status, sourceUrl: result.sourceUrl });

                    if (result.status === 'active' || result.status === 'failed' || result.status === 'error') {
                        this._pollingIds.delete(id);
                    }

                    // 刷新当前打开的弹窗
                    const modal = document.getElementById('materialLibModal');
                    if (modal && !modal.classList.contains('hidden')) {
                        this._render(modal);
                    }
                } catch {
                    // 单次失败静默跳过
                }
            }
        }, 10000);

        Logger.info(`[素材库] 开始轮询 ${this._pollingIds.size} 个素材状态`);
    },

    _stopPolling() {
        if (this._pollingTimer) {
            clearInterval(this._pollingTimer);
            this._pollingTimer = null;
        }
    },

    // ===== 对外接口 =====

    /**
     * 添加一条素材到本地缓存（轻量级，不触发上传/同步）
     * 用于外部模块在已知 URL 时直接存储
     * @param {object} item - { name, url, type, mimeType, size }
     */
    add(item) {
        const list = this.getAll();
        const existing = list.find(i => i.url === item.url);
        if (existing) {
            existing.time = Date.now();
            existing.name = item.name || existing.name;
        } else {
            list.unshift({
                id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                name: item.name || '未命名',
                url: item.url,
                sourceUrl: item.url,
                type: item.type || 'unknown',
                mimeType: item.mimeType || '',
                size: item.size || 0,
                status: 'active', // 外部已上传完成的素材，直接标记为可用
                time: Date.now()
            });
            if (list.length > 200) list.length = 200;
        }
        this._save(list);
        return list;
    },

    /**
     * 打开素材库弹窗
     * @param {function} onSelect - 选择素材后的回调 (item) => void
     * @param {string} filterType - 可选类型过滤
     */
    openPicker(onSelect, filterType) {
        const modal = document.getElementById('materialLibModal');
        if (!modal) {
            console.error('[素材库] 未找到素材库弹窗元素');
            return;
        }
        this._pendingCallback = onSelect;
        this._pendingFilter = filterType || 'all';
        modal.classList.remove('hidden');
        this._render(modal);
    },

    /**
     * 渲染素材库内容
     */
    _render(modal) {
        const grid = document.getElementById('materialLibGrid');
        if (!grid) return;
        const onSelect = this._pendingCallback;
        const filterType = this._pendingFilter;
        const list = this.getByType(filterType);

        // 更新筛选按钮高亮
        document.querySelectorAll('.material-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filterType);
        });

        // 更新计数
        const countEl = document.getElementById('materialCount');
        if (countEl) {
            const activeCount = list.filter(i => i.status === 'active').length;
            const processingCount = list.filter(i => i.status !== 'active').length;
            let countText = `共 ${list.length} 个素材`;
            if (processingCount > 0) countText += `（${activeCount} 可用，${processingCount} 审核中）`;
            countEl.textContent = countText;
        }

        if (list.length === 0) {
            grid.innerHTML = '<div class="material-empty">暂无素材，上传素材后会自动同步到火山素材库</div>';
            return;
        }

        grid.innerHTML = '';
        list.forEach(item => {
            const div = document.createElement('div');
            div.className = 'material-item';
            div.dataset.id = item.id;

            // 审核中不可点击选择
            const isReady = item.status === 'active';

            // 缩略图/图标
            const thumb = document.createElement('div');
            thumb.className = 'material-thumb';
            if (item.type === 'image') {
                thumb.innerHTML = `<img src="${item.url || item.sourceUrl || ''}" alt="${item.name}" loading="lazy">`;
            } else if (item.type === 'video') {
                thumb.innerHTML = `<video src="${item.url || item.sourceUrl || ''}" preload="metadata"></video><span class="material-type-badge">视频</span>`;
            } else if (item.type === 'audio') {
                thumb.innerHTML = `<div class="material-audio-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><span class="material-type-badge">音频</span>`;
            } else {
                thumb.innerHTML = `<div class="material-audio-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/></svg></div>`;
            }
            div.appendChild(thumb);

            // 审核状态标签
            if (item.status === 'processing' || item.status === 'pending') {
                const badge = document.createElement('span');
                badge.className = 'material-status-badge processing';
                badge.textContent = '审核中';
                badge.style.cssText = 'position:absolute;top:4px;right:4px;font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;pointer-events:none;';
                thumb.style.position = 'relative';
                thumb.appendChild(badge);
            } else if (item.status === 'failed' || item.status === 'error') {
                const badge = document.createElement('span');
                badge.className = 'material-status-badge failed';
                badge.textContent = '审核失败';
                badge.style.cssText = 'position:absolute;top:4px;right:4px;font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(239,68,68,0.15);color:#ef4444;pointer-events:none;';
                thumb.style.position = 'relative';
                thumb.appendChild(badge);
            }

            // 信息
            const info = document.createElement('div');
            info.className = 'material-info';
            const timeStr = new Date(item.time).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
            const sizeStr = item.size > 1024 * 1024
                ? (item.size / 1024 / 1024).toFixed(1) + 'MB'
                : item.size > 1024
                    ? (item.size / 1024).toFixed(1) + 'KB'
                    : item.size + 'B';
            const statusLabel = !isReady ? ` · <span style="color:${item.status==='failed'?'#ef4444':'#f59e0b'}">${item.status==='failed'?'审核失败':'审核中'}</span>` : '';
            info.innerHTML = `
                <div class="material-name" title="${item.name}">${item.name}${statusLabel}</div>
                <div class="material-meta">${timeStr} · ${sizeStr}</div>
            `;
            div.appendChild(info);

            // 选择按钮
            const actions = document.createElement('div');
            actions.className = 'material-actions';
            const selectBtn = document.createElement('button');
            selectBtn.className = 'material-select-btn';
            if (isReady) {
                selectBtn.textContent = '使用';
                selectBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (onSelect) onSelect(item);
                    modal.classList.add('hidden');
                });
                div.addEventListener('click', () => {
                    if (onSelect) onSelect(item);
                    modal.classList.add('hidden');
                });
            } else {
                selectBtn.textContent = '等待审核';
                selectBtn.disabled = true;
                selectBtn.style.opacity = '0.5';
                selectBtn.style.cursor = 'not-allowed';
            }
            actions.appendChild(selectBtn);

            // 删除按钮
            const delBtn = document.createElement('button');
            delBtn.className = 'material-delete-btn';
            delBtn.innerHTML = '×';
            delBtn.title = '删除';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定删除此素材吗？\n（将同步删除火山素材库中的素材）')) {
                    this.remove(item.id);
                    this._maasDeleteAsset(item.id); // 异步删除，不阻塞
                    this._render(modal);
                }
            });
            actions.appendChild(delBtn);
            div.appendChild(actions);

            grid.appendChild(div);
        });
    },

    /**
     * 上传文件：uguu.se 托管 → MaaS 同步火山 → 保存本地
     * @param {File} file - 文件对象
     * @returns {Promise<string>} HTTP URL
     */
    async uploadFile(file) {
        console.log(`[素材库] 正在上传: ${file.name}`);

        // Step 1: 上传到 uguu.se 获取公网 URL
        const formData = new FormData();
        formData.append('files[]', file, file.name);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const resp = await fetch('https://uguu.se/upload', {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
            throw new Error(`上传失败 (${resp.status})`);
        }

        const result = await resp.json();
        if (!result.success || !result.files || !result.files[0]) {
            throw new Error('上传失败: ' + JSON.stringify(result));
        }

        const httpUrl = result.files[0].url;
        console.log(`[素材库] uguu.se 上传成功: ${httpUrl}`);

        // 确定类型
        let type = 'unknown';
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type.startsWith('audio/')) type = 'audio';
        else if (file.type.startsWith('video/')) type = 'video';

        // 生成临时 ID（MaaS 返回真实 assetId 后会更新）
        const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

        // 先存本地（状态 pending）
        const localItem = {
            id: tempId,
            name: file.name,
            url: httpUrl,
            sourceUrl: httpUrl,
            type,
            mimeType: file.type,
            size: file.size,
            status: 'pending',
            time: Date.now()
        };
        this._upsert(localItem);
        console.log(`[素材库] 本地缓存已保存: ${tempId}`);

        // Step 2: 同步到 MaaS → 火山素材库
        try {
            const typeLabel = type === 'image' ? '图片' : type === 'video' ? '视频' : '音频';
            const maasResult = await this._maasCreateAsset({
                assetName: file.name,
                assetType: type,
                assetUrl: httpUrl,
            });

            // 用 MaaS 返回的真实 ID 更新本地记录（保留 tempId 记录的 type/size 等本地字段）
            const list = this.getAll();
            const tempIdx = list.findIndex(i => i.id === tempId);
            if (tempIdx >= 0) {
                // 原地更新：保留本地字段，替换 ID 与状态
                list[tempIdx] = {
                    ...list[tempIdx],
                    id: maasResult.id,
                    status: maasResult.status || 'processing',
                    sourceUrl: maasResult.sourceUrl || httpUrl,
                    url: httpUrl,
                };
                this._save(list);
            } else {
                // 临时记录不存在（如页面刷新过），新建一条，用本地已知的 type
                this._upsert({
                    id: maasResult.id,
                    name: file.name,
                    url: httpUrl,
                    sourceUrl: maasResult.sourceUrl || httpUrl,
                    type,
                    mimeType: file.type,
                    size: file.size,
                    status: maasResult.status || 'processing',
                    time: Date.now(),
                });
            }

            console.log(`[素材库] MaaS 同步成功: ${maasResult.id}, 状态: ${maasResult.status}`);

            // 如果不是 active，启动轮询
            if (maasResult.status !== 'active') {
                this._pollingIds.add(maasResult.id);
                this._startPolling();
            }

        } catch (e) {
            console.warn(`[素材库] MaaS 同步失败（平台不支持或网络错误）: ${e.message}`);
            // 静默降级：ugu.se 已上传成功，本地可用，只是不同步火山
            this._upsert({ id: tempId, status: 'active' });
        }

        return httpUrl;
    },

    /**
     * 初始化素材库弹窗
     */
    init() {
        const modal = document.getElementById('materialLibModal');
        if (!modal) return;

        // 关闭函数
        const closeModal = () => {
            this._pendingCallback = null;
            modal.classList.add('hidden');
        };

        // 关闭按钮
        modal.querySelector('.modal-close')?.addEventListener('click', closeModal);
        // 底部关闭按钮
        const footerCloseBtn = modal.querySelector('.modal-footer .footer-btn:last-child');
        if (footerCloseBtn) footerCloseBtn.addEventListener('click', closeModal);

        // 点击遮罩关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // 筛选按钮
        document.querySelectorAll('.material-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._pendingFilter = btn.dataset.filter;
                this._render(modal);
            });
        });

        // 清空按钮
        document.getElementById('materialClearBtn')?.addEventListener('click', () => {
            if (confirm('确定清空所有素材记录吗？\n（将同步删除火山素材库中的所有素材）')) {
                // 异步删除火山侧素材
                const all = this.getAll();
                all.forEach(item => {
                    if (item.id && !item.id.startsWith('temp_')) {
                        this._maasDeleteAsset(item.id);
                    }
                });
                this.clear();
                this._render(modal);
            }
        });

        // 素材库内上传按钮
        const uploadBtn = document.getElementById('materialUploadBtn');
        if (uploadBtn) {
            // 移除旧的事件绑定（避免重复）
            const newBtn = uploadBtn.cloneNode(true);
            uploadBtn.parentNode.replaceChild(newBtn, uploadBtn);

            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();

                // 确保弹窗打开
                modal.classList.remove('hidden');

                setTimeout(() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*,video/*,audio/*';
                    input.multiple = true;
                    input.style.display = 'none';
                    document.body.appendChild(input);

                    input.onchange = async () => {
                        const files = input.files;
                        if (!files || files.length === 0) {
                            document.body.removeChild(input);
                            return;
                        }

                        modal.classList.remove('hidden');

                        let hasError = false;
                        for (const file of files) {
                            try {
                                if (typeof UI !== 'undefined') UI.toast(`正在上传: ${file.name}`, 'info');
                                await this.uploadFile(file);
                                console.log(`[素材库] 上传完成: ${file.name}`);
                            } catch (e) {
                                console.error(`[素材库] ${file.name} 上传失败: ${e.message}`);
                                if (typeof UI !== 'undefined') UI.toast(`${file.name} ${e.message}`, 'error');
                                hasError = true;
                            }
                        }

                        if (typeof UI !== 'undefined') {
                            UI.toast(hasError ? '部分素材上传失败，请检查平台配置' : '上传完成，素材已同步至火山素材库', 'success');
                        }
                        this._render(modal);
                        modal.classList.remove('hidden');

                        document.body.removeChild(input);
                    };

                    input.click();
                }, 50);
            });
        }

        // 启动时检查是否有未完成的轮询
        const pending = this.getAll().filter(i => i.status === 'processing' || i.status === 'pending');
        if (pending.length > 0) {
            pending.forEach(i => this._pollingIds.add(i.id));
            this._startPolling();
            console.log(`[素材库] 恢复轮询 ${this._pollingIds.size} 个素材`);
        }
    }
};
