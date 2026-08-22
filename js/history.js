/**
 * AI Studio - 历史记录模块
 */

const History = {
    /**
     * 获取所有历史
     */
    getAll() {
        try {
            const data = localStorage.getItem(Config.STORAGE_KEYS.HISTORY);
            return data ? JSON.parse(data) : [];
        } catch {
            return [];
        }
    },

    /**
     * 添加一条记录
     * @param {object} item { type, url, prompt, model, time, autosave? }
     *   - autosave=true 时自动把远程资源下载保存到本地 history 目录，url 替换为本地 file:// 路径
     */
    async add(item) {
        // 磁盘配额控制：历史自动下载本地文件有上限，防止写爆磁盘
        // 单文件超过 200MB 不入库（视频可能很大）
        const MAX_FILE_MB = 200;
        // 历史总占用上限（MB）
        const MAX_HISTORY_MB = 500;

        let url = item.url;
        // 自动保存到本地（仅 Electron 桌面环境）
        if (item.autosave && window.electronAPI?.saveToLocal && /^https?:\/\//i.test(url)) {
            // 先探测远程文件大小（Content-Length），超限则跳过自动保存，保留远程 URL
            let sizeOk = true;
            let remoteSize = 0;
            try {
                const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
                const cl = head.headers.get('content-length');
                if (cl) remoteSize = parseInt(cl, 10) || 0;
                if (remoteSize > MAX_FILE_MB * 1024 * 1024) sizeOk = false;
            } catch { /* HEAD 失败不阻断，交给主进程超时处理 */ }

            if (sizeOk) {
                const folder = item.type === 'video' ? '视频' : '图片';
                const filename = `ai-${item.type}-${item.time || Date.now()}`;
                const saved = await window.electronAPI.saveToLocal({ url, folder, filename });
                if (saved?.ok) {
                    url = saved.fileUrl; // 存本地路径，永久可打开
                    console.log('[历史] 已保存到本地:', saved.path);
                } else {
                    console.warn('[历史] 本地保存失败，退用原链接:', saved?.error || '');
                }
            } else {
                console.warn(`[历史] 文件过大 (${(remoteSize/1024/1024).toFixed(1)}MB > ${MAX_FILE_MB}MB)，跳过本地保存，保留远程 URL`);
            }
        }
        const list = this.getAll();
        list.unshift({ ...item, url });
        // 最多保留 30 条（超了删最旧的，避免渲染过多卡顿）
        if (list.length > 30) list.length = 30;
        // 磁盘/存储配额：远程 URL 不占本地存储，但历史条目本身也占 localStorage
        // 若表单条体积过大（如 base64），裁剪最旧条目
        try {
            const json = JSON.stringify(list);
            if (json.length > 4 * 1024 * 1024) { // 超过 4MB（localStorage 常见 5MB 上限）
                console.warn('[历史] localStorage 接近上限，裁剪最旧记录');
                while (JSON.stringify(list).length > 4 * 1024 * 1024 && list.length > 5) {
                    list.pop();
                }
            }
        } catch (e) {
            console.warn('[历史] 存储超限，裁剪:', e.message);
        }
        localStorage.setItem(Config.STORAGE_KEYS.HISTORY, JSON.stringify(list));
        this.render();
    },

    /**
     * 删除单条记录
     */
    remove(index) {
        const list = this.getAll();
        list.splice(index, 1);
        localStorage.setItem(Config.STORAGE_KEYS.HISTORY, JSON.stringify(list));
        this.render();
    },

    /**
     * 清空
     */
    clear() {
        localStorage.removeItem(Config.STORAGE_KEYS.HISTORY);
        this.render();
    },

    /**
     * 渲染历史区
     */
    render() {
        const grid = document.getElementById('historyGrid');
        let list = this.getAll();

        // 渲染前裁剪，确保不超过 30 条（兼容历史存了超过 30 条的旧数据）
        if (list.length > 30) {
            list = list.slice(0, 30);
            localStorage.setItem(Config.STORAGE_KEYS.HISTORY, JSON.stringify(list));
        }

        if (list.length === 0) {
            grid.innerHTML = '<div class="history-empty">暂无记录</div>';
            return;
        }

        grid.innerHTML = '';
        list.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'history-item';
            const timeStr = new Date(item.time).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });

            div.title = item.prompt;
            if (item.type === 'video') {
                // 视频懒加载：preload="metadata" 只加载元数据+首帧画面，不预加载视频本体，界面不卡
                div.innerHTML = `
                    <video src="${item.url}" preload="metadata" muted></video>
                    <span class="history-item-tag">${timeStr}</span>
                    <button class="history-item-delete" title="删除">×</button>
                `;
                div.addEventListener('click', () => {
                    UI.previewVideo(item.url, '');
                });
            } else {
                div.innerHTML = `
                    <img src="${item.url}" alt="${item.prompt}" loading="lazy">
                    <span class="history-item-tag">${timeStr}</span>
                    <button class="history-item-delete" title="删除">×</button>
                `;
                div.addEventListener('click', () => {
                    UI.previewImage(item.url, '');
                });
            }

            // 单个删除按钮
            const deleteBtn = div.querySelector('.history-item-delete');
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (await UI.confirm('确定删除这条历史记录吗？', { danger: true })) {
                    this.remove(index);
                }
            });

            grid.appendChild(div);
        });
    }
};
