/**
 * AI Studio - 素材库管理模块
 * 记录上传到临时托管（uguu.se）的素材文件，支持查看、删除、选择使用
 */

const MaterialLib = {
    STORAGE_KEY: 'aistud…rary',
    _pendingCallback: null,  // 当前弹窗的 onSelect 回调
    _pendingFilter: 'all',    // 当前筛选类型

    /**
     * 获取所有素材
     * @returns {Array} [{ id, name, url, type, mimeType, size, time }]
     */
    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
    },

    /**
     * 添加一条素材记录
     * @param {object} item - { name, url, type, mimeType, size }
     */
    add(item) {
        const list = this.getAll();
        // 去重：如果相同 URL 已存在，更新一下时间
        const existing = list.find(i => i.url === item.url);
        if (existing) {
            existing.time = Date.now();
            existing.name = item.name || existing.name;
        } else {
            list.unshift({
                id: 'mat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                name: item.name || '未命名',
                url: item.url,
                type: item.type || 'unknown', // 'image' | 'video' | 'audio'
                mimeType: item.mimeType || '',
                size: item.size || 0,
                time: Date.now()
            });
            // 最多保留 200 条
            if (list.length > 200) list.length = 200;
        }
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
        return list;
    },

    /**
     * 删除一条素材记录
     * @param {string} id
     */
    remove(id) {
        let list = this.getAll();
        list = list.filter(i => i.id !== id);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
        return list;
    },

    /**
     * 清空所有素材记录
     */
    clear() {
        localStorage.removeItem(this.STORAGE_KEY);
    },

    /**
     * 根据类型过滤
     * @param {string} type - 'image' | 'video' | 'audio' | 'all'
     */
    getByType(type) {
        if (type === 'all') return this.getAll();
        return this.getAll().filter(i => i.type === type);
    },

    /**
     * 打开素材库弹窗
     * @param {function} onSelect - 选择素材后的回调 (item) => void
     * @param {string} filterType - 可选类型过滤
     */
    openPicker(onSelect, filterType) {
        const modal = document.getElementById('materialLibModal');
        if (!modal) {
            Logger.error('[素材库] 未找到素材库弹窗元素');
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
        if (countEl) countEl.textContent = `共 ${list.length} 个素材`;

        if (list.length === 0) {
            grid.innerHTML = '<div class="material-empty">暂无素材，上传素材后会自动记录到这里</div>';
            return;
        }

        grid.innerHTML = '';
        list.forEach(item => {
            const div = document.createElement('div');
            div.className = 'material-item';
            div.dataset.id = item.id;

            // 缩略图/图标
            const thumb = document.createElement('div');
            thumb.className = 'material-thumb';
            if (item.type === 'image') {
                thumb.innerHTML = `<img src="${item.url}" alt="${item.name}" loading="lazy">`;
            } else if (item.type === 'video') {
                thumb.innerHTML = `<video src="${item.url}" preload="metadata"></video><span class="material-type-badge">视频</span>`;
            } else if (item.type === 'audio') {
                thumb.innerHTML = `<div class="material-audio-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><span class="material-type-badge">音频</span>`;
            } else {
                thumb.innerHTML = `<div class="material-audio-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/></svg></div>`;
            }
            div.appendChild(thumb);

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
            info.innerHTML = `
                <div class="material-name" title="${item.name}">${item.name}</div>
                <div class="material-meta">${timeStr} · ${sizeStr}</div>
            `;
            div.appendChild(info);

            // 选择按钮
            const actions = document.createElement('div');
            actions.className = 'material-actions';
            const selectBtn = document.createElement('button');
            selectBtn.className = 'material-select-btn';
            selectBtn.textContent = '使用';
            selectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (onSelect) onSelect(item);
                modal.classList.add('hidden');
            });
            actions.appendChild(selectBtn);

            // 删除按钮
            const delBtn = document.createElement('button');
            delBtn.className = 'material-delete-btn';
            delBtn.innerHTML = '×';
            delBtn.title = '删除';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定删除此素材记录吗？')) {
                    this.remove(item.id);
                    this._render(modal);
                }
            });
            actions.appendChild(delBtn);
            div.appendChild(actions);

            // 点击整行也触发选择
            div.addEventListener('click', () => {
                if (onSelect) onSelect(item);
                modal.classList.add('hidden');
            });

            grid.appendChild(div);
        });
    },

    /**
     * 上传文件到 uguu.se 并保存到素材库
     * @param {File} file - 文件对象
     * @returns {Promise<string>} HTTP URL
     */
    async uploadFile(file) {
        Logger.info(`[素材库] 正在上传: ${file.name}`);

        // 构造 FormData
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
        Logger.info(`[素材库] 上传成功: ${httpUrl}`);

        // 确定类型
        let type = 'unknown';
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type.startsWith('audio/')) type = 'audio';
        else if (file.type.startsWith('video/')) type = 'video';

        // 保存到素材库
        this.add({
            name: file.name,
            url: httpUrl,
            type: type,
            mimeType: file.type,
            size: file.size
        });

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
            if (this._uploading) return;
            modal.classList.add('hidden');
        };

        // 关闭按钮
        modal.querySelector('.modal-close')?.addEventListener('click', closeModal);
        // 底部关闭按钮
        modal.querySelector('.footer-btn')?.addEventListener('click', closeModal);

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
            if (confirm('确定清空所有素材记录吗？\n（仅清空本地记录，不会删除已上传的文件）')) {
                this.clear();
                this._render(modal);
            }
        });

        // 素材库内上传按钮
        document.getElementById('materialUploadBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();

            // 先强制确保弹窗打开
            modal.classList.remove('hidden');

            // 延迟一下再打开文件选择器，确保弹窗渲染稳定
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

                    this._uploading = true;

                    // 确保弹窗开着
                    modal.classList.remove('hidden');

                    for (const file of files) {
                        try {
                            UI.toast(`正在上传: ${file.name}`, 'info');
                            await this.uploadFile(file);
                            Logger.info(`[素材库] 上传完成: ${file.name}`);
                        } catch (e) {
                            Logger.error(`[素材库] ${file.name} 上传失败: ${e.message}`);
                            UI.toast(`${file.name} 上传失败`, 'error');
                        }
                    }

                    this._uploading = false;

                    UI.toast('上传完成', 'success');
                    this._render(modal);

                    // 再次确保弹窗开着
                    modal.classList.remove('hidden');

                    // 清理 input
                    document.body.removeChild(input);
                };

                input.click();
            }, 50);
        });
    }
};