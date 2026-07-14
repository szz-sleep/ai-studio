/**
 * OPC Studio - 视频模块（文生视频 + 图生视频）
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
        // 比例按钮
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
        const width = parseInt(ratioBtn.dataset.w);
        const height = parseInt(ratioBtn.dataset.h);
        const size = `${width}x${height}`;

        const durationBtn = document.querySelector('#t2vDuration .ratio-btn.active');
        const duration = parseInt(durationBtn.dataset.duration);

        const fps = parseInt(document.getElementById('t2vFps').value);
        const seed = document.getElementById('t2vSeed').value;

        Logger.info(`[文生视频] 开始生成`);
        Logger.info(`[文生视频] 模型: ${model}, 分辨率: ${size}, 时长: ${duration}s, FPS: ${fps}`);
        if (seed) Logger.info(`[文生视频] 种子: ${seed}`);

        await this._createVideo({
            tab: 't2v',
            prompt,
            model,
            size,
            duration,
            fps,
            seed,
            image: null
        });
    },

    // ============ 图生视频 ============

    /**
     * 初始化图生视频面板
     */
    initI2V() {
        // 初始化9宫格上传
        this.i2vUploader = initUploadGrid('i2vUploadGrid', 'i2vFileInput', '图生视频', {
            onImagesChange: (images) => {
                if (images.length === 0) {
                    Logger.info('[图生视频] 已无图片');
                } else {
                    Logger.info(`[图生视频] 当前 ${images.length} 张图片`);
                }
            }
        });

        // 比例按钮
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
     * 图生视频 - 所有图片+提示词一次发给模型（多图融合）
     */
    async generateI2V() {
        const images = this.i2vUploader.getImages();
        if (images.length === 0) {
            UI.toast('请先上传图片', 'error');
            return;
        }

        const prompt = (document.getElementById('i2vPrompt').value.trim() + DEFAULT_PROMPT_SUFFIX).trim();
        const model = document.getElementById('i2vModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const ratioBtn = document.querySelector('#i2vRatio .ratio-btn.active');
        const width = parseInt(ratioBtn.dataset.w);
        const height = parseInt(ratioBtn.dataset.h);
        const size = `${width}x${height}`;

        const durationBtn = document.querySelector('#i2vDuration .ratio-btn.active');
        const duration = parseInt(durationBtn.dataset.duration);

        const btn = document.getElementById('i2vGenerateBtn');
        const resultArea = document.getElementById('i2vResult');

        btn.disabled = true;
        btn.textContent = '提交中...';

        Logger.info(`[图生视频] 开始生成, 模型=${model}, 尺寸=${size}, 时长=${duration}s, 图片数=${images.length}`);

        // 创建取消控制器
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        UI.showLoading('正在创建视频生成任务（多图融合）...');
        UI.showCancelBtn(() => {
            Logger.warn('[图生视频] 用户点击取消');
            this.abortController?.abort();
        });

        resultArea.innerHTML = '';

        try {
            // 收集所有图片的 base64（去掉 data:image/...;base64, 前缀）
            const imageList = images.map(img => {
                const commaIdx = img.base64.indexOf(',');
                return commaIdx >= 0 ? img.base64.substring(commaIdx + 1) : img.base64;
            });

            Logger.req(`[多图融合] 发送 ${imageList.length} 张图片 + 提示词, 总计 ~${(imageList.reduce((s, b) => s + b.length, 0) / 1024 / 1024).toFixed(1)}MB base64`);
            Logger.req(`模型: ${model}, size=${size}, duration=${duration}s`);

            // 一次调用，发送所有图片 + 提示词
            const task = await API.createVideoTask({
                model, prompt, images: imageList,
                size, duration, fps: 30,
                seed: undefined
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
            const videoUrl = API.normalizeResultUrl(
                result.url
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

                const filename = `opc-i2v-multi-${Date.now()}.mp4`;
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
     * 创建视频任务（文生视频已有的方法，保持不变）
     */
    async _createVideo({ tab, prompt, model, size, duration, fps, seed, image }) {
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
            Logger.req(`参数: size=${size}, duration=${duration}s, fps=${fps}${image ? ', 含图片' : ''}`);

            // 创建任务
            const task = await API.createVideoTask({
                model, prompt, image,
                size, duration, fps,
                seed: seed || undefined
            });

            Logger.success(`任务创建成功, 响应: ${JSON.stringify(task)}`);

            // Agnes 用 video_id 轮询，其它平台用 task_id
            if (!task.task_id && !task.video_id) {
                const tid = task.id || task.data?.task_id;
                if (!tid) {
                    Logger.error(`未找到 task_id, 完整响应: ${JSON.stringify(task)}`);
                    throw new Error('API 未返回任务ID，请检查日志确认响应格式');
                }
                task.task_id = tid;
                Logger.info(`使用备用字段: ${tid}`);
            }
            // 优先 video_id（Agnes），否则 task_id
            const pollTaskId = task.video_id || task.task_id;

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
            const videoUrl = API.normalizeResultUrl(
                result.url
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

                const filename = `opc-video-${Date.now()}.mp4`;
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
    }
};
