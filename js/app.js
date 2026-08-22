/**
 * AI Studio - 主应用入口
 */

/**
 * ===== 日志模块 =====
 * 在界面右下角显示运行日志，同时输出到浏览器控制台
 */
const Logger = {
    _el: null,
    _body: null,
    _init() {
        this._el = document.getElementById('logPanel');
        this._body = document.getElementById('logBody');
    },
    /** 界面日志上限：普通日志最多保留这么多条 */
    _MAX_VISIBLE: 10,
    _log(level, msg) {
        if (!this._body) this._init();
        const t = new Date();
        const time = t.toLocaleTimeString('zh-CN', { hour12: false });

        // 控制台完整输出（生产排查靠这里，不受界面 10 条限制）
        const prefix = `[${time}]`;
        switch (level) {
            case 'error': console.error(prefix, msg); break;
            case 'warn':  console.warn(prefix, msg); break;
            case 'success': console.log(`%c${prefix} [OK]`, 'color:#4ade80', msg); break;
            case 'req':   console.log(`%c${prefix} [➡]`, 'color:#a78bfa', msg); break;
            default:      console.log(prefix, msg);
        }

        // 界面日志
        if (!this._body) return;
        const empty = this._body.querySelector('.log-empty');
        if (empty) empty.remove();

        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        const labelMap = { info: 'INFO', warn: 'WARN', error: 'ERROR', success: 'OK', req: '➡' };
        entry.innerHTML = `<span class="log-time">${time}</span><span class="log-level">${labelMap[level] || level}</span><span class="log-msg">${this._escape(msg)}</span>`;
        this._body.appendChild(entry);
        // 普通日志限 10 条；错误日志完整保留（错误最重要，不能因滚动被清掉）
        if (level !== 'error' && level !== 'warn') {
            while (this._body.children.length > this._MAX_VISIBLE) {
                this._body.removeChild(this._body.firstChild);
            }
        } else {
            // 错误/警告也控制上限，避免无限累积，但给更大空间（100 条）
            while (this._body.children.length > 100) {
                this._body.removeChild(this._body.firstChild);
            }
        }
        this._body.scrollTop = this._body.scrollHeight;
    },
    /** 导出全部界面日志文本（排查用） */
    exportText() {
        if (!this._body) this._init();
        if (!this._body) return '';
        return Array.from(this._body.querySelectorAll('.log-entry')).map(el => el.textContent).join('\n');
    },
    _escape(s) {
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    },
    info(msg)  { this._log('info', msg); },
    warn(msg)  { this._log('warn', msg); },
    error(msg) { this._log('error', msg); },
    success(msg) { this._log('success', msg); },
    req(msg)   { this._log('req', msg); },
    clear() {
        if (!this._body) this._init();
        this._body.innerHTML = '<div class="log-empty">暂无日志</div>';
    }
};

