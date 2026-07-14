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
    _log(level, msg) {
        if (!this._body) this._init();
        const t = new Date();
        const time = t.toLocaleTimeString('zh-CN', { hour12: false });

        // 控制台输出
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
        this._body.scrollTop = this._body.scrollHeight;
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
        this._previewFilename = filename || url.split('/').pop() || 'image';
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
        this._previewFilename = filename || url.split('/').pop() || 'video';
        dotMenu.classList.remove('hidden'); // 视频也显示下载按钮
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
            const platform = Config.getPlatform();
            document.getElementById('platformSelect').value = platform;
            document.getElementById('apiKeyInput').value = Config.getApiKey();
            document.getElementById('apiBaseUrlDisplay').value = Config.getBaseUrl();
            const hint = document.getElementById('platformHint');
            const preset = Config.getCurrentPlatformConfig();
            if (hint && preset.hint) hint.textContent = preset.hint;
            const curMB = Config.getUploadSizeMB();
            document.getElementById('uploadSizeInput').value = curMB;
            document.getElementById('uploadSizeDisplay').textContent = curMB;

            // 自定义平台：显示 API 标准选择器并加载当前值
            const apiStandardGroup = document.getElementById('apiStandardGroup');
            if (apiStandardGroup) {
                apiStandardGroup.style.display = platform === 'custom' ? 'block' : 'none';
                document.getElementById('apiStandardSelect').value = Config.getCustomApiStandard();
                document.getElementById('anthropicVersionInput').value = Config.getCustomAnthropicVersion();
                const avGroup = document.getElementById('anthropicVersionGroup');
                if (avGroup) avGroup.style.display = Config.getCustomApiStandard() === 'anthropic' ? 'block' : 'none';
            }
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
        document.getElementById('clearApiKeyBtn').addEventListener('click', () => {
            if (!confirm('确定要清除当前平台的 API Key 吗？')) return;
            Config.clearApiKey();
            Config.updateKeyStatus();
            document.getElementById('apiKeyInput').value = '';
            UI.toast('当前平台 Key 已清除', 'info');
        });

        // 恢复默认设置
        document.getElementById('resetDefaultsBtn').addEventListener('click', () => {
            if (!confirm('确定要恢复所有设置到默认值吗？\n这会清除：所有平台的 API Key、上传大小限制。\n\n历史记录不受影响。')) return;
            Config.resetToDefaults();
            document.getElementById('platformSelect').value = Config.DEFAULT_PLATFORM;
            document.getElementById('apiKeyInput').value = '';
            document.getElementById('apiBaseUrlDisplay').value = Config.getBaseUrl();
            document.getElementById('platformHint').textContent = Config.getCurrentPlatformConfig().hint;
            document.getElementById('uploadSizeInput').value = Config.DEFAULT_UPLOAD_SIZE_MB;
            document.getElementById('uploadSizeDisplay').textContent = Config.DEFAULT_UPLOAD_SIZE_MB;
            Config.updateKeyStatus();
            UI.toast('已恢复默认设置', 'success');
            setTimeout(() => window.App.loadModels(), 500);
        });

        // 保存设置
        document.getElementById('saveSettingsBtn').addEventListener('click', () => {
            const platform = document.getElementById('platformSelect').value;
            Config.setPlatform(platform);
            // 自定义平台保存 URL
            if (platform === 'custom') {
                const baseUrlVal = document.getElementById('apiBaseUrlDisplay').value.trim();
                if (baseUrlVal) Config.setBaseUrl(baseUrlVal);
                const std = document.getElementById('apiStandardSelect')?.value || 'openai';
                Config.setCustomApiStandard(std);
                const ver = document.getElementById('anthropicVersionInput')?.value.trim();
                if (ver) Config.setCustomAnthropicVersion(ver);
            }
            const key = document.getElementById('apiKeyInput').value.trim();
            if (key) {
                Config.setApiKey(key);
            }
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
            const platformSel = document.getElementById('onboardingPlatformSelect');
            if (platformSel) {
                Config.setPlatform(platformSel.value);
                const hint = document.getElementById('onboardingHint');
                const preset = Config.getCurrentPlatformConfig();
                if (hint && preset.hint) hint.textContent = preset.hint;
                // 自定义平台保存 URL
                if (platformSel.value === 'custom') {
                    const obUrl = document.getElementById('onboardingCustomUrl').value.trim();
                    if (obUrl) Config.setBaseUrl(obUrl);
                    const std = document.getElementById('onboardingApiStandard')?.value || 'openai';
                    Config.setCustomApiStandard(std);
                }
            }
            const key = document.getElementById('onboardingKeyInput').value.trim();
            if (!key) {
                UI.toast('请输入API Key', 'error');
                return;
            }
            Config.setApiKey(key);
            Config.updateKeyStatus();
            document.getElementById('onboardingModal').classList.add('hidden');
            UI.toast('设置成功，开始创作吧！', 'success');
            this.loadModels();
        });

        // 首次引导平台切换
        const onboardPlatformSel = document.getElementById('onboardingPlatformSelect');
        if (onboardPlatformSel) {
            onboardPlatformSel.addEventListener('change', () => {
                const hint = document.getElementById('onboardingHint');
                const preset = PLATFORM_PRESETS[onboardPlatformSel.value];
                if (hint && preset && preset.hint) hint.textContent = preset.hint;
                // 自定义平台显示 URL 输入框和 API 标准选择器
                const customUrlGroup = document.getElementById('onboardingCustomUrlGroup');
                const stdGroup = document.getElementById('onboardingApiStandardGroup');
                const showCustom = onboardPlatformSel.value === 'custom';
                if (customUrlGroup) customUrlGroup.style.display = showCustom ? 'block' : 'none';
                if (stdGroup) stdGroup.style.display = showCustom ? 'block' : 'none';
            });
        }

        // API 标准选择切换：显示/隐藏 Anthropic 版本输入
        const apiStdSelect = document.getElementById('apiStandardSelect');
        if (apiStdSelect) {
            apiStdSelect.addEventListener('change', () => {
                const avGroup = document.getElementById('anthropicVersionGroup');
                if (avGroup) avGroup.style.display = apiStdSelect.value === 'anthropic' ? 'block' : 'none';
            });
        }

        // Tab 切换
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
                // 故事模式下隐藏底部历史记录
                const histSection = document.querySelector('.history-section');
                if (histSection) histSection.style.display = (btn.dataset.tab === 'story') ? 'none' : '';
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
        document.getElementById('clearHistoryBtn').addEventListener('click', () => {
            if (confirm('确定清空所有历史记录吗？')) {
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
        const display = document.getElementById('apiBaseUrlDisplay');
        const label = document.getElementById('baseUrlLabel');
        const hint = document.getElementById('baseUrlHint');
        if (platform === 'custom') {
            // 自定义平台：允许用户填地址
            display.readOnly = false;
            display.style.opacity = '1';
            display.style.cursor = 'auto';
            display.value = Config.getBaseUrl();
            display.placeholder = '例如 https://your-api.com';
            label.textContent = 'API 地址（请填）';
            if (hint) hint.textContent = preset.hint || 'OpenAI 兼容接口，填入 API 地址 + API Key。';
            // 显示 API 标准选择器
            const stdGroup = document.getElementById('apiStandardGroup');
            if (stdGroup) {
                stdGroup.style.display = 'block';
                document.getElementById('apiStandardSelect').value = Config.getCustomApiStandard();
                const avGroup = document.getElementById('anthropicVersionGroup');
                if (avGroup) avGroup.style.display = Config.getCustomApiStandard() === 'anthropic' ? 'block' : 'none';
            }
        } else {
            // 预设平台：隐藏 API 标准选择器
            const stdGroup = document.getElementById('apiStandardGroup');
            if (stdGroup) stdGroup.style.display = 'none';
            // 预设平台：地址可编辑，默认填入预设值
            display.readOnly = false;
            display.style.opacity = '1';
            display.style.cursor = 'auto';
            display.value = Config.getBaseUrl();
            display.placeholder = preset.baseUrl;
            label.textContent = 'API 地址';
            if (hint) hint.textContent = preset.hint;
        }
        document.getElementById('apiKeyInput').value = Config.getApiKey();
        // 平台提示
        const platformHint = document.getElementById('platformHint');
        if (platformHint && preset.hint) platformHint.textContent = preset.hint;
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
