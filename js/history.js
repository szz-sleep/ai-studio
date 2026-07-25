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
     */
    add(item) {
        const list = this.getAll();
        list.unshift(item);
        // 最多保留 50 条
        if (list.length > 50) list.length = 50;
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
        const list = this.getAll();

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
                div.innerHTML = `
                    <video src="${item.url}" preload="metadata"></video>
                    <span class="history-item-tag">${timeStr}</span>
                    <button class="history-item-delete" title="删除">×</button>
                `;
                div.addEventListener('click', () => {
                    UI.previewVideo(item.url, '');
                });
            } else {
                div.innerHTML = `
                    <img src="${item.url}" alt="${item.prompt}">
                    <span class="history-item-tag">${timeStr}</span>
                    <button class="history-item-delete" title="删除">×</button>
                `;
                div.addEventListener('click', () => {
                    UI.previewImage(item.url, '');
                });
            }

            // 单个删除按钮
            const deleteBtn = div.querySelector('.history-item-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定删除这条历史记录吗？')) {
                    this.remove(index);
                }
            });

            grid.appendChild(div);
        });
    }
};
