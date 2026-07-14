/**
 * AI Studio - 故事创作模块（对话模式）
 * 功能：AI 对话式生成故事、文档上传参考、字数统计、复制/下载/清空
 */

const StoryModule = {
    _docs: [],
    _controller: null,
    _records: [],
    _currentRecordId: null,
    _messages: [],  // 对话消息列表 [{role, content}]

    init() {
        // 文档上传
        const uploadArea = document.getElementById('storyDocUpload');
        const fileInput = document.getElementById('storyDocInput');
        if (uploadArea && fileInput) {
            uploadArea.addEventListener('click', () => fileInput.click());
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('drag-over');
            });
            uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('drag-over');
                this.handleDocUpload(e.dataTransfer.files);
            });
            fileInput.addEventListener('change', (e) => {
                this.handleDocUpload(e.target.files);
                fileInput.value = '';
            });
        }

        // 发送按钮
        const genBtn = document.getElementById('storyGenerateBtn');
        if (genBtn) genBtn.addEventListener('click', () => this.generate());

        // 回车发送 / Shift+回车换行
        const ideaInput = document.getElementById('storyIdeaInput');
        if (ideaInput) {
            ideaInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.generate();
                }
            });
            ideaInput.addEventListener('input', () => {
                ideaInput.style.height = '24px';
                ideaInput.style.height = Math.max(24, Math.min(ideaInput.scrollHeight, 140)) + 'px';
            });
        }

        // 工具栏
        const copyBtn = document.getElementById('storyCopyBtn');
        if (copyBtn) copyBtn.addEventListener('click', () => this.copy());
        const downloadBtn = document.getElementById('storyDownloadBtn');
        if (downloadBtn) downloadBtn.addEventListener('click', () => this.download());
        const clearBtn = document.getElementById('storyClearBtn');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clear());

        // 新建故事
        const newBtn = document.getElementById('storyNewBtn');
        if (newBtn) newBtn.addEventListener('click', () => this._newStory());

        Logger.info('[Story] 故事创作模块已初始化');
    },

    // ===== 文档上传 =====
    handleDocUpload(files) {
        if (!files || !files.length) return;
        const supported = ['.txt', '.md', '.csv', '.json', '.log'];
        Array.from(files).forEach(file => {
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            if (!supported.includes(ext)) {
                UI.toast(`不支持的文件类型: ${file.name}`, 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                this._docs.push({ name: file.name, content: e.target.result });
                this.renderDocList();
                UI.toast(`已上传: ${file.name}`, 'success');
            };
            reader.readAsText(file);
        });
    },

    renderDocList() {
        const list = document.getElementById('storyDocList');
        if (!list) return;
        list.innerHTML = this._docs.map((d, i) =>
            `<span class="doc-file-item">${this._escape(d.name)}<button class="doc-remove" data-idx="${i}">×</button></span>`
        ).join('');
        list.querySelectorAll('.doc-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._docs.splice(parseInt(btn.dataset.idx), 1);
                this.renderDocList();
            });
        });
    },

    buildDocContext() {
        if (!this._docs.length) return '';
        return '\n\n【参考文档】\n' + this._docs.map(d => `--- ${d.name} ---\n${d.content}`).join('\n\n');
    },

    // ===== 核心：生成（对话模式） =====

    async generate() {
        const prompt = (document.getElementById('storyIdeaInput')?.value || '').trim();
        if (!prompt) {
            UI.toast('请输入你的要求', 'error');
            return;
        }
        const model = document.getElementById('storyModel')?.value;
        if (!model) {
            UI.toast('请先选择 AI 模型（在设置中配置后自动加载）', 'error');
            return;
        }

        const btn = document.getElementById('storyGenerateBtn');

        // 添加用户消息到对话
        this._messages.push({ role: 'user', content: prompt });
        this._appendUserMsg(prompt);
        this._switchToChatMode();

        // 清空输入框
        const input = document.getElementById('storyIdeaInput');
        if (input) { input.value = ''; input.style.height = '24px'; }

        // 构建 AI 请求消息
        const recentMessages = this._buildMessages(prompt);

        // 创建 AI 气泡（空的，等待流式填充）
        const aiBubble = this._appendAIMsg();

        await this._callAI({
            messages: recentMessages,
            model,
            btn,
            aiBubble
        });
    },

    _buildMessages(userPrompt) {
        const systemContent = '你是一位优秀的创意写作大师，擅长用生动的语言和丰富的细节来讲述故事。请根据用户的要求创作故事，注意人物塑造、情节发展和环境描写。直接输出故事正文，不要加标题前缀或多余解释。';
        const msgs = [{ role: 'system', content: systemContent }];

        // 把之前的对话历史加上（最多最近 6 轮）
        const recent = this._messages.slice(-12);
        recent.forEach(m => {
            if (m.role === 'ai' && m.content) {
                msgs.push({ role: 'assistant', content: m.content });
            } else if (m.role === 'user') {
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'user') {
                    last.content += '\n\n' + m.content;
                } else {
                    msgs.push({ role: 'user', content: m.content + this.buildDocContext() });
                }
            }
        });

        // 确保最后一条是 user
        while (msgs.length && msgs[msgs.length - 1].role !== 'user') {
            msgs.push({ role: 'user', content: userPrompt + this.buildDocContext() });
            break;
        }

        return msgs;
    },

    async _callAI({ messages, model, btn, aiBubble }) {
        this._controller = new AbortController();
        this._setButtonsDisabled(true);
        btn.disabled = true;
        btn.classList.add('loading');

        let fullText = '';
        let firstChunk = true;
        const contentEl = aiBubble.querySelector('.story-msg-content');

        try {
            Logger.info(`[Story] AI 流式请求: model=${model}`);

            fullText = await API.chatCompletionStream({
                model,
                messages,
                signal: this._controller.signal,
                onChunk: (chunk, full) => {
                    if (firstChunk) {
                        firstChunk = false;
                        aiBubble.classList.remove('story-msg-cursor');
                    }
                    contentEl.textContent = full;
                    this._scrollChat();
                    this.updateWordCount();
                }
            });
            // 移除首尾换行/空白
            fullText = fullText.replace(/^\n+|\n+$/g, '');

            if (!fullText || !fullText.trim()) {
                contentEl.textContent = 'AI 返回了空内容';
                throw new Error('AI 返回了空内容');
            }

            // 存入消息列表（raw text）
            this._messages.push({ role: 'ai', content: fullText });
            // 用 <p> 标签渲染段落，段落间距由 margin 控制，避免 pre-wrap 多余空行
            contentEl.innerHTML = fullText.split(/\n\n+/).map(p => `<p>${this._escape(p.trim())}</p>`).join('');
            this._autoSaveRecord();
            this.updateWordCount();
            Logger.success(`[Story] AI 完成，生成 ${fullText.length} 字`);
        } catch (err) {
            if (err.name === 'AbortError') {
                if (fullText) {
                    this._messages.push({ role: 'ai', content: fullText });
                    this._autoSaveRecord();
                }
                return;
            }
            Logger.error(`[Story] AI 请求失败: ${err.message}`);
            contentEl.textContent = `请求失败: ${err.message}`;
            UI.toast(`AI 请求失败: ${err.message}`, 'error', 6000);
        } finally {
            aiBubble.classList.remove('story-msg-cursor');
            this._setButtonsDisabled(false);
            btn.disabled = false;
            btn.classList.remove('loading');
            this._controller = null;
        }
    },

    // ===== 对话 UI 渲染 =====

    _switchToChatMode() {
        const mainArea = document.getElementById('storyMainArea');
        const welcome = document.getElementById('storyWelcome');
        const chat = document.getElementById('storyChat');
        if (welcome) welcome.style.display = 'none';
        if (chat) chat.style.display = 'block';
        if (mainArea) mainArea.classList.add('has-chat');
    },

    _appendUserMsg(text) {
        const chat = document.getElementById('storyChat');
        if (!chat) return;
        const msg = document.createElement('div');
        msg.className = 'story-msg story-msg-user';
        msg.innerHTML = `
            <div class="story-msg-avatar">我</div>
            <div class="story-msg-bubble-wrap">
                <div class="story-msg-bubble"><div class="story-msg-content">${this._escape(text)}</div></div>
                <div class="story-msg-actions">
                    <button class="story-msg-action story-msg-edit" title="编辑">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="story-msg-action story-msg-copy" title="复制">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
            </div>
        `;
        const copyBtn = msg.querySelector('.story-msg-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const content = msg.querySelector('.story-msg-content')?.textContent || '';
                if (!content.trim()) return;
                try {
                    await navigator.clipboard.writeText(content);
                    copyBtn.classList.add('copied');
                    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                    UI.toast('已复制', 'success');
                } catch (e) {
                    UI.toast('复制失败', 'error');
                }
            });
        }
       const editBtn = msg.querySelector('.story-msg-edit');
       if (editBtn) {
           editBtn.addEventListener('click', () => this._startEdit(msg, editBtn));
       }
       chat.appendChild(msg);
        this._updateEditButtons();
       this._scrollChat();
   },

    // 仅最近一条用户消息可编辑，其余只保留复制
    _updateEditButtons() {
        const chat = document.getElementById('storyChat');
        if (!chat) return;
        const userMsgs = Array.from(chat.querySelectorAll('.story-msg-user'));
        userMsgs.forEach((m, i) => {
            const editBtn = m.querySelector('.story-msg-edit');
            if (!editBtn) return;
            const isLast = i === userMsgs.length - 1;
            editBtn.style.display = isLast ? '' : 'none';
        });
    },

   _startEdit(msg, editBtn) {
        const contentEl = msg.querySelector('.story-msg-content');
        if (!contentEl) return;
        const oldText = contentEl.textContent;
        const ta = document.createElement('textarea');
        ta.className = 'story-msg-edit-area';
        ta.value = oldText;
        ta.rows = 1;
        contentEl.replaceWith(ta);
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
        });
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._finishEdit(msg, ta, editBtn);
            }
        });
        editBtn.title = '发送';
        editBtn.classList.add('editing');
        editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        editBtn.onclick = () => this._finishEdit(msg, ta, editBtn);
    },

    _finishEdit(msg, textarea, editBtn) {
        const newText = textarea.value.trim();
        if (!newText) {
            UI.toast('内容不能为空', 'error');
            return;
        }
        const contentEl = document.createElement('div');
        contentEl.className = 'story-msg-content';
        contentEl.textContent = newText;
        textarea.replaceWith(contentEl);
        editBtn.title = '编辑';
        editBtn.classList.remove('editing');
        editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        editBtn.onclick = () => this._startEdit(msg, editBtn);
        // 找到这是第几条 user 消息
        const chat = document.getElementById('storyChat');
        if (chat) {
            const allUserMsgs = chat.querySelectorAll('.story-msg-user');
            const msgIdx = Array.from(allUserMsgs).indexOf(msg);
            if (msgIdx >= 0) {
                this._truncateAfterUserMsg(msgIdx);
                this._messages.push({ role: 'user', content: newText });
                this._appendUserMsg(newText);
                this._switchToChatMode();
                const model = document.getElementById('storyModel')?.value;
                if (model) {
                    const aiBubble = this._appendAIMsg();
                    const recentMessages = this._buildMessages(newText);
                    const btn = document.getElementById('storyGenerateBtn');
                    this._callAI({ messages: recentMessages, model, btn, aiBubble });
                }
            }
        }
    },

    _truncateAfterUserMsg(userMsgIndex) {
        let userCount = 0;
        let cutIdx = this._messages.length;
        for (let i = 0; i < this._messages.length; i++) {
            if (this._messages[i].role === 'user') {
                if (userCount === userMsgIndex) {
                    cutIdx = i;
                    break;
                }
                userCount++;
            }
        }
        this._messages = this._messages.slice(0, cutIdx);
        this._renderAllMessages();
    },

    _appendAIMsg() {
        const chat = document.getElementById('storyChat');
        if (!chat) return null;
        const msg = document.createElement('div');
        msg.className = 'story-msg story-msg-ai story-msg-cursor';
        msg.innerHTML = `
            <div class="story-msg-avatar">AI</div>
            <div class="story-msg-bubble-wrap">
                <div class="story-msg-bubble">
                    <div class="story-msg-content"></div>
                </div>
                <div class="story-msg-actions">
                    <button class="story-msg-action story-msg-copy" title="复制">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
            </div>
        `;
        const copyBtn = msg.querySelector('.story-msg-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const content = msg.querySelector('.story-msg-content')?.textContent || '';
                if (!content.trim()) return;
                try {
                    await navigator.clipboard.writeText(content);
                    copyBtn.classList.add('copied');
                    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                    UI.toast('已复制', 'success');
                } catch (e) {
                    UI.toast('复制失败', 'error');
                }
            });
        }
        chat.appendChild(msg);
        this._scrollChat();
        return msg;
    },

    _scrollChat() {
        const chat = document.getElementById('storyChat');
        if (chat) chat.scrollTop = chat.scrollHeight;
    },

    _renderAllMessages() {
        const chat = document.getElementById('storyChat');
        if (!chat) return;
        chat.innerHTML = '';
        this._messages.forEach(m => {
            if (m.role === 'user') {
                this._appendUserMsg(m.content);
            } else {
                const bubble = this._appendAIMsg();
                const text = (m.content || '').replace(/^\n+|\n+$/g, '');
                bubble.querySelector('.story-msg-content').innerHTML = text.split(/\n\n+/).map(p => `<p>${this._escape(p.trim())}</p>`).join('');
               bubble.classList.remove('story-msg-cursor');
           }
       });
        this._updateEditButtons();
   },

   _setButtonsDisabled(disabled) {
        ['storyGenerateBtn', 'storyEditBtn', 'storyExpandBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        });
    },

    // ===== 字数统计 =====

    updateWordCount() {
        const counter = document.getElementById('storyWordCount');
        if (!counter) return;
        // 统计所有 AI 消息的总字数
        const total = this._messages
            .filter(m => m.role === 'ai')
            .reduce((sum, m) => sum + (m.content || '').replace(/\s/g, '').length, 0);
        counter.textContent = `${total} 字`;
    },

    // ===== 工具栏操作 =====

    async copy() {
        const aiText = this._messages.filter(m => m.role === 'ai').map(m => m.content).join('\n\n');
        if (!aiText.trim()) {
            UI.toast('没有内容可复制', 'info');
            return;
        }
        try {
            await navigator.clipboard.writeText(aiText);
            UI.toast('已复制到剪贴板', 'success');
        } catch (e) {
            UI.toast('复制失败', 'error');
        }
    },

    download() {
        const aiText = this._messages.filter(m => m.role === 'ai').map(m => m.content).join('\n\n');
        if (!aiText.trim()) {
            UI.toast('没有内容可下载', 'info');
            return;
        }
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([aiText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `故事_${date}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('已下载', 'success');
    },

    clear() {
        if (this._messages.length === 0) return;
        if (!confirm('确定要清空所有对话内容吗？')) return;
        this._messages = [];
        this._renderAllMessages();
        // 恢复初始状态
        const mainArea = document.getElementById('storyMainArea');
        const welcome = document.getElementById('storyWelcome');
        const chat = document.getElementById('storyChat');
        if (welcome) welcome.style.display = 'flex';
        if (chat) chat.style.display = 'none';
        if (mainArea) mainArea.classList.remove('has-chat');
        this.updateWordCount();
        UI.toast('已清空', 'info');
    },

    _escape(s) {
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    },

    // ===== 故事记录管理 =====

    _newRecordId() {
        return 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    },

    _autoSaveRecord() {
        const aiText = this._messages.filter(m => m.role === 'ai').map(m => m.content).join('\n\n');
        if (!aiText.trim()) return;
        const title = aiText.slice(0, 20).replace(/\n/g, ' ').trim() + (aiText.length > 20 ? '...' : '');
        const now = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

        if (this._currentRecordId) {
            const rec = this._records.find(r => r.id === this._currentRecordId);
            if (rec) {
                rec.content = aiText;
                rec.title = title;
                rec.updatedAt = now;
                rec.messages = JSON.parse(JSON.stringify(this._messages));
            }
        } else {
            const rec = { id: this._newRecordId(), title, content: aiText, updatedAt: now, messages: JSON.parse(JSON.stringify(this._messages)) };
            this._records.unshift(rec);
            this._currentRecordId = rec.id;
        }
        this._renderRecordList();
    },

    _renderRecordList() {
        const list = document.getElementById('storyRecordList');
        if (!list) return;
        if (this._records.length === 0) {
            list.innerHTML = '<div class="story-record-empty">暂无记录</div>';
            return;
        }
        list.innerHTML = this._records.map(r => `
            <div class="story-record-item ${r.id === this._currentRecordId ? 'active' : ''}" data-id="${r.id}">
                <div class="story-record-info">
                    <div class="story-record-title">${this._escape(r.title)}</div>
                    <div class="story-record-time">${r.updatedAt || ''}</div>
                </div>
                <button class="story-record-menu-btn" data-action="menu" title="更多">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
                <div class="story-record-menu">
                    <div class="story-record-menu-item" data-action="rename">✏️ 重命名</div>
                    <div class="story-record-menu-item" data-action="pin">📌 置顶</div>
                    <div class="story-record-menu-item danger" data-action="delete">🗑️ 删除</div>
                </div>
            </div>
        `).join('');
        list.querySelectorAll('.story-record-item').forEach(el => {
            const id = el.dataset.id;
            // 点击记录主体加载
            const info = el.querySelector('.story-record-info');
            if (info) info.addEventListener('click', (e) => { e.stopPropagation(); this._loadRecord(id); });
            // 三个点按钮
            const menuBtn = el.querySelector('.story-record-menu-btn');
            const menu = el.querySelector('.story-record-menu');
            if (menuBtn && menu) {
                menuBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._closeAllMenus();
                    menu.classList.toggle('show');
                });
                // 菜单项
                menu.querySelectorAll('.story-record-menu-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        menu.classList.remove('show');
                        const action = item.dataset.action;
                        if (action === 'rename') this._renameRecord(id);
                        else if (action === 'pin') this._pinRecord(id);
                        else if (action === 'delete') this._deleteRecord(id);
                    });
                });
            }
        });
        // 点击其他地方关闭菜单
        document.addEventListener('click', this._closeAllMenus);
    },

    _closeAllMenus() {
        document.querySelectorAll('.story-record-menu.show').forEach(m => m.classList.remove('show'));
    },

    _renameRecord(id) {
        const rec = this._records.find(r => r.id === id);
        if (!rec) return;
        const titleEl = document.querySelector(`.story-record-item[data-id="${id}"] .story-record-title`);
        const oldTitle = titleEl ? titleEl.textContent : rec.title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldTitle;
        input.className = 'story-record-rename-input';
        input.style.cssText = 'font-size:13px;width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:2px 6px;color:var(--text-primary);';
        if (titleEl) {
            titleEl.replaceWith(input);
            input.focus();
            input.select();
        }
        const finish = () => {
            const newTitle = input.value.trim() || oldTitle;
            rec.title = newTitle;
            this._currentRecordId = id;
            this._renderRecordList();
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
    },

    _pinRecord(id) {
        const idx = this._records.findIndex(r => r.id === id);
        if (idx <= 0) return;
        const [rec] = this._records.splice(idx, 1);
        this._records.unshift(rec);
        this._renderRecordList();
        UI.toast('已置顶', 'success');
    },

    _deleteRecord(id) {
        const rec = this._records.find(r => r.id === id);
        if (!rec) return;
        if (!confirm(`确定要删除「${rec.title}」吗？`)) return;
        const wasCurrent = this._currentRecordId === id;
        this._records = this._records.filter(r => r.id !== id);
        if (wasCurrent) {
            this._currentRecordId = null;
            this._messages = [];
            const welcome = document.getElementById('storyWelcome');
            const chat = document.getElementById('storyChat');
            const mainArea = document.getElementById('storyMainArea');
            if (welcome) welcome.style.display = 'flex';
            if (chat) chat.style.display = 'none';
            if (mainArea) mainArea.classList.remove('has-chat');
            this.updateWordCount();
        }
        this._renderRecordList();
        UI.toast('已删除', 'success');
    },

    _loadRecord(id) {
        const rec = this._records.find(r => r.id === id);
        if (!rec) return;
        this._currentRecordId = id;
        this._messages = rec.messages ? JSON.parse(JSON.stringify(rec.messages)) : [];
        this._switchToChatMode();
        this._renderAllMessages();
        this.updateWordCount();
        this._renderRecordList();
    },

    _newStory() {
        this._currentRecordId = null;
        this._messages = [];
        const welcome = document.getElementById('storyWelcome');
        const chat = document.getElementById('storyChat');
        const mainArea = document.getElementById('storyMainArea');
        if (welcome) welcome.style.display = 'flex';
        if (chat) { chat.style.display = 'none'; chat.innerHTML = ''; }
        if (mainArea) mainArea.classList.remove('has-chat');
        this.updateWordCount();
        this._renderRecordList();
    }
};
