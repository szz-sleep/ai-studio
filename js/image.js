/**
 * AI Studio - 文生图模块
 */

// 分辨率 → 比例 → 实际像素尺寸映射（Seedream 要求 ≥ 3.69M 像素）
const RESOLUTION_SIZE_MAP = {
    '480p': {
        '21:9': '1920x816',
        '16:9': '1536x864',
        '4:3': '1408x1056',
        '1:1': '1152x1152',
        '3:4': '1056x1408',
        '9:16': '864x1536',
    },
    '720p': {
        '21:9': '2880x1232',
        '16:9': '2304x1296',
        '4:3': '2112x1584',
        '1:1': '1920x1920',
        '3:4': '1584x2112',
        '9:16': '1296x2304',
    },
    '1080p': {
        '21:9': '3840x1648',
        '16:9': '3072x1728',
        '4:3': '2816x2112',
        '1:1': '2560x2560',
        '3:4': '2112x2816',
        '9:16': '1728x3072',
    },
    '4K': {
        '21:9': '6048x2592',
        '16:9': '5120x2880',
        '4:3': '4480x3360',
        '1:1': '4096x4096',
        '3:4': '3360x4480',
        '9:16': '2880x5120',
    },
};

const ImageModule = {
    /**
     * 初始化文生图面板
     */
    init() {
        // 比例按钮
        const ratioBtns = document.querySelectorAll('#t2iRatio .ratio-btn');
        ratioBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                ratioBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 生成按钮
        document.getElementById('t2iGenerateBtn').addEventListener('click', () => this.generate());
    },

    /**
     * 根据选中的分辨率和比例计算实际像素尺寸
     */
    getSelectedSize() {
        const ratio = document.querySelector('#t2iRatio .ratio-btn.active');
        const resolution = document.getElementById('t2iResolution')?.value || '720p';
        const ratioKey = ratio ? ratio.dataset.ratio : '16:9';
        const sizeMap = RESOLUTION_SIZE_MAP[resolution];
        return (sizeMap && sizeMap[ratioKey]) || '1920x1920';
    },

    /**
     * 获取当前选中的分辨率
     */
    getSelectedResolution() {
        return document.getElementById('t2iResolution')?.value || '720p';
    },

    /**
     * 生成图片
     */
    async generate() {
        const prompt = document.getElementById('t2iPrompt').value.trim();
        if (!prompt) {
            UI.toast('请输入画面描述', 'error');
            return;
        }

        const model = document.getElementById('t2iModel').value;
        if (!model) {
            UI.toast('请选择模型', 'error');
            return;
        }

        const size = this.getSelectedSize();
        const [w, h] = size.split('x').map(Number);
        const totalPixels = w * h;

        // 检测是否选择了 Seedream 模型（要求 ≥ 3.69M 像素）
        const modelLower = model.toLowerCase();
        const isSeedream = modelLower.includes('seedream') || modelLower.includes('seed');
        const MIN_PIXELS = 3686400;
        if (isSeedream && totalPixels < MIN_PIXELS) {
            UI.toast(`Seedream 要求至少 ${(MIN_PIXELS/1000000).toFixed(1)}M 像素，当前 ${size} 不满足，请选更高分辨率`, 'error', 8000);
            return;
        }

        const n = parseInt(document.getElementById('t2iCount').value);
        const quality = document.getElementById('t2iQuality').value;
        const style = document.getElementById('t2iStyle').value;

        const btn = document.getElementById('t2iGenerateBtn');
        btn.disabled = true;
        btn.textContent = '生成中...';

        Logger.info(`[文生图] 开始生成, 模型=${model}, 分辨率=${this.getSelectedResolution()}, 尺寸=${size}, 数量=${n}`);
        Logger.req(`prompt: "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

        UI.showLoading('正在生成图片...');

        // 创建 AbortController 用于取消
        const abortController = new AbortController();
        UI.showCancelBtn(() => {
            abortController.abort();
            Logger.warn('用户取消了生成');
            UI.toast('已取消生成', 'warn');
        });

        try {
            const resultArea = document.getElementById('t2iResult');
            resultArea.innerHTML = '';

           let imageUrls = [];

            const selRatio = document.querySelector('#t2iRatio .ratio-btn.active')?.dataset.ratio || '16:9';
            const resolution = this.getSelectedResolution();
            const apiOptions = { prompt, model, size, n: 1, quality, style, ratio: selRatio, qualityLabel: resolution, signal: abortController.signal };

            // n > 1 时并行请求，避免后端不支持批量
            if (n > 1) {
                Logger.info(`[文生图] 批量 ${n} 张，并行请求...`);
                UI.updateLoading(`正在生成 ${n} 张图片 (1/${n})...`);

                const requests = [];
                for (let i = 0; i < n; i++) {
                    requests.push(API.generateImage(apiOptions));
                }

                // Promise.allSettled 避免某一张失败导致全部失败
                const results = await Promise.allSettled(requests);
                for (const res of results) {
                    if (res.status === 'fulfilled' && res.value?.data?.length > 0) {
                        const item = res.value.data[0];
                        const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
                        if (url) imageUrls.push(url);
                    }
                }
                Logger.success(`批量完成，成功获取 ${imageUrls.length}/${n} 张`);
            } else {
                const result = await API.generateImage(apiOptions);
                if (result.data && result.data.length > 0) {
                    result.data.forEach(item => {
                        const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
                        if (url) imageUrls.push(url);
                    });
                }
                Logger.success(`单张生成完成`);
            }

            // 展示结果
            if (imageUrls.length > 0) {
                imageUrls.forEach((url, idx) => {
                    const div = document.createElement('div');
                    div.className = 'result-item';
                    const filename = `aistudio-image-${Date.now()}-${idx}.png`;
                    div.innerHTML = `
                        <img src="${url}" alt="生成结果${idx + 1}">
                        <div class="result-actions">
                            <button class="result-action-btn view-btn" data-url="${url}">🔍 查看</button>
                            <button class="result-action-btn download-btn" data-url="${url}" data-filename="${filename}">下载</button>
                        </div>
                    `;
                    // 点击查看（灯箱预览）
                    div.querySelector('.view-btn').addEventListener('click', () => {
                        UI.previewImage(url);
                    });
                    // 点击下载（fetch+blob 可靠下载）
                    div.querySelector('.download-btn').addEventListener('click', () => {
                        UI.downloadFile(url, filename);
                    });
                    resultArea.appendChild(div);

                    History.add({
                        type: 'image',
                        url: url,
                        prompt: prompt,
                        model: model,
                        time: Date.now(),
                        autosave: true
                    });
                });
                UI.toast(`成功生成 ${imageUrls.length} 张图片！`, 'success');
            } else {
                UI.toast('未返回图片数据', 'error');
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.warn('[文生图] 用户取消了生成');
                return;
            }
            Logger.error(`[文生图] 失败: ${err.message}`);
            // 针对 Seedream 尺寸不足的错误给出友好提示
            if (err.message.includes('image size must be at least')) {
                UI.toast('请选择更高的分辨率（720p 或以上）以满足模型要求', 'error', 6000);
            } else if (err.message.includes('image generation is only supported') || err.message.includes('not valid')) {
                UI.toast('当前模型不支持图片生成，请在模型下拉列表中换一个模型', 'error', 6000);
            } else {
                UI.toast(err.message, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '生成图片';
            UI.hideLoading();
        }
    }
};
