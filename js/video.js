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
            }
        });

        // 初始化尾帧上传（单图）
        this.lastFrameUploader = initMediaGrid('i2vLastFrameGrid', 'i2vLastFrameInput', '尾帧', {
            maxSlots: 1,
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 尾帧: ${items.length} 张`);
            }
        });

        // 首尾帧模式下的音频上传按钮
        const audioUploadBtn = document.getElementById('i2vFirstLastAudioUploadBtn');
        const audioFileInput = document.getElementById('i2vFirstLastAudioFile');
        if (audioUploadBtn && audioFileInput) {
            audioUploadBtn.addEventListener('click', () => audioFileInput.click());
            audioFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const urlInput = document.getElementById('i2vFirstLastAudioUrl');
                    if (urlInput) {
                        urlInput.value = file.name;
                    }
                    this._firstLastAudioFile = file;
                    Logger.info(`[图生视频] 首尾帧音频文件: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
                }
            });
        }

        // 初始化多模态参考九宫格
        this.i2vUploader = initMediaGrid('i2vUploadGrid', 'i2vFileInput', '图生视频', {
            onItemsChange: (items) => {
                Logger.info(`[图生视频] 当前 ${items.length} 个素材`);
            }
        });

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

                firstFrameUrl = firstItems[0].url || firstItems[0].base64;
                if (lastItems.length > 0) {
                    lastFrameUrl = lastItems[0].url || lastItems[0].base64;
                }

                // 首尾帧模式下不传参考音频
                // 火山引擎 Seedance 首尾帧 API 要求 content 只包含 first_frame/last_frame 图片，
                // 不允许混入 reference_audio/reference_video 等参考媒体
                refAudios = null;

                Logger.info(`[图生视频·首尾帧] 模型=${model}, 分辨率=${resolution}, 比例=${ratio}, 时长=${duration}s, 首帧=${!!firstFrameUrl}, 尾帧=${!!lastFrameUrl}`);
                if (refAudios) Logger.info(`[图生视频·首尾帧] 参考音频: ${refAudios.length}个`);
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
                // 对首尾帧的 base64 也上传
                if (firstFrameUrl && firstFrameUrl.startsWith('data:')) {
                    firstFrameUrl = await VideoModule._uploadToTempHost(firstFrameUrl, 'first_frame');
                }
                if (lastFrameUrl && lastFrameUrl.startsWith('data:')) {
                    lastFrameUrl = await VideoModule._uploadToTempHost(lastFrameUrl, 'last_frame');
                }

                // 按类型分类（排除首尾帧）
                refImages = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame').map(i => i.url || i.base64);
                // 对 base64 格式的图片也上传到临时托管
                if (refImages.length > 0) {
                    const imageItems = refItems.filter(i => i.type === 'image' && i.role !== 'first_frame' && i.role !== 'last_frame');
                    refImages = [];
                    for (const item of imageItems) {
                        const dataUrl = item.url || item.base64;
                        const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'image');
                        refImages.push(httpUrl);
                    }
                }
                // 视频：通过 type 字段或用 base64/url 的内容格式判断
                refVideos = refItems.filter(i => {
                    if (i.type === 'video') return true;
                    const data = i.url || i.base64 || '';
                    return data.startsWith('data:video/') || /\.(mp4|mov|webm|avi|mkv|m4v)(\?|$)/i.test(data);
                }).map(i => i.url || i.base64);
                // 音频：通过 type 字段或用 base64/url 的内容格式判断
                const audioItems = refItems.filter(i => {
                    if (i.type === 'audio') return true;
                    const data = i.url || i.base64 || '';
                    return data.startsWith('data:audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|wma)(\?|$)/i.test(data);
                });
                refAudios = audioItems.map(i => i.url || i.base64);
                // 将 base64 格式上传到临时托管获取 HTTP URL（Seedance 不支持 base64）
                if (refAudios.length > 0) {
                    UI.updateLoading('正在上传参考音频...', 0);
                    const audioItems = refItems.filter(i => i.type === 'audio');
                    refAudios = [];
                    for (const item of audioItems) {
                        const dataUrl = item.url || item.base64;
                        const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'audio');
                        refAudios.push(httpUrl);
                    }
                }
                if (refVideos.length > 0) {
                    UI.updateLoading('正在上传参考视频...', 0);
                    const videoItems = refItems.filter(i => i.type === 'video');
                    refVideos = [];
                    for (const item of videoItems) {
                        const dataUrl = item.url || item.base64;
                        const httpUrl = await VideoModule._uploadToTempHost(dataUrl, item.name || 'video');
                        refVideos.push(httpUrl);
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
                return httpUrl;
            }

            Logger.warn(`[上传托管] 上传失败: ${JSON.stringify(result)}`);
            return dataUrl;
        } catch (e) {
            Logger.error(`[上传托管] 异常: ${e.message}`);
            return dataUrl; // 降级
        }
    }
};
