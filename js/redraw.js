/**
 * OPC Studio - 图生图模块
 * 支持多图上9宫格上传，所有图片 + 提示词 一次发给模型（多图融合）
 */

const RedrawModule = {
    /**
     * 当前上传网格控制器
     */
    uploader: null,

    /**
     * 用于取消的 AbortController
     */
    abortController: null,

    /**
     * 初始化图生图面板
     */
    init() {
        // 初始化9宫格上传
        this.uploader = initUploadGrid('i2iUploadGrid', 'i2iFileInput', '图生图', {
            onImagesChange: (images) => {
                if (images.length === 0) {
                    Logger.info('[图生图] 已无图片');
                } else {
                    Logger.info(`[图生图] 当前 ${images.length} 张图片`);
                }
            }
        });

        // 比例按钮
        const ratioBtns = document.querySelectorAll('#i2iRatio .ratio-btn');
        ratioBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                ratioBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 画质按钮
        const qualityBtns = document.querySelectorAll('#i2iQualitySelector .quality-btn');
        qualityBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                qualityBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('i2iGenerateBtn').addEventListener('click', () => this.generate());
    },

    /**
     * 根据选中的比例和画质计算实际像素尺寸
     */
    getSelectedSize() {
        const ratio = document.querySelector('#i2iRatio .ratio-btn.active');
        const quality = document.querySelector('#i2iQualitySelector .quality-btn.active');
        const ratioKey = ratio ? ratio.dataset.ratio : '1:1';
        const qualityKey = quality ? quality.dataset.quality : '1080';
        const sizeMap = QUALITY_SIZE_MAP[qualityKey];
        return (sizeMap && sizeMap[ratioKey]) || '1024x1024';
    },

    /**
     * 生成图生图 - 所有图片+提示词一次发给模型（多图融合）
     */
    async generate() {
        const images = this.uploader.getImages();
        if (images.length === 0) {
            UI.toast('请先上传参考图片', 'error');
            return;
        }

        const prompt = (document.getElementById('i2iPrompt').value.trim() + DEFAULT_PROMPT_SUFFIX).trim();
        if (!prompt || prompt === DEFAULT_PROMPT_SUFFIX.trim()) {
            UI.toast('请输入修改描述', 'error');
            return;
        }

        const model = document.getElementById('i2iModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const size = this.getSelectedSize();

        const btn = document.getElementById('i2iGenerateBtn');
        const resultArea = document.getElementById('i2iResult');

        btn.disabled = true;
        btn.textContent = '提交中...';

        Logger.info(`[图生图] 开始, 模型=${model}, 尺寸=${size}, 图片数=${images.length}`);
        Logger.req(`提示词: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

        UI.showLoading('正在生成图生图...');

        // 创建 AbortController 用于取消
        this.abortController = new AbortController();
        UI.showCancelBtn(() => {
            this.abortController.abort();
            Logger.warn('用户取消了图生图');
            UI.toast('已取消图生图', 'warn');
        });

        // 清空上次结果
        resultArea.innerHTML = '';

       try {
           // 收集所有图片的纯 base64（去掉 data:image/...;base64, 前缀）
           // 同时自动放大小图，确保满足 API 最低 3686400 像素要求（约 1920x1920）
           const MIN_PIXELS = 3686400;
           const imageList = [];
           for (const img of images) {
               let b64 = img.base64;
               const commaIdx = b64.indexOf(',');
               if (commaIdx >= 0) b64 = b64.substring(commaIdx + 1);

               // 检查图片像素数，不够就放大
               const upscaled = await this._ensureMinSize(b64, MIN_PIXELS);
                imageList.push(upscaled);
           }
           const totalMB = imageList.reduce((s, b) => s + b.length, 0) / 1024 / 1024;

           Logger.req(`[图生图] 发送 ${imageList.length} 张图片 + 提示词, 总计 ~${totalMB.toFixed(1)}MB base64`);
           // 详细日志: 每张图片的前 50 字符
           imageList.forEach((b64, i) => {
               Logger.info(`[图生图] 图片${i + 1}: ${b64.substring(0, 50)}... (长度:${b64.length})`);
           });
           const selRatio = document.querySelector('#i2iRatio .ratio-btn.active')?.dataset.ratio || '1:1';
           const qualityLabel = document.querySelector('#i2iQualitySelector .quality-btn.active')?.dataset.quality || '1080';
           const result = await API.generateImageEdit({
               prompt,
               model,
               size,
               images: imageList,  // 所有图片 + 提示词一次发给模型
               ratio: selRatio,
               qualityLabel,
               signal: this.abortController.signal
           });

            Logger.req(`[图生图] API 返回状态: ${result.code || 200}`);
            Logger.success(`[图生图] 生成成功`);

            // 展示结果
            if (result.data && result.data.length > 0) {
                const item = result.data[0];
                const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');

                if (url) {
                    const filename = `opc-redraw-${Date.now()}.png`;
                    const div = document.createElement('div');
                    div.className = 'result-item';
                    div.innerHTML = `
                        <div class="result-subtitle">图生图结果</div>
                        <img src="${url}" alt="图生图结果">
                        <div class="result-actions">
                            <button class="result-action-btn view-btn" data-url="${url}">🔍 查看</button>
                            <button class="result-action-btn download-btn" data-url="${url}" data-filename="${filename}">下载</button>
                        </div>
                    `;
                    div.querySelector('.view-btn').addEventListener('click', () => {
                        UI.previewImage(url);
                    });
                    div.querySelector('.download-btn').addEventListener('click', () => {
                        UI.downloadFile(url, filename);
                    });
                    resultArea.appendChild(div);

                    History.add({
                        type: 'image',
                        url,
                        prompt: `[图生图] ${prompt.substring(0, 150)}`,
                        model,
                        time: Date.now()
                    });

                    UI.toast('图生图成功！', 'success');
                } else {
                    Logger.error(`[图生图] 未返回图片数据`);
                    resultArea.innerHTML = this._createErrorCard('未返回图片数据');
                    UI.toast('生成失败', 'error');
                }
            } else {
                Logger.error(`[图生图] data 数组为空`);
                resultArea.innerHTML = this._createErrorCard('未返回图片数据');
                UI.toast('生成失败', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('用户取消了图生图');
            } else {
                const msg = err.message || '';
                // 针对模型不支持图片生成的友好提示
                if (msg.includes('image generation is only supported') || msg.includes('not valid')) {
                    const friendlyMsg = '当前选中的模型不支持图片生成，请在模型下拉列表中选择其他模型（如图片类模型）后重试。';
                    Logger.error(`[图生图] 模型不支持: ${msg}`);
                    resultArea.innerHTML = this._createErrorCard(friendlyMsg);
                    UI.toast('当前模型不支持图片生成，请换一个模型', 'error', 6000);
                } else {
                    Logger.error(`[图生图] 生成失败: ${msg}`);
                    resultArea.innerHTML = this._createErrorCard(msg);
                    UI.toast(`生成失败: ${msg}`, 'error');
                }
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '图生图';
            UI.hideLoading();
            UI.hideCancelBtn();
            this.abortController = null;
        }
    },

    /**
     * 确保图片满足最小像素要求，不够则等比放大
     * @param {string} b64 - 纯 base64 字符串
     * @param {number} minPixels - 最小像素数
     * @returns {Promise<string>} 放大后的纯 base64 字符串
     */
    async _ensureMinSize(b64, minPixels) {
        return new Promise((resolve) => {
            // 检测原始格式
            let mime = 'image/png';
            if (b64.startsWith('/9j/')) mime = 'image/jpeg';
            else if (b64.startsWith('UklGR')) mime = 'image/webp';

            const img = new Image();
            img.onload = () => {
                const pixels = img.width * img.height;
                let targetW = img.width;
                let targetH = img.height;
                let needResize = false;

                // 太小则放大
                if (pixels < minPixels) {
                    const scale = Math.sqrt(minPixels / pixels);
                    targetW = Math.ceil(img.width * scale);
                    targetH = Math.ceil(img.height * scale);
                    needResize = true;
                    Logger.info(`[图生图] 图片 ${img.width}x${img.height} 太小，放大到 ${targetW}x${targetH}`);
                }
                // 太大则压缩（限制最长边不超过 2400，控制 base64 体积）
                const maxEdge = 2400;
                if (targetW > maxEdge || targetH > maxEdge) {
                    const scale = maxEdge / Math.max(targetW, targetH);
                    targetW = Math.ceil(targetW * scale);
                    targetH = Math.ceil(targetH * scale);
                    needResize = true;
                    Logger.info(`[图生图] 图片压缩到 ${targetW}x${targetH}`);
                }

                if (!needResize) {
                    // 不需要缩放，但如果是 PNG 且较大，转 JPEG 压缩
                    if (mime === 'image/png' && b64.length > 500000) {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                        const newB64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
                        Logger.info(`[图生图] PNG→JPEG 压缩: ${b64.length} → ${newB64.length}`);
                        resolve(newB64);
                        return;
                    }
                    Logger.info(`[图生图] 图片 ${img.width}x${img.height} 无需调整`);
                    resolve(b64);
                    return;
                }

                // 缩放/压缩
                const canvas = document.createElement('canvas');
                canvas.width = targetW;
                canvas.height = targetH;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, targetW, targetH);
                // 统一输出 JPEG 压缩
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                const newB64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
                Logger.info(`[图生图] 压缩后 base64 长度: ${newB64.length}`);
                resolve(newB64);
            };
            img.onerror = () => {
                Logger.warn('[图生图] 无法解析图片，直接发送原始 base64');
                resolve(b64);
            };
           img.src = 'data:' + mime + ';base64,' + b64;
       });
   },

   /**
    * 创建错误卡片
    */
   _createErrorCard(message) {
        return `
            <div class="result-item result-item-error" style="border:1px solid var(--accent-border);background:var(--accent-soft);">
                <div style="text-align:center;padding:20px;color:var(--red);">
                    <div style="font-size:14px;margin-bottom:6px;">图生图失败</div>
                    <div style="font-size:12px;color:var(--text-muted);">${message}</div>
                </div>
            </div>
        `;
    }
};