const UI = {
    /**
     * 显示 Toast 提示
     */
    toast(msg, type = '', duration = 3500) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.className = 'toast ' + type;
        el.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            el.classList.add('hidden');
        }, duration);
    },

    /**
     * 显示加载遮罩
     */
    showLoading(text = '加载中...') {
        const el = document.getElementById('loadingOverlay');
        document.getElementById('loadingText').textContent = text;
        el.classList.remove('hidden');
    },

    /**
     * 更新加载进度
     */
    updateLoading(text, pct) {
        const textEl = document.getElementById('loadingText');
        textEl.textContent = text;

        // 更新或创建进度条
        let bar = document.querySelector('.loading-content .progress-bar');
        if (!bar && pct !== undefined) {
            bar = document.createElement('div');
            bar.className = 'progress-bar';
            const fill = document.createElement('div');
            fill.className = 'progress-fill';
            bar.appendChild(fill);
            document.querySelector('.loading-content').appendChild(bar);
        }
        if (bar && pct !== undefined) {
            bar.querySelector('.progress-fill').style.width = pct + '%';
        }
    },

    /**
     * 隐藏加载遮罩
     */
    hideLoading() {
        document.getElementById('loadingOverlay').classList.add('hidden');
        // 移除进度条
        const bar = document.querySelector('.loading-content .progress-bar');
        if (bar) bar.remove();
        this.hideCancelBtn();
    },

    /**
     * 当前预览的 URL（供下载按钮使用）
     */
    _previewUrl: '',
    _previewFilename: '',

    /**
     * 预览图片（灯箱）
     */
    previewImage(url, filename) {
        const overlay = document.getElementById('previewOverlay');
        const img = document.getElementById('previewImage');
        const video = document.getElementById('previewVideo');
        const info = document.getElementById('previewInfo');
        const dotMenu = document.getElementById('previewDotMenu');
        img.classList.remove('hidden');
        video.classList.add('hidden');
        video.pause();
        img.src = url;
        info.textContent = '';
        this._previewUrl = url;
        // 从 URL 提取干净的文件名（去掉 query string）
        let cleanName = url.split('/').pop() || 'image';
        cleanName = cleanName.split('?')[0];
        // 如果没有扩展名，默认补 .png
        if (!cleanName.includes('.')) cleanName += '.png';
        this._previewFilename = filename || cleanName;
        dotMenu.classList.remove('hidden');
        overlay.classList.remove('hidden');
    },

    /**
     * 预览视频（灯箱）
     */
    previewVideo(url, filename) {
        const overlay = document.getElementById('previewOverlay');
        const img = document.getElementById('previewImage');
        const video = document.getElementById('previewVideo');
        const info = document.getElementById('previewInfo');
        const dotMenu = document.getElementById('previewDotMenu');
        img.classList.add('hidden');
        video.classList.remove('hidden');
        video.src = url;
        video.loop = false;
        info.textContent = '';
        this._previewUrl = url;
        let cleanName = url.split('/').pop() || 'video';
        cleanName = cleanName.split('?')[0];
        if (!cleanName.includes('.')) cleanName += '.mp4';
        this._previewFilename = filename || cleanName;
        dotMenu.classList.add('hidden'); // 视频不显示单独下载按钮（三点菜单里已有）
        overlay.classList.remove('hidden');
    },

    /**
     * 从灯箱下载当前预览的文件
     */
    async downloadPreview() {
        await this.downloadFile(this._previewUrl, this._previewFilename);
    },

    /**
     * 关闭预览灯箱
     */
    closePreview() {
        const overlay = document.getElementById('previewOverlay');
        const img = document.getElementById('previewImage');
        const video = document.getElementById('previewVideo');
        const dotMenu = document.getElementById('previewDotMenu');
        overlay.classList.add('hidden');
        img.src = '';
        video.pause();
        video.src = '';
        this._previewUrl = '';
        this._previewFilename = '';
        dotMenu.classList.add('hidden');
    },

    /**
     * 可靠下载文件（fetch → blob → download）
     */
    async downloadFile(url, filename) {
        try {
            const resp = await fetch(url, { mode: 'cors' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename || url.split('/').pop() || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
            UI.toast('已下载', 'success');
        } catch (err) {
            // fallback: 用 a 标签 download 属性（部分跨域可能仍然打开）
            Logger.warn(`[UI] fetch 下载失败 (${err.message})，尝试直接下载`);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || url.split('/').pop() || 'download';
            a.target = '_self';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    },

    /**
     * 显示取消按钮
     */
    showCancelBtn(onCancel) {
        const btn = document.getElementById('cancelBtn');
        btn.classList.remove('hidden');
        btn.onclick = onCancel;
    },

    /**
     * 隐藏取消按钮
     */
    hideCancelBtn() {
        const btn = document.getElementById('cancelBtn');
        btn.classList.add('hidden');
        btn.onclick = null;
    },

    /** 当前打开的确认弹窗 resolve（防止连续调用时旧 Promise 悬挂） */
    _confirmResolve: null,

    /**
     * 通用确认弹窗（异步，返回 Promise<boolean>）
     * 替代原生 confirm()，界面风格统一且不阻塞
     * @param {string} message - 提示文案（支持 \n 换行）
     * @param {object} [opts] - { okText, cancelText, danger }
     * @returns {Promise<boolean>} true=用户点击确定，false=取消
     */
    confirm(message, opts = {}) {
        // 若已有弹窗打开，先关闭旧的（resolve false），避免 Promise 悬挂/事件覆盖
        if (this._confirmResolve) {
            this._confirmResolve(false);
            this._confirmResolve = null;
            const oldModal = document.getElementById('confirmModal');
            if (oldModal) oldModal.classList.add('hidden');
        }
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const textEl = document.getElementById('confirmText');
            const okBtn = document.getElementById('confirmOkBtn');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            if (!modal || !textEl || !okBtn || !cancelBtn) {
                // 弹窗元素缺失时回退到原生 confirm，保证功能可用
                resolve(window.confirm(message));
                return;
            }

            this._confirmResolve = resolve;
            textEl.textContent = message || '确定要继续吗？';
            okBtn.textContent = opts.okText || '确定';
            cancelBtn.textContent = opts.cancelText || '取消';
            // 危险操作：确定按钮用红色；常规操作：用 .btn-primary 默认 accent 色
            if (opts.danger) {
                okBtn.style.background = 'var(--red)';
                okBtn.style.borderColor = 'var(--red)';
                okBtn.style.color = '#fff';
            } else {
                okBtn.style.background = '';
                okBtn.style.borderColor = '';
                okBtn.style.color = '';
            }

            const done = (val) => {
                this._confirmResolve = null;
                modal.classList.add('hidden');
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(val);
            };

            okBtn.onclick = () => done(true);
            cancelBtn.onclick = () => done(false);
            // 点击遮罩 = 取消
            modal.onclick = (e) => { if (e.target === modal) done(false); };

            modal.classList.remove('hidden');
        });
    }
};

