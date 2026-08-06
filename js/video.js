/**
 * AI Studio - 视频模块（文生视频 + 图生视频）
 * 图生视频支持多图上9宫格上传，所有图片+提示词一次发给模型（多图融合）
 */

const VideoModule = {
    /**
     * 图生视频上传网格控制器
     */
    i2vUploader: null,

    /**
     * 用于取消的 AbortController
     */
    abortController: null,

    /**
     * 绑定素材库按钮到指定网格
     * @param {string} btnId - 按钮 ID
     * @param {function} getUploader - 获取 uploader 对象的函数
     * @param {string} filterType - 筛选类型（可选）
     */
    _bindMaterialLibBtn(btnId, getUploader, filterType) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.addEventListener('click', () => {
            MaterialLib.openPicker((item) => {
                const uploader = getUploader();
                if (!uploader) return;

                const items = uploader.getItems?.() || [];
                const maxSlots = uploader.maxSlots || 9;
                if (items.length >= maxSlots) {
                    UI.toast(`最多${maxSlots}个素材，已满`, 'error');
                    return;
                }

                // 找到第一个空位
                const grid = uploader.gridElement;
                if (!grid) return;
                const emptyCell = grid.querySelector('.upload-grid-cell.empty');
                if (!emptyCell) {
                    UI.toast(`最多${maxSlots}个素材，已满`, 'error');
                    return;
                }

                const index = parseInt(emptyCell.dataset.index);
                if (isNaN(index)) return;

                if (uploader.setItem) {
                    uploader.setItem(index, {
                        type: item.type || 'image',
                        base64: null,
                        url: item.url,
                        name: item.name || '素材'
                    });
                    Logger.info(`[素材库] 已使用: ${item.name} (${item.url})`);
                    UI.toast('已添加到素材区', 'success');
                }
            }, filterType);
        });
    },

    /**
     * 绑定首尾帧参考音频的素材库按钮
     */
    // ============ 文生视频 ============

    /**
     * 初始化文生视频面板
     */
    initT2V() {
        // 画幅比例按钮
        document.querySelectorAll('#t2vRatio .ratio-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#t2vRatio .ratio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 时长按钮
        document.querySelectorAll('#t2vDuration .ratio-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#t2vDuration .ratio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('t2vGenerateBtn').addEventListener('click', () => this.generateT2V());
    },

    /**
     * 文生视频
     */
    async generateT2V() {
        const prompt = (document.getElementById('t2vPrompt').value.trim() + DEFAULT_PROMPT_SUFFIX).trim();
        if (!prompt || prompt === DEFAULT_PROMPT_SUFFIX.trim()) {
            UI.toast('请输入视频描述', 'error');
            return;
        }

        const model = document.getElementById('t2vModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const ratioBtn = document.querySelector('#t2vRatio .ratio-btn.active');
        const ratio = ratioBtn?.dataset.ratio || '16:9';

        const resolutionSelect = document.querySelector('#t2vResolution');
        const resolution = resolutionSelect?.value || '720p';

        const durationBtn = document.querySelector('#t2vDuration .ratio-btn.active');
        const duration = parseInt(durationBtn.dataset.duration);

        const fps = parseInt(document.getElementById('t2vFps').value);
        const seed = document.getElementById('t2vSeed').value;

        Logger.info(`[文生视频] 开始生成`);
        Logger.info(`[文生视频] 模型: ${model}, 分辨率: ${resolution}, 比例: ${ratio}, 时长: ${duration}s, FPS: ${fps}`);
        if (seed) Logger.info(`[文生视频] 种子: ${seed}`);

        await this._createVideo({
            tab: 't2v',
            prompt,
            model,
            resolution,
            ratio,
            duration,
            fps,
            seed,
            image: null,
            referenceImages: null,
            referenceVideos: null,
            referenceAudios: null,
            firstFrameUrl: null,
            lastFrameUrl: null
        });
    },

    // ============ 图生视频 ============

    i2vMode: 'firstlast',  // 'firstlast' | 'multimodal'

    /**
     * 初始化图生视频面板
     */
    initI2V() {
        // 子选项卡切换
        document.querySelectorAll('.i2v-sub-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode;
                this.i2vMode = mode;
                // 切换 active 状态
                document.querySelectorAll('.i2v-sub-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                // 切换面板显示
                document.querySelectorAll('.i2v-mode-panel').forEach(p => p.classList.remove('active'));
                if (mode === 'firstlast') {
                    document.getElementById('i2vModeFirstLast').classList.add('active');
                } else {
                    document.getElementById('i2vModeMultimodal').classList.add('active');
                }
                Logger.info(`[图生视频] 切换到${mode === 'firstlast' ? '首尾帧' : '多模态参考'}模式`);
            });
        });

        // 初始化首帧上传（单图）
        this.firstFrameUploader = initMediaGrid('i2vFirstFrameGrid', 'i2vFirstFrameInput', '首帧', {
            maxSlots: 1,
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 首帧: ${items.length} 张`);
            },
            onUpload: (dataUrl, fileName) => this._uploadToTempHost(dataUrl, fileName)
        });

        // 初始化尾帧上传（单图）
        this.lastFrameUploader = initMediaGrid('i2vLastFrameGrid', 'i2vLastFrameInput', '尾帧', {
            maxSlots: 1,
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 尾帧: ${items.length} 张`);
            },
            onUpload: (dataUrl, fileName) => this._uploadToTempHost(dataUrl, fileName)
        });

        // 首尾帧模式下的音频上传按钮（实时上传到 uguu.se 并保存到素材库）
        // 初始化多模态参考九宫格
        this.i2vUploader = initMediaGrid('i2vUploadGrid', 'i2vFileInput', '图生视频', {
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 当前 ${items.length} 个素材`);
            },
            // 选文件后立即上传到 uguu.se
            onUpload: async (dataUrl, fileName) => {
                return await this._uploadToTempHost(dataUrl, fileName);
            }
        });

        // 素材库按钮
        // 素材库按钮 — 多模态参考九宫格
        this._bindMaterialLibBtn('multimodalOpenMaterialLibBtn', () => this.i2vUploader);
        // 素材库按钮 — 首帧
        this._bindMaterialLibBtn('firstFrameOpenMaterialLibBtn', () => this.firstFrameUploader, 'image');
        // 素材库按钮 — 尾帧
        this._bindMaterialLibBtn('lastFrameOpenMaterialLibBtn', () => this.lastFrameUploader, 'image');

        // 画幅比例按钮
        document.querySelectorAll('#i2vRatio .ratio-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#i2vRatio .ratio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 时长按钮
        document.querySelectorAll('#i2vDuration .ratio-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#i2vDuration .ratio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('i2vGenerateBtn').addEventListener('click', () => this.generateI2V());
    },

    /**
     * 图生视频
     */
    async generateI2V() {
        const mode = this.i2vMode;
        const prompt = (document.getElementById('i2vPrompt').value.trim() + DEFAULT_PROMPT_SUFFIX).trim();
        const model = document.getElementById('i2vModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const resolution = document.getElementById('i2vResolution')?.value || '720p';
        const durationBtn = document.querySelector('#i2vDuration .ratio-btn.active');
        const duration = parseInt(durationBtn.dataset.duration);

        const btn = document.getElementById('i2vGenerateBtn');
        const resultArea = document.getElementById('i2vResult');

        btn.disabled = true;
        btn.textContent = '提交中...';

        // 创建取消控制器
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        resultArea.innerHTML = '';

        try {
            let firstFrameUrl = null, lastFrameUrl = null;
            let refImages = null, refVideos = null, refAudios = null;
            let imageList = null;

            // ratio 在块外声明，供后续 API 调用使用
            const ratioBtn = document.querySelector('#i2vRatio .ratio-btn.active');
            const ratio = ratioBtn?.dataset.ratio || '16:9';

            // 判断是否为本地模型（首尾帧和多模态共用，决定素材传 URL 还是 base64）
            const isLocalModel = API._isLocalModel(model);

            if (mode === 'firstlast') {
                // 首尾帧模式
                const firstItems = this.firstFrameUploader?.getItems?.() || [];
                const lastItems = this.lastFrameUploader?.getItems?.() || [];

                if (firstItems.length === 0) {
                    UI.toast('请上传首帧图片', 'error');
                    btn.disabled = false;
                    btn.textContent = '生成视频';
                    return;
                }

                firstFrameUrl = isLocalModel ? (firstItems[0].base64 || firstItems[0].url) : (firstItems[0].url || firstItems[0].base64);
                if (lastItems.length > 0) {
                    lastFrameUrl = isLocalModel ? (lastItems[0].base64 || lastItems[0].url) : (lastItems[0].url || lastItems[0].base64);
                }

                // 本地模型：保留 base64；云端/火山：上传托管获取 URL
                if (!isLocalModel) {
                    if (firstFrameUrl && firstFrameUrl.startsWith('data:')) {
                        firstFrameUrl = await VideoModule._uploadToTempHost(firstFrameUrl, 'first_frame');
                    }
                    if (lastFrameUrl && lastFrameUrl.startsWith('data:')) {
                        lastFrameUrl = await VideoModule._uploadToTempHost(lastFrameUrl, 'last_frame');
                    }
                }

                refAudios = null;

                Logger.info(`[图生视频·首尾帧] 模型=${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s, 首帧=${!!firstFrameUrl}, 尾帧=${!!lastFrameUrl}${isLocalModel ? ' (本地模型)' : ''}`);
                UI.showLoading('正在创建首尾帧视频生成任务...');

            } else {
                // 多模态参考模式
                const refItems = this.i2vUploader?.getItems?.() || [];
                if (refItems.length === 0) {
                    UI.toast('请先上传参考素材', 'error');
                    btn.disabled = false;
                    btn.textContent = '生成视频';
                    return;
                }

                // 标记为首帧/尾帧的图片
                const firstFrame = refItems.find(i => i.role === 'first_frame');
                const lastFrame = refItems.find(i => i.role === 'last_frame');
                firstFrameUrl = firstFrame?.url || firstFrame?.base64 || null;
                lastFrameUrl = lastFrame?.url || lastFrame?.base64 || null;
                // 本地模型：保留 base64；云端/火山：上传托管
                if (!isLocalModel) {
                    if (firstFrameUrl && firstFrameUrl.startsWith('data:')) {
                        firstFrameUrl = await VideoModule._uploadToTempHost(firstFrameUrl, 'first_frame');
                    }
                    if (lastFrameUrl && lastFrameUrl.startsWith('data:')) {
                        lastFrameUrl = await VideoModule._uploadToTempHost(lastFrameUrl, 'last_frame');
                    }
                }

                // 按类型分类（排除首尾帧），本地模型保留 base64，云端/火山上传 uguu.se
                if (isLocalModel) {
                    refImages = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame').map(i => i.base64 || i.url);
                    refVideos = refItems.filter(i => i.type === 'video').map(i => i.base64 || i.url);
                    refAudios = refItems.filter(i => i.type === 'audio' || (!i.type && (i.url || i.base64 || '').startsWith('data:audio/'))).map(i => i.base64 || i.url);
                    Logger.info(`[图生视频] 本地模型素材(base64优先): 图[0]=${(refImages[0]||'').substring(0,40)}...`);
                } else {
                    refImages = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame').map(i => i.url || i.base64);
                    if (refImages.length > 0) {
                        const imageItems = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame');
                        refImages = [];
                        for (const item of imageItems) {
                            const dataUrl = item.url || item.base64;
                            const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'image');
                            refImages.push(httpUrl);
                        }
                    }
                    refVideos = refItems.filter(i => {
                        if (i.type === 'video') return true;
                        const data = i.url || i.base64 || '';
                        return data.startsWith('data:video/') || /\.(mp4|mov|webm|avi|mkv|m4v)(\?|$)/i.test(data);
                    }).map(i => i.url || i.base64);
                    const audioItems = refItems.filter(i => {
                        if (i.type === 'audio') return true;
                        const data = i.url || i.base64 || '';
                        return data.startsWith('data:audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|wma)(\?|$)/i.test(data);
                    });
                    refAudios = audioItems.map(i => i.url || i.base64);
                    if (refAudios.length > 0) {
                        UI.updateLoading('正在上传参考音频...', 0);
                        const aItems = refItems.filter(i => i.type === 'audio');
                        refAudios = [];
                        for (const item of aItems) {
                            const dataUrl = item.url || item.base64;
                            const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'audio');
                            refAudios.push(httpUrl);
                        }
                    }
                    if (refVideos.length > 0) {
                        UI.updateLoading('正在上传参考视频...', 0);
                        const vItems = refItems.filter(i => i.type === 'video');
                        refVideos = [];
                        for (const item of vItems) {
                            const dataUrl = item.url || item.base64;
                            const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'video');
                            refVideos.push(httpUrl);
                        }
                    }
                }
                if (refAudios.length > 0 && (firstFrameUrl || lastFrameUrl)) {
                    Logger.info('[图生视频·多模态] 同时存在首/尾帧标记和参考音频，将忽略首尾帧，使用多模态参考模式');
                    firstFrameUrl = null;
                    lastFrameUrl = null;
                }

                Logger.info(`[图生视频·多模态] 模型=${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s`);
                Logger.info(`[图生视频] 素材: ${refImages.length}图 ${refVideos.length}视频 ${refAudios?.length || 0}音频 首帧=${!!firstFrameUrl} 尾帧=${!!lastFrameUrl}`);
                UI.showLoading('正在创建多模态视频生成任务...');
            }

            UI.showCancelBtn(() => {
                Logger.warn('[图生视频] 用户点击取消');
                this.abortController?.abort();
            });

            Logger.req(`模型: ${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s`);

            // 一次调用
            const task = await API.createVideoTask({
                model, prompt, images: imageList,
                resolution, ratio, duration, fps: 30,
                seed: undefined,
                referenceImages: refImages && refImages.length > 0 ? refImages : null,
                referenceVideos: refVideos && refVideos.length > 0 ? refVideos : null,
                referenceAudios: refAudios?.length > 0 ? refAudios : null,
                firstFrameUrl,
                lastFrameUrl
            });

            Logger.success(`任务创建成功, task_id: ${task.task_id || task.id || task.data?.task_id}`);

            const taskId = task.video_id || task.task_id || task.id || task.data?.task_id;
            if (!taskId) {
                Logger.error(`未找到task_id: ${JSON.stringify(task)}`);
                throw new Error('API未返回任务ID');
            }

            btn.textContent = '视频生成中...';
            UI.updateLoading('视频生成中...', 0);
            Logger.info(`任务ID: ${taskId}, 开始轮询...`);

            let pollCount = 0;
            const result = await API.pollVideoTask(
                taskId,
                (pct, status) => {
                    pollCount++;
                    Logger.info(`轮询 #${pollCount}: ${status}, ${pct}%`);
                    UI.updateLoading(status, pct);
                },
                5000,
                600000,
                signal
            );

            Logger.success(`视频生成完成!`);

            // 解析视频URL
            const taskData = result._taskData || result.data || result;
            // 火山引擎：content.video_url
            const volcUrl = result.content?.video_url || taskData?.content?.video_url;
            const videoUrl = API.normalizeResultUrl(
                volcUrl
                || result.url
                || result.result_url
                || result.data?.url
                || taskData?.result_url
                || taskData?.url
                || result.output?.url
                || result.video?.url
                || result.data?.video_url
                || result.output?.video_url
                || result.urls?.[0]
                || result.data?.output?.url
                || result.video_url
                || result.download_url
            );

            if (videoUrl) {
                Logger.success(`视频URL: ${videoUrl}`);

                const filename = `aistudio-i2v-multi-${Date.now()}.mp4`;
                const div = document.createElement('div');
                div.className = 'result-item';
                div.innerHTML = `
                    <div class="result-subtitle">多图融合 · 生成视频</div>
                    <video controls src="${videoUrl}"></video>
                    <div class="result-actions">
                        <button class="result-action-btn view-btn" data-url="${videoUrl}">🔍 查看</button>
                        <button class="result-action-btn download-btn" data-url="${videoUrl}" data-filename="${filename}">下载</button>
                    </div>
                `;
                div.querySelector('.view-btn').addEventListener('click', () => {
                    UI.previewVideo(videoUrl);
                });
                div.querySelector('.download-btn').addEventListener('click', () => {
                    UI.downloadFile(videoUrl, filename);
                });
                resultArea.appendChild(div);

                History.add({
                    type: 'video',
                    url: videoUrl,
                    prompt: `[多图融合] ${prompt}`,
                    model,
                    time: Date.now()
                });

                UI.toast('视频生成成功！', 'success');
            } else {
                Logger.error(`未找到视频URL: ${JSON.stringify(result).substring(0, 300)}`);
                resultArea.innerHTML = this._createI2VErrorCard('未返回视频地址');
                UI.toast('视频生成失败', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('用户取消了视频生成');
            } else {
                Logger.error(`图生视频失败: ${err.message}`);
                resultArea.innerHTML = this._createI2VErrorCard(err.message);
                UI.toast(`生成失败: ${err.message}`, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '生成视频';
            UI.hideLoading();
            UI.hideCancelBtn();
            this.abortController = null;
        }
    },

    /**
     * 创建简单错误提示
     */
    _createI2VErrorCard(message) {
        return `
            <div class="result-item result-item-error" style="border:1px solid var(--accent-border);background:var(--accent-soft);">
                <div style="text-align:center;padding:20px;color:var(--red);">
                    <div style="font-size:14px;margin-bottom:6px;">视频生成失败</div>
                    <div style="font-size:12px;color:var(--text-muted);">${message}</div>
                </div>
            </div>
        `;
    },

    /**
     * 创建视频任务
     */
    async _createVideo({ tab, prompt, model, resolution, ratio, duration, fps, seed, image, referenceImages, referenceVideos, referenceAudios, firstFrameUrl, lastFrameUrl }) {
        const btnId = tab === 't2v' ? 't2vGenerateBtn' : 'i2vGenerateBtn';
        const btn = document.getElementById(btnId);
        const resultArea = document.getElementById(`${tab}Result`);

        btn.disabled = true;
        btn.textContent = '提交中...';

        // 创建取消控制器
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        UI.showLoading('正在提交视频生成任务...');
        UI.showCancelBtn(() => {
            Logger.warn(`[${tab}] 用户点击取消`);
            this.abortController?.abort();
        });

        try {
            Logger.req(`POST /v1/video/generations`);
            Logger.req(`模型: ${model}, prompt: "${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}"`);
            Logger.req(`参数: 分辨率=${resolution}, 比例=${ratio}, duration=${duration}s, fps=${fps}${image ? ', 含图片' : ''}`);

            // 创建任务
            const task = await API.createVideoTask({
                model, prompt, image,
                resolution, ratio, duration, fps,
                seed: seed || undefined,
                referenceImages, referenceVideos, referenceAudios,
                firstFrameUrl, lastFrameUrl
            });

            Logger.success(`任务创建成功, 响应: ${JSON.stringify(task)}`);

            // 火山引擎返回 id，Agnes 用 video_id，其它平台用 task_id
            if (!task.task_id && !task.video_id && !task.id) {
                const tid = task.id || task.data?.task_id;
                if (!tid) {
                    Logger.error(`未找到 task_id, 完整响应: ${JSON.stringify(task)}`);
                    throw new Error('API 未返回任务ID，请检查日志确认响应格式');
                }
                task.task_id = tid;
                Logger.info(`使用备用字段: ${tid}`);
            }
            // 优先 video_id（Agnes），其次 task_id，最后 id（火山引擎）
            const pollTaskId = task.video_id || task.task_id || task.id;

            btn.textContent = '生成中...';
            Logger.info(`任务ID: ${pollTaskId}, 开始轮询...`);
            UI.updateLoading('视频生成中，请耐心等待...', 0);

            let pollCount = 0;
            const result = await API.pollVideoTask(
                pollTaskId,
                (pct, status) => {
                    pollCount++;
                    Logger.info(`轮询 #${pollCount}: status=${status}, 进度=${pct}%`);
                    UI.updateLoading(status, pct);
                },
                5000,
                600000,
                signal
            );

            Logger.success(`任务完成! 响应: ${JSON.stringify(result).substring(0, 300)}`);

            resultArea.innerHTML = '';

            const taskData = result._taskData || result.data || result;
            // 火山引擎：content.video_url
            const volcUrl = result.content?.video_url || taskData?.content?.video_url;
            const videoUrl = API.normalizeResultUrl(
                volcUrl
                || result.url
                || result.result_url
                || result.data?.url
                || taskData?.result_url
                || taskData?.url
                || result.output?.url
                || result.video?.url
                || result.data?.video_url
                || result.output?.video_url
                || result.urls?.[0]
                || result.data?.output?.url
                || result.video_url
                || result.download_url
            );
            if (videoUrl) {
                Logger.success(`视频URL: ${videoUrl}`);

                const filename = `aistudio-video-${Date.now()}.mp4`;
                const div = document.createElement('div');
                div.className = 'result-item';
                div.innerHTML = `
                    <video controls src="${videoUrl}"></video>
                    <div class="result-actions">
                        <button class="result-action-btn view-btn" data-url="${videoUrl}">🔍 查看</button>
                        <button class="result-action-btn download-btn" data-url="${videoUrl}" data-filename="${filename}">下载</button>
                    </div>
                `;
                div.querySelector('.view-btn').addEventListener('click', () => {
                    UI.previewVideo(videoUrl);
                });
                div.querySelector('.download-btn').addEventListener('click', () => {
                    UI.downloadFile(videoUrl, filename);
                });
                resultArea.appendChild(div);

                History.add({
                    type: 'video',
                    url: videoUrl,
                    prompt: prompt || '(图生视频)',
                    model: model,
                    time: Date.now()
                });

                UI.toast('视频生成成功！', 'success');
            } else {
                Logger.error(`响应中未找到视频URL, 完整数据: ${JSON.stringify(result)}`);
                UI.toast('未返回视频地址', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('用户取消了视频生成');
                UI.toast('已取消生成', '');
            } else {
                Logger.error(`错误: ${err.message}`);
                Logger.error(`详情: ${err.stack?.substring(0, 200) || '无堆栈'}`);
                UI.toast(err.message, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = tab === 't2v' ? '生成视频' : '生成视频';
            UI.hideLoading();
            UI.hideCancelBtn();
            this.abortController = null;
        }
    },

    /**
     * 按目标比例裁剪图片（居中裁切，不拉伸）
     * @param {string} b64 - 纯 base64
     * @param {number} targetW
     * @param {number} targetH
     * @returns {Promise<string>} 裁剪后的纯 base64
     */
    _cropToRatio(b64, targetW, targetH) {
        return new Promise((resolve) => {
            let mime = 'image/png';
            if (b64.startsWith('/9j/')) mime = 'image/jpeg';
            else if (b64.startsWith('UklGR')) mime = 'image/webp';

            const img = new Image();
            img.onload = () => {
                const targetRatio = targetW / targetH;
                const imgRatio = img.width / img.height;

                let cropW, cropH, cropX, cropY;
                if (imgRatio > targetRatio) {
                    // 图片更宽，裁左右
                    cropH = img.height;
                    cropW = img.height * targetRatio;
                    cropX = (img.width - cropW) / 2;
                    cropY = 0;
                } else if (imgRatio < targetRatio) {
                    // 图片更高，裁上下
                    cropW = img.width;
                    cropH = img.width / targetRatio;
                    cropX = 0;
                    cropY = (img.height - cropH) / 2;
                } else {
                    // 比例一致，不用裁
                    resolve(b64);
                    return;
                }

                Logger.info(`[图生视频] 裁剪图片 ${img.width}x${img.height} → ${Math.round(cropW)}x${Math.round(cropH)} (目标 ${targetW}x${targetH})`);

                const canvas = document.createElement('canvas');
                canvas.width = Math.round(cropW);
                canvas.height = Math.round(cropH);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

                const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
                resolve(dataUrl.substring(dataUrl.indexOf(',') + 1));
            };
            img.onerror = () => resolve(b64);
            img.src = 'data:' + mime + ';base64,' + b64;
        });
    },

    /**
     * 将 base64 DataURL 上传到临时托管获取 HTTP URL
     * 火山引擎 Seedance 的 audio_url 和 video_url 只支持公网 HTTP URL，不支持 base64
     * @param {string} dataUrl - base64 DataURL (data:audio/mpeg;base64,...)
     * @param {string} filename - 文件名
     * @returns {Promise<string>} HTTP URL
     */
    async _uploadToTempHost(dataUrl, filename) {
        // 已经是 HTTP URL，无需转换
        if (!dataUrl || dataUrl.startsWith('http')) return dataUrl;

        // 解析 base64 DataURL
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return dataUrl;

        const mimeType = match[1];
        const base64Data = match[2];

        // 确定扩展名
        const extMap = {
            'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
            'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
            'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
        };
        const ext = extMap[mimeType] || '.' + (mimeType.split('/')[1] || 'bin');
        const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;

        try {
            Logger.info(`[上传托管] 正在上传 ${safeName} 到临时服务器...`);

            // 将 base64 解码为二进制 Blob，构造 FormData
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: mimeType });

            const formData = new FormData();
            formData.append('files[]', blob, safeName);

            // 加超时控制（15s），防止无限等待
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch('https://uguu.se/upload', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!resp.ok) {
                Logger.warn(`[上传托管] 服务器返回 ${resp.status}`);
                return dataUrl; // 降级：仍返回原 DataURL（虽然可能不生效）
            }

            const result = await resp.json();
            if (result.success && result.files && result.files[0]) {
                const httpUrl = result.files[0].url;
                Logger.info(`[上传托管] 成功! URL: ${httpUrl}`);

                // 保存到素材库
                try {
                    const typeMap = {
                        'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/wav': 'audio',
                        'audio/ogg': 'audio', 'audio/mp4': 'audio', 'audio/x-m4a': 'audio',
                        'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
                        'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image',
                        'image/gif': 'image'
                    };
                    const mediaType = typeMap[mimeType] || 'unknown';
                    const blobSize = blob.size;
                    MaterialLib.add({
                        name: safeName,
                        url: httpUrl,
                        type: mediaType,
                        mimeType: mimeType,
                        size: blobSize
                    });
                    Logger.info(`[素材库] 已保存: ${safeName} (${mediaType})`);
                } catch (e) {
                    Logger.warn(`[素材库] 保存失败: ${e.message}`);
                }

                return httpUrl;
            }

            Logger.warn(`[上传托管] 上传失败: ${JSON.stringify(result)}`);
            return dataUrl;
        } catch (e) {
            Logger.error(`[上传托管] 异常: ${e.message}`);
            return dataUrl; // 降级
        }
    },

    /**
     * 从素材库 URL 下载文件并填充到九宫格
     * @param {string} url - 素材库中的 HTTP URL
     * @param {string} type - 类型 ('image' | 'audio' | 'video')
     * @param {number} index - 九宫格索引
     */
    async _fetchUrlToMedia(url, type, index) {
        try {
            Logger.info(`[素材库] 正在加载: ${url}`);

            // 先通过 fetch 下载
            const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) {
                UI.toast('素材加载失败', 'error');
                return;
            }

            const blob = await resp.blob();
            const mimeType = blob.type || (type === 'image' ? 'image/png' : type === 'audio' ? 'audio/mpeg' : 'video/mp4');

            // 构造文件名
            const extMap = {
                'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
                'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
                'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
            };
            const ext = extMap[mimeType] || '.bin';
            const name = '素材_' + Date.now() + ext;

            // 创建 File 对象
            const file = new File([blob], name, { type: mimeType });

            // 通过 mediagrid 的 handleMediaFile 来填充
            // 由于 handleMediaFile 是 initMediaGrid 的闭包内部函数，无法直接调用
            // 我们使用另一种方式：触发文件输入，或直接通过九宫格暴露的接口

            // 查找九宫格内部是否有可用的文件输入
            const fileInput = document.getElementById('i2vFileInput');
            if (fileInput) {
                // 使用 DataTransfer 模拟文件选择
                const dt = new DataTransfer();
                dt.items.add(file);
                fileInput.files = dt.files;

                // 触发 change 事件（mediagrid 监听了此事件）
                fileInput.dispatchEvent(new Event('change'));

                Logger.info(`[素材库] 已填充到九宫格: ${name}`);
                UI.toast('已添加到素材区', 'success');
            }

            // 也要保存到素材库（如果还没有的话）
            const lib = MaterialLib.getAll();
            if (!lib.find(i => i.url === url)) {
                MaterialLib.add({
                    name: name,
                    url: url,
                    type: type,
                    mimeType: mimeType,
                    size: blob.size
                });
            }
        } catch (e) {
            Logger.error(`[素材库] 加载失败: ${e.message}`);
            UI.toast('素材加载失败，请重试', 'error');
        }
    }
};
