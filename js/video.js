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
     * 校验是否为有效的火山素材库 assetId
     * 素材库本地记录中 local_/temp_ 前缀的 id 不是火山 assetId，不能用于 asset:// 引用
     * @param {string} id
     * @returns {boolean}
     */
    _validAssetId(id) {
        return !!(id && typeof id === 'string' && !id.startsWith('local_') && !id.startsWith('temp_'));
    },

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
                    // assetId：素材库选的素材带火山 assetId，生成时用 asset://<id> 引用，避免传外部 URL
                    const validAssetId = VideoModule._validAssetId(item.id) ? item.id : null;
                    uploader.setItem(index, {
                        type: item.type || 'image',
                        base64: null,
                        url: item.url,
                        assetId: validAssetId,
                        sourceUrl: item.sourceUrl || item.url,
                        name: item.name || '素材'
                    });
                    Logger.info(`[素材库] 已使用: ${item.name}${validAssetId ? ` (assetId: ${validAssetId})` : ` (${item.url})`}`);
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

        // 模型切换：minimax-H3 时显示 30 秒时长选项
        document.getElementById('t2vModel').addEventListener('change', (e) => {
            VideoModule._updateDurationOptions('t2v', e.target.value);
        });

        // 生成按钮
        document.getElementById('t2vGenerateBtn').addEventListener('click', () => this.generateT2V());
    },

    /**
     * 文生视频
     */
    async generateT2V() {
        const prompt = document.getElementById('t2vPrompt').value.trim();
        if (!prompt) {
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
                this._syncI2vGenerateBtn();
            },
            onUploadFile: (dataUrl, fileName, onProgress) => this._uploadWithProgress(dataUrl, fileName, onProgress)
        });

        // 初始化尾帧上传（单图）
        this.lastFrameUploader = initMediaGrid('i2vLastFrameGrid', 'i2vLastFrameInput', '尾帧', {
            maxSlots: 1,
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 尾帧: ${items.length} 张`);
                this._syncI2vGenerateBtn();
            },
            onUploadFile: (dataUrl, fileName, onProgress) => this._uploadWithProgress(dataUrl, fileName, onProgress)
        });

        // 首尾帧模式下的音频上传按钮（实时上传到 uguu.se 并保存到素材库）
        // 初始化多模态参考九宫格
        this.i2vUploader = initMediaGrid('i2vUploadGrid', 'i2vFileInput', '图生视频', {
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 当前 ${items.length} 个素材`);
                this._syncI2vGenerateBtn();
            },
            // 选文件后立即上传到 uguu.se
            onUploadFile: async (dataUrl, fileName, onProgress) => {
                return await uploadMediaToHost(dataUrl, fileName, onProgress);
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

        // 模型切换：minimax-H3 时显示 30 秒时长选项
        document.getElementById('i2vModel').addEventListener('change', (e) => {
            VideoModule._updateDurationOptions('i2v', e.target.value);
        });

        // 生成按钮
        document.getElementById('i2vGenerateBtn').addEventListener('click', () => this.generateI2V());
    },

    /**
     * 根据当前选中的视频模型，决定是否显示 30 秒时长选项。
     * 仅 minimax-H3 模型支持 30 秒；切换到其它模型时若 30 秒处于选中态，回退到默认 4 秒。
     */
    _updateDurationOptions(tab, model) {
        const durationGroup = document.getElementById(`${tab}Duration`);
        if (!durationGroup) return;
        const btn30 = durationGroup.querySelector('.ratio-btn[data-duration="30"]');
        if (!btn30) return;
        const isH3 = VideoModule._isMinimaxH3(model);
        btn30.hidden = !isH3;
        if (!isH3 && btn30.classList.contains('active')) {
            btn30.classList.remove('active');
            const fallback = durationGroup.querySelector('.ratio-btn[data-duration="4"]');
            if (fallback) fallback.classList.add('active');
        }
    },

    /**
     * 判断是否为 minimax-H3 模型。
     * 同时要求出现 minimax 与 h3，容忍大小写、分隔符差异，以及中间夹带的额外词
     * （例如 minimax-H3 / minimax_h3 / minimaxh3 / MiniMax-Hailuo-H3 / minimax-h3-1080p）。
     * h3 后面若紧跟数字（如 h300）不算，避免误判版本号。
     */
    _isMinimaxH3(model) {
        const id = String(model || '').toLowerCase();
        return id.includes('minimax') && /h3(?!\d)/.test(id);
    },

    /**
     * 提交前的时长校验：把超出模型能力的取值拦在本地，
     * 不必把请求发给平台、再等平台返回错误。
     * - MiniMax-H3 单段上限 15 秒，30 秒走「两段生成 + 本地拼接」
     * - 其它模型沿用界面上限 15 秒
     * @param {string} model
     * @param {number} duration
     * @returns {string|null} 不通过时返回中文提示；通过返回 null
     */
    _validateDuration(model, duration) {
        if (!Number.isFinite(duration) || duration <= 0) {
            return '视频时长无效，请重新选择时长';
        }
        if (this._isMinimaxH3(model)) {
            // H3 单段最长 15 秒；30 秒由两段拼接实现
            if (duration <= 15 || duration === 30) return null;
            return `MiniMax-H3 单段最长 15 秒，最长可生成 30 秒（两段拼接）；不支持 ${duration} 秒`;
        }
        if (duration > 15) {
            return `当前模型最长支持 15 秒，无法生成 ${duration} 秒视频（30 秒仅 MiniMax-H3 支持）`;
        }
        return null;
    },

    /**
     * 从任务响应中解析视频地址（各平台字段名不一，逐个兜底）
     * @param {object} result - pollVideoTask 的返回值
     * @returns {string|null}
     */
    _pickVideoUrl(result) {
        if (!result) return null;
        const taskData = result._taskData || result.data || result;
        // 火山引擎：content.video_url
        const volcUrl = result.content?.video_url || taskData?.content?.video_url;
        return API.normalizeResultUrl(
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
            || null
        ) || null;
    },

    /**
     * 提交一段视频生成并轮询到完成
     * @param {object} params - API.createVideoTask 入参
     * @param {AbortSignal} signal
     * @param {{label?:string, onStatus?:function}} [hooks]
     * @returns {Promise<string>} 视频地址
     */
    async _runVideoClip(params, signal, hooks = {}) {
        const label = hooks.label || '视频';
        const task = await API.createVideoTask(params);
        Logger.success(`[${label}] 任务创建成功: ${JSON.stringify(task).substring(0, 200)}`);

        const taskId = task.video_id || task.task_id || task.id || task.data?.task_id;
        if (!taskId) {
            Logger.error(`[${label}] 未找到任务ID: ${JSON.stringify(task)}`);
            throw new Error('API 未返回任务ID，请检查日志确认响应格式');
        }
        Logger.info(`[${label}] 任务ID: ${taskId}, 开始轮询...`);

        let pollCount = 0;
        const result = await API.pollVideoTask(
            taskId,
            (pct, status) => {
                pollCount++;
                Logger.info(`[${label}] 轮询 #${pollCount}: status=${status}, 进度=${pct}%`);
                hooks.onStatus?.(pct, status);
            },
            API.VIDEO_POLL_INTERVAL_MS,
            API.VIDEO_POLL_TIMEOUT_MS,
            signal
        );

        const videoUrl = this._pickVideoUrl(result);
        if (!videoUrl) {
            Logger.error(`[${label}] 响应中未找到视频地址: ${JSON.stringify(result).substring(0, 300)}`);
            throw new Error(`${label}未返回视频地址`);
        }
        Logger.success(`[${label}] 视频地址: ${videoUrl}`);
        return videoUrl;
    },

    /**
     * 30 秒视频：MiniMax-H3 单段上限 15 秒，且官方接口没有延长参数，
     * 因此拆成两段 15 秒 —— 第二段以第一段末帧为首帧续接 —— 再用内置 ffmpeg 拼接。
     * @param {object} opts
     * @param {object} opts.params - 基础入参（duration 会被覆盖为单段时长）
     * @param {AbortSignal} opts.signal
     * @param {function(number,string):void} [opts.onStage] - 分段进度回调
     * @returns {Promise<string>} 拼接后的本地 file:// 地址
     */
    async _generate30s({ params, signal, onStage }) {
        const CLIP_SECONDS = 15;   // H3 单段上限

        // 0) 能力检查：拼接依赖内置 ffmpeg
        const ff = await window.electronAPI?.ffmpegAvailable?.();
        if (!ff?.ok) {
            throw new Error('缺少视频拼接组件（ffmpeg），无法生成 30 秒视频，请更新到最新版本');
        }

        // 1) 第一段
        onStage?.(1, '正在生成第 1 段（15 秒）...');
        const clip1 = await this._runVideoClip({
            ...params,
            duration: CLIP_SECONDS,
            lastFrameUrl: null   // 尾帧会顶掉续接语义，这里只保留首帧（若有）
        }, signal, {
            label: '30秒·第1段',
            onStatus: (pct, status) => onStage?.(1, `第 1 段生成中：${status}${pct ? ` ${pct}%` : ''}`)
        });

        // 2) 抽末帧 → 上传托管，作为第二段的首帧
        onStage?.(2, '正在抽取衔接帧...');
        const frame = await window.electronAPI.extractLastFrame({ url: clip1 });
        if (!frame?.ok) {
            throw new Error('抽取首段衔接帧失败：' + (frame?.error || '未知错误'));
        }
        const frameUrl = await this._uploadToTempHost(frame.dataUrl, 'continue_frame');
        if (!frameUrl || frameUrl.startsWith('data:')) {
            throw new Error('衔接帧上传公网托管失败，无法续接第二段');
        }
        Logger.info('[30秒] 衔接帧已就绪');

        // 3) 第二段（以末帧为首帧续接）
        onStage?.(3, '正在生成第 2 段（15 秒）...');
        const clip2 = await this._runVideoClip({
            ...params,
            duration: CLIP_SECONDS,
            prompt: `${params.prompt || ''}\n\n请延续上一镜头的画面：保持主体、场景、人物、风格、光影与色调一致，动作自然接续，不要重新开始。`,
            firstFrameUrl: frameUrl,
            lastFrameUrl: null,
            // 参考素材只服务第一段，第二段的内容已由首帧锁定，混用会被平台拒绝
            image: null,
            images: null,
            referenceImages: null,
            referenceVideos: null,
            referenceAudios: null
        }, signal, {
            label: '30秒·第2段',
            onStatus: (pct, status) => onStage?.(3, `第 2 段生成中：${status}${pct ? ` ${pct}%` : ''}`)
        });

        // 4) 本地拼接
        onStage?.(4, '正在拼接为 30 秒视频...');
        const merged = await window.electronAPI.concatVideos({
            urls: [clip1, clip2],
            folder: '视频',
            filename: `ai-video-30s-${Date.now()}`
        });
        if (!merged?.ok) {
            throw new Error('视频拼接失败：' + (merged?.error || '未知错误'));
        }
        Logger.success(`[30秒] 拼接完成: ${merged.path}`);
        return merged.fileUrl;
    },

    /**
     * 渲染视频结果卡片并写入历史
     * @param {object} opts
     * @param {HTMLElement} opts.resultArea
     * @param {string} opts.videoUrl
     * @param {string} opts.prompt
     * @param {string} opts.model
     * @param {string} [opts.badge] - 卡片副标题
     */
    _renderVideoResult({ resultArea, videoUrl, prompt, model, badge }) {
        resultArea.innerHTML = '';
        const filename = `aistudio-video-${Date.now()}.mp4`;
        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `
            ${badge ? `<div class="result-subtitle">${badge}</div>` : ''}
            <video controls src="${videoUrl}"></video>
            <div class="result-actions">
                <button class="result-action-btn view-btn">🔍 查看</button>
                <button class="result-action-btn download-btn" data-filename="${filename}">下载</button>
            </div>
        `;
        div.querySelector('.view-btn').addEventListener('click', () => UI.previewVideo(videoUrl));
        div.querySelector('.download-btn').addEventListener('click', () => UI.downloadFile(videoUrl, filename));
        resultArea.appendChild(div);

        // 已是本地 file:// 时 History 不会再下载一次（仅 http(s) 触发 autosave）
        History.add({
            type: 'video',
            url: videoUrl,
            prompt: prompt || '(图生视频)',
            model,
            time: Date.now(),
            autosave: true
        });
    },

    /**
     * 同步「生成视频」按钮的可用状态：
     * 只要有任何素材处于上传中/失败，按钮就禁用并提示，全部就绪才恢复。
     */
    _syncI2vGenerateBtn() {
        const btn = document.getElementById('i2vGenerateBtn');
        if (!btn) return;
        const uploaders = [this.i2vUploader, this.firstFrameUploader, this.lastFrameUploader];
        let uploading = false, failed = false;
        for (const uploader of uploaders) {
            if (!uploader || typeof uploader.checkUnready !== 'function') continue;
            const unready = uploader.checkUnready();
            if (unready.hasUploading) uploading = true;
            if (unready.hasFailed) failed = true;
        }
        if (uploading || failed) {
            btn.disabled = true;
            btn.title = uploading ? '有素材上传中，请稍候' : '有素材上传失败，请重试或删除';
        } else {
            btn.disabled = false;
            btn.title = '';
        }
    },

    /**
     * 图生视频
     */
    async generateI2V() {
        const mode = this.i2vMode;
        const prompt = document.getElementById('i2vPrompt').value.trim();
        const model = document.getElementById('i2vModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        // —— 上传状态检测：素材没上传完成（uploading）或失败（failed）禁止生成 ——
        const uploaders = [
            ['多模态参考', this.i2vUploader],
            ['首帧', this.firstFrameUploader],
            ['尾帧', this.lastFrameUploader]
        ];
        for (const [label, uploader] of uploaders) {
            if (!uploader || typeof uploader.checkUnready !== 'function') continue;
            const unready = uploader.checkUnready();
            if (unready.hasUploading) {
                UI.toast(`「${label}」还有素材在上传中，请等待上传完成后再生成`, 'warn', 5000);
                Logger.warn(`[图生视频] 生成被拦截：${label} 有素材上传中: ${unready.uploadingNames.join(', ')}`);
                return;
            }
            if (unready.hasFailed) {
                UI.toast(`「${label}」有素材上传失败，请重试或删除后再生成`, 'error', 5000);
                Logger.warn(`[图生视频] 生成被拦截：${label} 有素材上传失败: ${unready.failedNames.join(', ')}`);
                return;
            }
        }

        const resolution = document.getElementById('i2vResolution')?.value || '720p';
        const durationBtn = document.querySelector('#i2vDuration .ratio-btn.active');
        const duration = parseInt(durationBtn.dataset.duration);
        const fps = parseInt(document.getElementById('i2vFps')?.value || '30', 10);

        const btn = document.getElementById('i2vGenerateBtn');
        const resultArea = document.getElementById('i2vResult');

        // —— 本地前置校验：超出模型能力的时长直接拦下 ——
        const invalidDuration = this._validateDuration(model, duration);
        if (invalidDuration) {
            Logger.warn(`[图生视频] 时长校验未通过: ${invalidDuration}`);
            UI.toast(invalidDuration, 'error', 5000);
            return;
        }

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

                // 素材库选的素材：带有效 assetId → 生成时用 asset://<id> 引用（火山素材库），不 re-upload 外部 URL
                if (!isLocalModel && VideoModule._validAssetId(firstItems[0].assetId)) {
                    firstFrameUrl = 'asset://' + firstItems[0].assetId;
                }
                if (!isLocalModel && VideoModule._validAssetId(lastItems[0]?.assetId)) {
                    lastFrameUrl = 'asset://' + lastItems[0].assetId;
                }

                // 本地模型：保留 base64；云端/火山：上传托管获取 URL（仅无 assetId 时）
                if (!isLocalModel) {
                    if (firstFrameUrl && firstFrameUrl.startsWith('data:')) {
                        firstFrameUrl = await VideoModule._uploadToTempHost(firstFrameUrl, 'first_frame');
                    }
                    if (lastFrameUrl && lastFrameUrl.startsWith('data:')) {
                        lastFrameUrl = await VideoModule._uploadToTempHost(lastFrameUrl, 'last_frame');
                    }
                }

                refAudios = null;

                Logger.info(`[图生视频·首尾帧] 模型=${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s, FPS=${fps}, 首帧=${!!firstFrameUrl}, 尾帧=${!!lastFrameUrl}${isLocalModel ? ' (本地模型)' : ''}`);
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
                // 素材库选的素材（带有效 assetId）→ 用 asset://<id> 引用火山素材库，不 re-upload 外部 URL
                if (VideoModule._validAssetId(firstFrame?.assetId)) firstFrameUrl = 'asset://' + firstFrame.assetId;
                if (VideoModule._validAssetId(lastFrame?.assetId)) lastFrameUrl = 'asset://' + lastFrame.assetId;
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
                    // 参考图：带 assetId 的用 asset:// 引用火山素材库（跳过 re-upload），否则走原外部 URL 流程
                    const imageItems = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame');
                    refImages = [];
                    for (const item of imageItems) {
                        if (VideoModule._validAssetId(item.assetId)) {
                            refImages.push('asset://' + item.assetId);
                            Logger.info(`[图生视频] 图片素材用素材库引用: asset://${item.assetId}`);
                            continue;
                        }
                        const dataUrl = item.url || item.base64;
                        const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'image');
                        refImages.push(httpUrl);
                    }
                    refVideos = refItems.filter(i => {
                        if (i.type === 'video') return true;
                        const data = i.url || i.base64 || '';
                        return data.startsWith('data:video/') || /\.(mp4|mov|webm|avi|mkv|m4v)(\?|$)/i.test(data);
                    }).map(i => VideoModule._validAssetId(i.assetId) ? 'asset://' + i.assetId : (i.url || i.base64));
                    const audioItems = refItems.filter(i => {
                        if (i.type === 'audio') return true;
                        const data = i.url || i.base64 || '';
                        return data.startsWith('data:audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|wma)(\?|$)/i.test(data);
                    });
                    refAudios = audioItems.map(i => VideoModule._validAssetId(i.assetId) ? 'asset://' + i.assetId : (i.url || i.base64));
                    if (refAudios.length > 0) {
                        UI.updateLoading('正在上传参考音频...', 0);
                        const aItems = refItems.filter(i => i.type === 'audio' && !VideoModule._validAssetId(i.assetId));
                        for (let ai = 0; ai < aItems.length; ai++) {
                            const httpUrl = await VideoModule._uploadToTempHost(aItems[ai].url || aItems[ai].base64, aItems[ai].name || 'audio');
                            // 替换该位置的 url（asset:// 的保留）
                            const dataUrl = aItems[ai].url || aItems[ai].base64;
                            const idx = refAudios.indexOf(dataUrl);
                            if (idx >= 0) refAudios[idx] = httpUrl;
                        }
                    }
                    if (refVideos.length > 0) {
                        UI.updateLoading('正在上传参考视频...', 0);
                        const vItems = refItems.filter(i => i.type === 'video' && !VideoModule._validAssetId(i.assetId));
                        for (const item of vItems) {
                            const httpUrl = await VideoModule._uploadToTempHost(item.url || item.base64, item.name || 'video');
                            const dataUrl = item.url || item.base64;
                            const idx = refVideos.indexOf(dataUrl);
                            if (idx >= 0) refVideos[idx] = httpUrl;
                        }
                    }
                }
                if (refAudios.length > 0 && (firstFrameUrl || lastFrameUrl)) {
                    Logger.info('[图生视频·多模态] 同时存在首/尾帧标记和参考音频，将忽略首尾帧，使用多模态参考模式');
                    firstFrameUrl = null;
                    lastFrameUrl = null;
                }

                Logger.info(`[图生视频·多模态] 模型=${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s, FPS=${fps}`);
                Logger.info(`[图生视频] 素材: ${refImages.length}图 ${refVideos.length}视频 ${refAudios?.length || 0}音频 首帧=${!!firstFrameUrl} 尾帧=${!!lastFrameUrl}`);
                UI.showLoading('正在创建多模态视频生成任务...');
            }

            UI.showCancelBtn(() => {
                Logger.warn('[图生视频] 用户点击取消');
                this.abortController?.abort();
            });

            Logger.req(`模型: ${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s, FPS=${fps}`);

            const params = {
                model, prompt, images: imageList,
                resolution, ratio, duration, fps,
                seed: undefined,
                referenceImages: refImages && refImages.length > 0 ? refImages : null,
                referenceVideos: refVideos && refVideos.length > 0 ? refVideos : null,
                referenceAudios: refAudios?.length > 0 ? refAudios : null,
                firstFrameUrl,
                lastFrameUrl
            };

            // 30 秒：H3 单段上限 15 秒，改为两段生成后本地拼接
            if (duration === 30) {
                const mergedUrl = await this._generate30s({
                    params,
                    signal,
                    onStage: (stage, text) => {
                        btn.textContent = `第 ${stage}/4 步...`;
                        UI.updateLoading(text, 0);
                    }
                });
                this._renderVideoResult({
                    resultArea,
                    videoUrl: mergedUrl,
                    prompt: `[多图融合] ${prompt}`,
                    model,
                    badge: '30秒 · 两段拼接生成'
                });
                UI.toast('30 秒视频生成成功！', 'success');
                return;
            }

            btn.textContent = '视频生成中...';
            UI.updateLoading('视频生成中...', 0);

            const videoUrl = await this._runVideoClip(params, signal, {
                label: '图生视频',
                onStatus: (pct, status) => UI.updateLoading(status, pct)
            });

            Logger.success(`视频生成完成! 视频URL: ${videoUrl}`);
            this._renderVideoResult({
                resultArea,
                videoUrl,
                prompt: `[多图融合] ${prompt}`,
                model,
                badge: mode === 'firstlast' ? '首尾帧 · 生成视频' : '多图融合 · 生成视频'
            });
            UI.toast('视频生成成功！', 'success');
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('用户取消了视频生成');
            } else {
                Logger.error(`图生视频失败: ${err.message}`);
                resultArea.innerHTML = this._createI2VErrorCard(this._realPersonZh(err.message));
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
     * 火山真人检测错误 → 中文提示
     * 仅用于界面展示（视频展示区），日志仍保留英文原文
     * @param {string} msg - 原始错误信息
     * @returns {string} 中文提示（非真人错误则原样返回）
     */
    _realPersonZh(msg) {
        const s = msg || '';
        if (/PrivacyInformation|may contain real person/i.test(s)) {
            return '图片含有真人肖像，受平台限制。请将人物图片上传到素材库引用后再生成';
        }
        return msg;
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

        // —— 本地前置校验：超出模型能力的时长直接拦下，不必发给平台再等报错 ——
        const invalidDuration = this._validateDuration(model, duration);
        if (invalidDuration) {
            Logger.warn(`[${tab}] 时长校验未通过: ${invalidDuration}`);
            UI.toast(invalidDuration, 'error', 5000);
            return;
        }

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

            const params = {
                model, prompt, image,
                resolution, ratio, duration, fps,
                seed: seed || undefined,
                referenceImages, referenceVideos, referenceAudios,
                firstFrameUrl, lastFrameUrl
            };

            // 30 秒：H3 单段上限 15 秒，改为两段生成后本地拼接
            if (duration === 30) {
                const mergedUrl = await this._generate30s({
                    params,
                    signal,
                    onStage: (stage, text) => {
                        btn.textContent = `第 ${stage}/4 步...`;
                        UI.updateLoading(text, 0);
                    }
                });
                this._renderVideoResult({ resultArea, videoUrl: mergedUrl, prompt, model, badge: '30秒 · 两段拼接生成' });
                UI.toast('30 秒视频生成成功！', 'success');
                return;
            }

            btn.textContent = '生成中...';
            UI.updateLoading('视频生成中，请耐心等待...', 0);

            const videoUrl = await this._runVideoClip(params, signal, {
                label: '文生视频',
                onStatus: (pct, status) => UI.updateLoading(status, pct)
            });

            this._renderVideoResult({ resultArea, videoUrl, prompt, model });
            UI.toast('视频生成成功！', 'success');
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
     * 带进度回调的上传（供九宫格实时显示进度）。
     * 委托给共享的 uploadMediaToHost（XHR 实现，可区分被拒/网络错误）。
     */
    async _uploadWithProgress(dataUrl, filename, onProgress) {
        return await uploadMediaToHost(dataUrl, filename, onProgress);
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

            // 单次上传（带超时控制，45s），失败/超时抛出；每次重新构造 FormData（body 不可复用）
            async function uploadOnce() {
                const fd = new FormData();
                fd.append('files[]', blob, safeName);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 45000);
                try {
                    const r = await fetch('https://uguu.se/upload', {
                        method: 'POST',
                        body: fd,
                        signal: controller.signal
                    });
                    if (!r.ok) {
                        throw new Error(`HTTP ${r.status}`);
                    }
                    return r;
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            // 上传重试：最多 3 次（1+2重试），失败间隔退避，避免超时/网抖导致一次失败
            let resp = null;
            let lastErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    resp = await uploadOnce();
                    break;
                } catch (e) {
                    lastErr = e;
                    Logger.warn(`[上传托管] 第 ${attempt + 1} 次上传失败(${e.message})，${attempt < 2 ? '重试中...' : '放弃'}`);
                    if (attempt < 2) {
                        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    }
                }
            }

            if (!resp) {
                Logger.warn(`[上传托管] 上传失败: ${lastErr?.message || '未知错误'}`);
                return dataUrl; // 降级：仍返回原 DataURL
            }

            const result = await resp.json();
            if (result.success && result.files && result.files[0]) {
                const httpUrl = result.files[0].url;
                Logger.info(`[上传托管] 成功! URL: ${httpUrl}`);

                // 说明：九宫格上传素材仅用于本次生成，不再自动加入素材库
                // （素材库只供火山素材引用，需用户主动保存才会入库）

                return httpUrl;
            }

            Logger.warn(`[上传托管] 上传失败: ${JSON.stringify(result)}`);
            throw new Error('素材托管上传失败（临时图床服务未返回地址），请稍后重试');
        } catch (e) {
            Logger.error(`[上传托管] 异常: ${e.message}`);
            // 上传托管失败会导致火山无法解析素材（火山只接受公网 HTTP URL），必须明确报错而不是静默降级
            throw new Error('素材无法上传到公网托管，火山引擎不支持 base64 素材。请检查网络后重试');
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