const App = {
    /**
     * 启动应用
     */
    async init() {
        try {
        // 初始化 Key 状态
        Config.updateKeyStatus();

        // 首次使用不弹引导，用户在设置里配置 Key 即可
        // 如果没有 Key，在顶部状态栏提示用户去设置

        // 绑定设置按钮
        document.getElementById('settingsBtn').addEventListener('click', () => {
            App.renderPlatformSelect();
            App.renderCustomPlatforms();
            const platform = Config.getPlatform();
            document.getElementById('platformSelect').value = platform;
            App.onPlatformChange();
            const curMB = Config.getUploadSizeMB();
            document.getElementById('uploadSizeInput').value = curMB;
            document.getElementById('uploadSizeDisplay').textContent = curMB;
            document.getElementById('settingsModal').classList.remove('hidden');
        });

        // 上传大小输入实时更新提示
        const uploadSizeInput = document.getElementById('uploadSizeInput');
        if (uploadSizeInput) {
            uploadSizeInput.addEventListener('input', () => {
                const val = parseInt(document.getElementById('uploadSizeInput').value, 10);
                const display = document.getElementById('uploadSizeDisplay');
                if (!isNaN(val) && val >= 5 && val <= 500) {
                    display.textContent = val;
                    display.style.color = 'var(--green)';
                } else {
                    display.textContent = val || '?';
                    display.style.color = 'var(--red)';
                }
            });
        }

        // 清除当前平台 Key
        document.getElementById('clearApiKeyBtn').addEventListener('click', async () => {
            if (!(await UI.confirm('确定要清除当前平台的 API Key 吗？'))) return;
            Config.clearApiKey();
            Config.updateKeyStatus();
            document.getElementById('apiKeyInput').value = '';
            UI.toast('当前平台 Key 已清除', 'info');
        });

        // 恢复默认设置
        document.getElementById('resetDefaultsBtn').addEventListener('click', async () => {
            if (!(await UI.confirm('确定要恢复所有设置到默认值吗？\n这会清除：所有平台的 API Key、上传大小限制。\n\n历史记录不受影响。'))) return;
            Config.resetToDefaults();
            document.getElementById('platformSelect').value = Config.DEFAULT_PLATFORM;
            document.getElementById('apiKeyInput').value = '';
            document.getElementById('apiBaseUrlDisplay').value = Config.getBaseUrl();
            document.getElementById('uploadSizeInput').value = Config.DEFAULT_UPLOAD_SIZE_MB;
            document.getElementById('uploadSizeDisplay').textContent = Config.DEFAULT_UPLOAD_SIZE_MB;
            Config.updateKeyStatus();
            UI.toast('已恢复默认设置', 'success');
            setTimeout(() => window.App.loadModels(), 500);
        });

        // 添加自定义平台保存
        document.getElementById('saveNewPlatformBtn').addEventListener('click', () => {
            App.addCustomPlatform();
        });

        // 编辑自定义平台保存
        document.getElementById('saveEditPlatformBtn').addEventListener('click', () => {
            App.saveEditPlatform();
        });

        // 保存设置
        document.getElementById('saveSettingsBtn').addEventListener('click', () => {
            const platform = document.getElementById('platformSelect').value;
            Config.setPlatform(platform);
            // 保存当前平台的 URL 和 Key
            const baseUrlVal = document.getElementById('apiBaseUrlDisplay').value.trim();
            if (baseUrlVal) Config.setBaseUrl(baseUrlVal);
            const key = document.getElementById('apiKeyInput').value.trim();
            if (key) Config.setApiKey(key);
            const uploadMB = parseInt(document.getElementById('uploadSizeInput').value, 10);
            if (!isNaN(uploadMB) && uploadMB >= 5 && uploadMB <= 500) {
                Config.setUploadSizeMB(uploadMB);
                document.getElementById('uploadSizeDisplay').textContent = uploadMB;
            }
            Config.updateKeyStatus();
            document.getElementById('settingsModal').classList.add('hidden');
            UI.toast('设置已保存', 'success');
            this.loadModels();
        });

        // 首次引导保存
        document.getElementById('onboardingSaveBtn').addEventListener('click', () => {
            const name = (document.getElementById('onboardingCustomName')?.value || '').trim();
            const url = (document.getElementById('onboardingCustomUrl')?.value || '').trim();
            const key = document.getElementById('onboardingKeyInput').value.trim();
            if (!name) { UI.toast('请输入平台名称', 'error'); return; }
            if (!url) { UI.toast('请输入 API 地址', 'error'); return; }
            if (!key) { UI.toast('请输入 API Key', 'error'); return; }
            // 创建自定义平台
            Config.addCustomPlatform(name, url, key);
            Config.updateKeyStatus();
            document.getElementById('onboardingModal').classList.add('hidden');
            UI.toast('设置成功，开始创作吧！', 'success');
            this.loadModels();
        });

        // Tab 切换
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
                // 故事模式下隐藏底部历史记录和日志面板
                const isStory = btn.dataset.tab === 'story';
                const histSection = document.querySelector('.history-section');
                const logPanel = document.getElementById('logPanel');
                if (histSection) histSection.style.display = isStory ? 'none' : '';
                if (logPanel) logPanel.style.display = isStory ? 'none' : '';
            });
        });
        // 初始：默认故事模式隐藏历史记录
        const _histInit = document.querySelector('.history-section');
        if (_histInit) _histInit.style.display = 'none';

        // 清空历史

        // API Key 小眼睛切换：点击切换 password / text
        const EYE_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        const EYE_CLOSED = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        document.querySelectorAll('.eye-toggle').forEach(btn => {
            btn.innerHTML = EYE_OPEN;
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.target;
                if (!targetId) return;
                const input = document.getElementById(targetId);
                if (!input) return;
                if (input.type === 'password') {
                    input.type = 'text';
                    btn.innerHTML = EYE_CLOSED;
                } else {
                    input.type = 'password';
                    btn.innerHTML = EYE_OPEN;
                }
            });
        });
        document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
            if (await UI.confirm('确定清空所有历史记录吗？', { danger: true })) {
                History.clear();
                UI.toast('历史记录已清空', 'success');
            }
        });

        // 日志面板控制
        const logToggleBtn = document.getElementById('logToggleBtn');
        const logPanel = document.getElementById('logPanel');
        const logHeader = logPanel.querySelector('.log-header');
        logToggleBtn.addEventListener('click', () => {
            logPanel.classList.toggle('minimized');
            logToggleBtn.innerHTML = logPanel.classList.contains('minimized')
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        });
        document.getElementById('logClearBtn').addEventListener('click', () => Logger.clear());

        Logger.info('AI Studio 已启动');
        Logger.info('日志面板位于右下角');

        // 初始化各模块
        ImageModule.init();
        VideoModule.initT2V();
        VideoModule.initI2V();
        RedrawModule.init();
        StoryModule.init();
        History.render();

        // 初始化素材库
        if (typeof MaterialLib !== 'undefined') {
            MaterialLib.init();
        }

        // ---- 主题切换（顶栏 + 侧边栏联动） ----
        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('app-theme', next);
        }
        const themeBtnTop = document.getElementById('themeToggleBtnTop');
        if (themeBtnTop) themeBtnTop.addEventListener('click', toggleTheme);
        const themeBtn = document.getElementById('themeToggleBtn');
        const savedTheme = localStorage.getItem('app-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
        if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

        // 加载模型
        if (Config.hasKey()) {
            this.loadModels();
        }
        } catch (e) {
            console.error('App.init() 出错:', e);
        }
    },

    /**
     * 加载模型列表
     */
    /**
     * 平台切换时更新表单
     */
    onPlatformChange() {
        const platform = document.getElementById('platformSelect').value;
        Config.setPlatform(platform);
        const preset = Config.getCurrentPlatformConfig();

        // 显示 Key 和地址输入框
        document.getElementById('apiKeyGroup').style.display = 'block';
        document.getElementById('baseUrlGroup').style.display = 'block';

        const display = document.getElementById('apiBaseUrlDisplay');
        display.readOnly = false;
        display.style.opacity = '1';
        display.style.cursor = 'auto';
        display.value = Config.getBaseUrl();
        display.placeholder = '';
        document.getElementById('baseUrlLabel').textContent = 'API 地址';
        document.getElementById('apiKeyInput').value = Config.getApiKey();

        Config.updateKeyStatus();
    },

    /**
     * 渲染平台下拉框（含自定义平台）
     */
    renderPlatformSelect() {
        const select = document.getElementById('platformSelect');
        const current = Config.getPlatform();
        let html = '';
        const customs = Config.getCustomPlatforms();
        customs.forEach(p => {
            html += `<option value="${p.id}">${p.name}</option>`;
        });
        if (customs.length === 0) {
            html = '<option value="">— 请先添加一个平台 —</option>';
        }
        select.innerHTML = html;
        select.value = current || customs[0]?.id || '';
    },

    /**
     * 渲染自定义平台列表
     */
    renderCustomPlatforms() {
        const container = document.getElementById('customPlatformItems');
        const customs = Config.getCustomPlatforms();
        if (customs.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = '';
        const currentId = Config.getPlatform();
        customs.forEach(p => {
            const isCurrent = p.id === currentId;
            const div = document.createElement('div');
            div.className = 'platform-row' + (isCurrent ? ' is-current' : '');
            div.innerHTML = `
                <span class="platform-row-name">${p.name}</span>
                <span class="platform-row-url">${p.baseUrl}</span>
                <button type="button" class="plat-btn plat-btn-select${isCurrent ? ' active' : ''}" onclick="App.selectCustomPlatform('${p.id}')" title="切换为当前平台">选择</button>
                <button type="button" class="plat-btn plat-btn-edit" onclick="App.editCustomPlatform('${p.id}')" title="编辑这个平台">编辑</button>
                <button type="button" class="plat-btn plat-btn-delete" onclick="App.deleteCustomPlatform('${p.id}')" title="删除这个平台">删除</button>
            `;
            container.appendChild(div);
        });
    },

    /**
     * 打开添加自定义平台弹窗
     */
    openAddPlatformModal() {
        document.getElementById('addPlatformName').value = '';
        document.getElementById('addPlatformUrl').value = '';
        document.getElementById('addPlatformKey').value = '';
        document.getElementById('addPlatformModal').classList.remove('hidden');
        document.getElementById('addPlatformName').focus();
    },

    /**
     * 添加自定义平台（从弹窗保存）
     */
    addCustomPlatform() {
        const name = document.getElementById('addPlatformName').value.trim();
        const url = document.getElementById('addPlatformUrl').value.trim();
        const key = document.getElementById('addPlatformKey').value.trim();
        if (!name) { UI.toast('请输入平台名称', 'error'); return; }
        if (!url) { UI.toast('请输入 API 地址', 'error'); return; }
        const id = Config.addCustomPlatform(name, url, key);
        document.getElementById('addPlatformModal').classList.add('hidden');
        App.renderPlatformSelect();
        App.renderCustomPlatforms();
        UI.toast(`已添加平台「${name}」`, 'success');
    },

    /**
     * 编辑自定义平台（打开编辑弹窗）
     */
    editCustomPlatform(id) {
        const list = Config.getCustomPlatforms();
        const p = list.find(x => x.id === id);
        if (!p) return;
        document.getElementById('editPlatformId').value = id;
        document.getElementById('editPlatformName').value = p.name;
        document.getElementById('editPlatformUrl').value = p.baseUrl;
        document.getElementById('editPlatformKey').value = p.apiKey || '';
        document.getElementById('editPlatformModal').classList.remove('hidden');
    },

    /**
     * 保存编辑自定义平台
     */
    saveEditPlatform() {
        const id = document.getElementById('editPlatformId').value;
        const name = document.getElementById('editPlatformName').value.trim();
        const url = document.getElementById('editPlatformUrl').value.trim();
        const key = document.getElementById('editPlatformKey').value.trim();
        if (!name) { UI.toast('请输入平台名称', 'error'); return; }
        if (!url) { UI.toast('请输入 API 地址', 'error'); return; }
        Config.updateCustomPlatform(id, { name, baseUrl: url, apiKey: key });
        document.getElementById('editPlatformModal').classList.add('hidden');
        App.renderPlatformSelect();
        App.renderCustomPlatforms();
        App.onPlatformChange();
        Config.updateKeyStatus();
        UI.toast(`已更新平台「${name}」`, 'success');
    },

    /**
     * 选择自定义平台
     */
    selectCustomPlatform(id) {
        Config.setPlatform(id);
        document.getElementById('platformSelect').value = id;
        App.onPlatformChange();
        UI.toast('已切换到「' + Config.getCurrentPlatformConfig().name + '」', 'info');
    },

    /**
     * 删除自定义平台
     */
    async deleteCustomPlatform(id) {
        const p = Config.getCustomPlatforms().find(x => x.id === id);
        if (!p) return;
        if (!(await UI.confirm(`确定删除平台「${p.name}」吗？`, { danger: true }))) return;
        Config.removeCustomPlatform(id);
        App.renderPlatformSelect();
        App.renderCustomPlatforms();
        App.onPlatformChange();
        Config.updateKeyStatus();
        UI.toast('已删除', 'info');
    },

    async loadModels() {
        if (!Config.hasKey()) {
            UI.toast('请先设置API Key', 'error');
            return;
        }

        // 先加载 models.json 配置
        await API._loadModelConfig();

        const t2iSel = document.getElementById('t2iModel');
        const t2vSel = document.getElementById('t2vModel');
        const i2vSel = document.getElementById('i2vModel');
        const i2iSel = document.getElementById('i2iModel');
        const storySel = document.getElementById('storyModel');

        [t2iSel, t2vSel, i2vSel, i2iSel, storySel].forEach(sel => {
            if (sel) sel.innerHTML = '<option value="">加载中...</option>';
        });

        try {
            const models = await API.getModels();
            Logger.success(`获取到 ${models.length} 个模型`);
            const classified = API.classifyModels(models);
            Logger.info(`分类结果: 图片模型=${classified.image.length}, 视频模型=${classified.video.length}, 文本模型=${classified.text.length}, 其他=${classified.other.length}`);

            // 文生图模型（图生图共用）
            t2iSel.innerHTML = '';
            i2iSel.innerHTML = '';
            if (classified.image.length > 0) {
                classified.image.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    t2iSel.appendChild(opt);
                    
                    const opt2 = opt.cloneNode(true);
                    i2iSel.appendChild(opt2);
                });
            } else {
                t2iSel.innerHTML = '<option value="">无可用模型</option>';
                i2iSel.innerHTML = '<option value="">无可用模型</option>';
            }

            // 文生视频模型
            t2vSel.innerHTML = '';
            if (classified.video.length > 0) {
                classified.video.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    t2vSel.appendChild(opt);
                });
            } else {
                t2vSel.innerHTML = '<option value="">无可用模型</option>';
            }

            // 图生视频模型（和文生视频共用）
            i2vSel.innerHTML = '';
            if (classified.video.length > 0) {
                classified.video.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    i2vSel.appendChild(opt);
                });
            } else {
                i2vSel.innerHTML = '<option value="">无可用模型</option>';
            }

            // 文本模型（故事创作用）
            if (storySel) {
                storySel.innerHTML = '';
                // 火山引擎：只保留已验证可用的聊天模型
                if (classified.text.length > 0) {
                    classified.text.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.textContent = m._label ? `${m._label} (${m.id})` : m.id;
                        storySel.appendChild(opt);
                    });
                } else {
                    // 没有识别到文本模型时，把所有模型都放进去作为备选
                    models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.textContent = m.id;
                        storySel.appendChild(opt);
                    });
                    if (storySel.children.length === 0) {
                        storySel.innerHTML = '<option value="">无可用模型</option>';
                    }
                }
            }

            // 把所有模型（含 other）追加到所有下拉，避免漏掉自定义/未识别模型
            if (classified.other.length > 0) {
                const grp1 = document.createElement('optgroup');
                grp1.label = '其他模型（部分可能不支持）';
                classified.other.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    grp1.appendChild(opt);
                });
                t2iSel.appendChild(grp1);

                const grp2 = document.createElement('optgroup');
                grp2.label = '其他模型（部分可能不支持）';
                classified.other.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    grp2.appendChild(opt);
                });
                i2iSel.appendChild(grp2);

                const grp3 = document.createElement('optgroup');
                grp3.label = '其他模型（部分可能不支持）';
                classified.other.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    grp3.appendChild(opt);
                });
                t2vSel.appendChild(grp3);
                i2vSel.appendChild(grp3.cloneNode(true));
            }

        } catch (err) {
            Logger.error(`模型列表加载失败: ${err.message}`);
            if (err.message.includes('401') || err.message.includes('Invalid token') || err.message.includes('Unauthorized')) {
                UI.toast('API Key 无效或已过期，请在设置中更新', 'error', 8000);
            } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
                UI.toast('无法连接 API 服务器，请检查网络', 'error', 8000);
            } else {
                UI.toast(err.message, 'error');
            }
            [t2iSel, t2vSel, i2vSel, i2iSel, storySel].forEach(sel => {
                if (sel) sel.innerHTML = '<option value="">加载失败</option>';
            });
        }
    }
};

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
