/**
 * AI Studio - 云镜 Agent 对话模块
 * 原生移植自桌面版「云镜 AI」（C:\Users\Administrator\Desktop\AGENT\my-agent），
 * 后端为本地 FastAPI 服务（127.0.0.1:8765），由 main.js 随应用自动拉起。
 */

const AgentModule = {
    BASE: 'http://127.0.0.1:8765',
    STORE_KEY: 'aistudio_agent_sessions_v1',
    CURRENT_KEY: 'aistudio_agent_current',

    _sessions: [],   // [{id, title, items, updated, pinned}]
    _currentId: null,
    _items: [],      // 当前会话时间线（引用 session.items）
    _busy: false,
    _pendingFiles: [], // [{name, path}]

    // ---------- DOM 引用 ----------
    get _chat() { return document.getElementById('agentChat'); },
    get _main() { return document.getElementById('agentMainArea'); },
    get _welcome() { return document.getElementById('agentWelcome'); },
    get _input() { return document.getElementById('agentInput'); },
    get _sendBtn() { return document.getElementById('agentSendBtn'); },
    get _recordList() { return document.getElementById('agentRecordList'); },
    get _attachRow() { return document.getElementById('agentAttachRow'); },
    get _fileInput() { return document.getElementById('agentFileInput'); },

    // ================= 工具函数 =================

    _escape(s) {
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    },

    _renderMD(text) {
        // <think> 思考内容 → 可折叠块
        text = String(text).replace(
            /<think>([\s\S]*?)(<\/think>|$)/g,
            (m, body) => `\n<details class="agent-think"><summary>思考过程</summary>\n${body.trim()}\n</details>\n`
        );
        if (typeof marked === 'undefined') return this._escape(text).replace(/\n/g, '<br>');
        try { return marked.parse(text, { breaks: true }); }
        catch { return this._escape(text).replace(/\n/g, '<br>'); }
    },

    _displayArgs(it) {
        if (it.name === 'write_file' && it.args) return JSON.stringify({ path: it.args.path });
        return JSON.stringify(it.args || {});
    },

    _scrollBottom(instant = false) {
        const el = this._chat;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
    },

    // ================= 会话管理 =================

    _load() {
        try {
            this._sessions = JSON.parse(localStorage.getItem(this.STORE_KEY) || '[]');
            this._currentId = localStorage.getItem(this.CURRENT_KEY) || null;
        } catch { this._sessions = []; }
        if (this._currentId && !this._sessions.find(s => s.id === this._currentId)) this._currentId = null;
    },

    _persist() {
        localStorage.setItem(this.STORE_KEY, JSON.stringify(this._sessions));
        localStorage.setItem(this.CURRENT_KEY, this._currentId || '');
    },

    _current() { return this._sessions.find(s => s.id === this._currentId) || null; },

    /** 当前选中的对话模型（侧栏下拉），空字符串 = 用后端默认模型 */
    _currentModel() {
        const sel = document.getElementById('agentModel');
        return (sel && sel.value) ? sel.value : '';
    },

    /** 取 AI Studio 当前平台配置的 API 凭据（Agent 与全应用共用同一 API 渠道） */
    _aiStudioCreds() {
        if (typeof Config === 'undefined') {
            return { model: this._currentModel(), base_url: '', api_key: '' };
        }
        let base = (Config.getBaseUrl() || '').replace(/\/+$/, '');
        // 后端按 OpenAI 兼容规范拼 {base_url}/chat/completions，这里补齐 /v1
        if (!/\/v\d+$/.test(base)) base += '/v1';
        return {
            model: this._currentModel(),
            base_url: base,
            api_key: Config.getApiKey() || ''
        };
    },


    _touch() {
        const s = this._current();
        if (!s) return;
        s.updated = Date.now();
        const firstUser = s.items.find(it => it.kind === 'user');
        if (firstUser && s.title === '新对话') s.title = firstUser.text.slice(0, 20) || '新对话';
        this._persist();
        this._renderRecords();
    },

    newChat() {
        if (this._busy) return;
        const s = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: '新对话', items: [], updated: Date.now()
        };
        this._sessions.push(s);
        this._currentId = s.id;
        this._items = s.items;
        this._persist();
        this._renderRecords();
        this._renderStored();
    },

    _loadSession(id) {
        if (this._busy) return;
        const s = this._sessions.find(x => x.id === id);
        if (!s) return;
        this._currentId = id;
        this._items = s.items;
        this._persist();
        this._renderRecords();
        this._renderStored();
    },

    // ================= 左侧记录列表 =================

    _renderRecords() {
        const list = this._recordList;
        if (!list) return;
        this._closeMenu();
        if (!this._sessions.length) {
            list.innerHTML = '<div class="story-record-empty">暂无记录</div>';
            return;
        }
        const sorted = [...this._sessions].sort((a, b) =>
            (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
        list.innerHTML = '';
        const t = new Date();
        sorted.forEach(s => {
            const d = new Date(s.updated);
            const time = (d.toDateString() === t.toDateString())
                ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
                : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
            const item = document.createElement('div');
            item.className = 'story-record-item' + (s.id === this._currentId ? ' active' : '');
            item.title = s.title;
            item.innerHTML = `
                <div class="story-record-info">
                    <div class="story-record-title">${this._escape(s.title)}</div>
                    <div class="story-record-time">${time}</div>
                </div>
                <button class="story-record-menu-btn" title="更多操作">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>
                </button>
                <div class="story-record-menu">
                    <button class="story-record-menu-item" data-act="rename">重命名</button>
                    <button class="story-record-menu-item" data-act="pin">${s.pinned ? '取消置顶' : '置顶'}</button>
                    <div class="story-record-menu-divider"></div>
                    <button class="story-record-menu-item danger" data-act="del">删除</button>
                </div>`;
            item.querySelector('.story-record-info').addEventListener('click', () => this._loadSession(s.id));
            item.querySelector('.story-record-menu-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleMenu(item, s);
            });
            list.appendChild(item);
        });
    },

    _toggleMenu(itemEl, session) {
        const menu = itemEl.querySelector('.story-record-menu');
        const isOpen = menu.classList.contains('show');
        this._closeMenu();
        if (isOpen) return;
        menu.classList.add('show');
        this._openMenu = { el: menu, session };
        menu.querySelector('[data-act="rename"]').onclick = () => this._renameSession(session);
        menu.querySelector('[data-act="pin"]').onclick = () => {
            this._closeMenu();
            session.pinned = !session.pinned;
            this._persist(); this._renderRecords();
        };
        menu.querySelector('[data-act="del"]').onclick = async () => {
            this._closeMenu();
            if (!(await UI.confirm(`确定删除对话「${session.title}」吗？删除后不可恢复。`, { danger: true }))) return;
            this._sessions = this._sessions.filter(x => x.id !== session.id);
            if (this._currentId === session.id) {
                this._currentId = null; this._items = [];
                if (this._sessions.length) {
                    const sorted = [...this._sessions].sort((a, b) =>
                        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
                    this._loadSession(sorted[0].id);
                    return;
                }
            }
            this._persist(); this._renderRecords(); this._renderStored();
        };
    },

    _closeMenu() {
        if (this._openMenu) { this._openMenu.el.classList.remove('show'); this._openMenu = null; }
        document.querySelectorAll('.story-record-menu.show').forEach(m => m.classList.remove('show'));
    },

    async _renameSession(session) {
        this._closeMenu();
        // 复用 UI.confirm 的弹窗风格：用临时行内输入实现
        const name = await this._askText('重命名对话', session.title);
        if (name === null || !name) return;
        session.title = name;
        this._persist(); this._renderRecords();
    },

    /** 简易文本输入弹窗（Promise<string|null>） */
    _askText(title, value = '') {
        return new Promise((resolve) => {
            const mask = document.createElement('div');
            mask.className = 'agent-mask';
            mask.innerHTML = `
                <div class="agent-dialog">
                    <div class="agent-dialog-title"></div>
                    <input class="agent-dialog-input">
                    <div class="agent-dialog-actions">
                        <button class="agent-dialog-btn ghost">取消</button>
                        <button class="agent-dialog-btn primary">确定</button>
                    </div>
                </div>`;
            mask.querySelector('.agent-dialog-title').textContent = title;
            const input = mask.querySelector('.agent-dialog-input');
            input.value = value;
            const close = (val) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
            const submit = () => close(input.value.trim());
            const onKey = (e) => {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter') submit();
            };
            mask.querySelector('.primary').addEventListener('click', submit);
            mask.querySelector('.ghost').addEventListener('click', () => close(null));
            mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
            document.addEventListener('keydown', onKey);
            document.body.appendChild(mask);
            input.focus(); input.select();
        });
    },

    // ================= 消息渲染 =================

    _renderStored() {
        const chat = this._chat;
        if (!chat) return;
        chat.innerHTML = '';
        if (!this._items.length) {
            this._showWelcome();
            return;
        }
        this._welcome.style.display = 'none';
        chat.style.display = '';
        this._main.classList.add('has-chat');
        this._items.forEach(it => {
            if (it.kind === 'user') this._addUserBubble(it.text, false);
            else if (it.kind === 'assistant') this._addAssistantBubble(this._renderMD(it.text), false);
            else if (it.kind === 'tool') {
                this._addToolChip(it.name, this._displayArgs(it), it.result);
                if (it.name === 'write_file' && it.args && it.args.path) this._addFileCard(it.args.path);
            }
        });
        this._scrollBottom(true);
    },

    _showWelcome() {
        this._welcome.style.display = '';
        this._chat.style.display = 'none';
        this._main.classList.remove('has-chat');
    },

    _addUserBubble(text, animate = true) {
        const chat = this._chat;
        const div = document.createElement('div');
        div.className = 'story-msg story-msg-user agent-msg';
        if (!animate) div.style.animation = 'none';
        div.innerHTML = `
            <div class="story-msg-avatar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
            <div class="story-msg-bubble-wrap"><div class="story-msg-bubble"></div></div>`;
        div.querySelector('.story-msg-bubble').textContent = text;
        chat.appendChild(div);
        this._scrollBottom();
    },

    _addAssistantBubble(html = '', animate = true) {
        const chat = this._chat;
        const div = document.createElement('div');
        div.className = 'story-msg story-msg-ai agent-msg';
        if (!animate) div.style.animation = 'none';
        div.innerHTML = `
            <div class="story-msg-avatar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M9.5 17h5"/></svg>
            </div>
            <div class="story-msg-bubble-wrap"><div class="story-msg-bubble"><div class="story-msg-content agent-md"></div></div></div>`;
        const content = div.querySelector('.agent-md');
        content.innerHTML = html;
        chat.appendChild(div);
        this._scrollBottom();
        return content;
    },

    _addToolChip(name, argsText, resultText = '') {
        const chat = this._chat;
        const chip = document.createElement('div');
        chip.className = 'agent-tool-chip';
        chip.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            <b>${this._escape(name)}</b> <span class="args">${this._escape(argsText)}</span>`;
        if (resultText) {
            const r = document.createElement('div');
            r.className = 'result';
            r.textContent = '↳ ' + resultText;
            chip.appendChild(r);
        }
        chat.appendChild(chip);
        this._scrollBottom();
        return chip;
    },

    _addErrorChip(text) {
        const chat = this._chat;
        const chip = document.createElement('div');
        chip.className = 'agent-error-chip';
        chip.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <span></span>`;
        chip.querySelector('span').textContent = text;
        chat.appendChild(chip);
        this._scrollBottom();
    },

    _addFileCard(path) {
        const chat = this._chat;
        const name = String(path).split('/').pop().split('\\').pop();
        const card = document.createElement('div');
        card.className = 'agent-file-card';
        card.innerHTML = `
            <span class="fc-icon">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>
            </span>
            <div class="fc-info">
                <b>${this._escape(name)}</b>
                <span>${this._escape(path)}</span>
            </div>
            <div class="fc-ops">
                <button class="fc-btn fc-open">预览</button>
                <button class="fc-btn fc-save">另存</button>
            </div>`;
        card.querySelector('.fc-open').addEventListener('click', () => this._previewFile(path));
        card.querySelector('.fc-save').addEventListener('click', () => {
            UI.downloadFile(this.BASE + '/api/download?path=' + encodeURIComponent(path), name);
        });
        chat.appendChild(card);
        this._scrollBottom();
    },

    // ================= 产物预览 =================

    async _previewFile(path) {
        const name = String(path).split('/').pop().split('\\').pop();
        const mask = document.createElement('div');
        mask.className = 'agent-mask';
        mask.innerHTML = `
            <div class="agent-fileview">
                <div class="fv-head">
                    <b class="fv-name"></b>
                    <div class="fv-ops">
                        <button class="fc-btn fv-save">另存</button>
                        <button class="fc-btn fv-close">关闭</button>
                    </div>
                </div>
                <div class="fv-body"><div class="fv-loading">加载中…</div></div>
            </div>`;
        mask.querySelector('.fv-name').textContent = name;
        const close = () => mask.remove();
        mask.querySelector('.fv-close').addEventListener('click', close);
        mask.querySelector('.fv-save').addEventListener('click', () => {
            UI.downloadFile(this.BASE + '/api/download?path=' + encodeURIComponent(path), name);
        });
        mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
        document.body.appendChild(mask);
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
        });

        const body = mask.querySelector('.fv-body');
        try {
            const r = await (await fetch(this.BASE + '/api/file?path=' + encodeURIComponent(path))).json();
            body.innerHTML = '';
            if (!r.ok) {
                body.innerHTML = `<div class="fv-loading">${this._escape(r.message || '加载失败')}</div>`;
                return;
            }
            const raw = this.BASE + r.raw_url;
            if (r.kind === 'image') {
                body.innerHTML = `<img class="fv-img" src="${raw}" alt="${this._escape(name)}">`;
            } else if (r.kind === 'video') {
                body.innerHTML = `<video class="fv-video" src="${raw}" controls></video>`;
            } else if (r.kind === 'binary') {
                body.innerHTML = `<div class="fv-loading">二进制文件，请使用「另存」下载查看</div>`;
            } else if (r.ext === '.md') {
                body.innerHTML = `<div class="fv-md agent-md">${this._renderMD(r.content || '')}</div>`;
            } else {
                body.innerHTML = `<pre class="fv-text">${this._escape(r.content || '')}</pre>`;
            }
        } catch (e) {
            body.innerHTML = `<div class="fv-loading">加载失败：${this._escape(e.message)}</div>`;
        }
    },

    // ================= 附件上传 =================

    async _uploadFiles(files) {
        this._fileInput.value = '';
        for (const f of files) {
            const chip = document.createElement('span');
            chip.className = 'agent-attach-chip uploading';
            chip.innerHTML = `<span class="agent-spin"></span><span class="a-name">${this._escape(f.name)}</span>`;
            this._attachRow.appendChild(chip);
            try {
                const r = await fetch(`${this.BASE}/api/upload?filename=${encodeURIComponent(f.name)}`, {
                    method: 'POST', body: f
                });
                const res = await r.json();
                if (res.ok) {
                    const item = { name: res.name, path: res.path };
                    this._pendingFiles.push(item);
                    chip.classList.remove('uploading');
                    chip.innerHTML = `<span class="a-name">${this._escape(res.name)}</span><button title="移除">×</button>`;
                    chip.querySelector('button').addEventListener('click', () => {
                        this._pendingFiles = this._pendingFiles.filter(x => x !== item);
                        chip.remove();
                    });
                } else {
                    chip.remove();
                    UI.toast(res.message || '上传失败', 'error');
                }
            } catch {
                chip.remove();
                UI.toast('上传失败，Agent 服务可能未启动', 'error');
            }
        }
    },

    // ================= 服务状态 =================

    async _checkStatus(retries = 8) {
        const el = document.getElementById('agentStatus');
        const txt = document.getElementById('agentStatusText');
        for (let i = 0; i < retries; i++) {
            try {
                const r = await fetch(this.BASE + '/api/config', { signal: AbortSignal.timeout(2500) });
                const cfg = await r.json();
                el.classList.remove('connecting');
                el.classList.add('ok');
                txt.textContent = cfg.has_key ? 'Agent 服务已连接' : '服务已连接，但尚未配置 API Key';
                return true;
            } catch {
                await new Promise(res => setTimeout(res, 1500));
            }
        }
        el.classList.remove('connecting');
        el.classList.add('down');
        txt.textContent = 'Agent 服务未启动，请重启 AI Studio';
        return false;
    },

    // ================= 发送与流式接收 =================

    _setBusy(v) {
        this._busy = v;
        this._sendBtn.disabled = v;
        this._sendBtn.classList.toggle('loading', v);
    },

    async send() {
        let text = this._input.value.trim();
        if ((!text && !this._pendingFiles.length) || this._busy) return;
        // Agent 与 AI Studio 共用同一 API：未配置则拦截
        const creds = this._aiStudioCreds();
        if (!creds.api_key || !creds.base_url || creds.base_url === '/v1') {
            UI.toast('请先在顶部设置中配置 API 地址和 Key（Agent 对话使用同一 API）', 'error', 6000);
            return;
        }
        if (this._pendingFiles.length) {
            text += (text ? '\n\n' : '') + this._pendingFiles
                .map(f => `[附件] ${f.name}（已保存到 ${f.path}，可用 read_file 工具读取）`)
                .join('\n');
            this._pendingFiles = [];
            this._attachRow.innerHTML = '';
        }
        if (!text) return;
        this._input.value = '';
        this._autoResize();

        if (!this._current()) this.newChat();
        this._welcome.style.display = 'none';
        this._chat.style.display = '';
        this._main.classList.add('has-chat');

        this._addUserBubble(text);
        this._items.push({ kind: 'user', text });
        this._touch();

        this._setBusy(true);
        let bubble = this._addAssistantBubble('<span class="agent-cursor">▍</span>');
        let hasContent = false;
        let acc = '';
        let lastRender = 0;
        let pendingTool = null;
        let errored = false;

        const paint = () => {
            bubble.innerHTML = this._renderMD(acc) + '<span class="agent-cursor">▍</span>';
            if (acc) hasContent = true;
            this._scrollBottom();
        };
        // 把当前积累的回答段固化：存入时间线 + 新开一个气泡承接后续输出
        const flushAssistant = () => {
            if (!acc) return;
            this._items.push({ kind: 'assistant', text: acc });
            bubble.innerHTML = this._renderMD(acc);
            hasContent = true;
            acc = '';
        };
        const removeBubbleIfEmpty = () => {
            if (!hasContent && !acc) bubble.closest('.story-msg').remove();
        };

        try {
            // 发给接口的只有 user / assistant 两种角色，tool 条目不参与
            const apiMsgs = this._items
                .filter(it => it.kind === 'user' || it.kind === 'assistant')
                .map(it => ({ role: it.kind, content: it.text }));
            const res = await fetch(this.BASE + '/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: apiMsgs, ...creds })
            });
            if (!res.ok || !res.body) throw new Error('Agent 服务请求失败 HTTP ' + res.status);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const line of frame.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const data = line.slice(5).trim();
                        if (data === '[DONE]') continue;
                        let ev;
                        try { ev = JSON.parse(data); } catch { continue; }

                        if (ev.type === 'delta') {
                            acc += ev.content;
                            const now = Date.now();
                            if (now - lastRender > 50) { lastRender = now; paint(); }
                        } else if (ev.type === 'tool_call') {
                            flushAssistant();
                            pendingTool = { kind: 'tool', name: ev.name, args: ev.args || {}, result: '' };
                            this._items.push(pendingTool);
                            this._addToolChip(ev.name, this._displayArgs(pendingTool));
                            bubble = this._addAssistantBubble('<span class="agent-cursor">▍</span>');
                            hasContent = false;
                        } else if (ev.type === 'tool_result') {
                            if (pendingTool) pendingTool.result = ev.result;
                            if (pendingTool && pendingTool.name === 'write_file' && pendingTool.args && pendingTool.args.path) {
                                this._addFileCard(pendingTool.args.path);
                            }
                            const chips = this._chat.querySelectorAll('.agent-tool-chip');
                            const last = chips[chips.length - 1];
                            if (last && !last.querySelector('.result')) {
                                const r = document.createElement('div');
                                r.className = 'result';
                                r.textContent = '↳ ' + ev.result;
                                last.appendChild(r);
                                this._scrollBottom();
                            }
                        } else if (ev.type === 'error') {
                            errored = true;
                            removeBubbleIfEmpty();
                            this._addErrorChip(ev.content);
                        }
                    }
                }
            }

            flushAssistant();
            if (!hasContent && !acc && !errored) {
                bubble.innerHTML = '（模型没有返回内容）';
            }
        } catch (e) {
            removeBubbleIfEmpty();
            this._addErrorChip(e.message);
        }

        this._touch();
        this._setBusy(false);
        this._scrollBottom();
    },

    _autoResize() {
        const ta = this._input;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    },

    // ================= 初始化 =================

    init() {
        // 事件绑定
        document.getElementById('agentNewBtn').addEventListener('click', () => this.newChat());
        document.getElementById('agentSendBtn').addEventListener('click', () => this.send());
        document.getElementById('agentAttachBtn').addEventListener('click', () => this._fileInput.click());
        this._fileInput.addEventListener('change', () => this._uploadFiles([...this._fileInput.files]));

        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
        });
        this._input.addEventListener('input', () => this._autoResize());

        // 拖拽上传
        ['dragover', 'drop'].forEach(ev =>
            window.addEventListener(ev, (e) => e.preventDefault()));
        const dragTargets = [this._chat, this._input.closest('.story-input-pill')];
        let dragDepth = 0;
        dragTargets.forEach(el => {
            if (!el) return;
            el.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; });
            el.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); });
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                dragDepth = 0;
                const files = [...(e.dataTransfer?.files || [])];
                if (files.length) this._uploadFiles(files);
            });
        });

        // 点击空白关闭记录菜单
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.story-record-menu') && !e.target.closest('.story-record-menu-btn')) {
                this._closeMenu();
            }
        });

        // 恢复会话
        this._load();
        if (this._current()) {
            this._renderRecords();
            this._renderStored();
        } else {
            this.newChat();
            this._renderRecords();
        }

        // 探测后端状态（main.js 正在拉起，稍等片刻）
        this._checkStatus();
    }
};
