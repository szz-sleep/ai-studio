/**
 * AI Studio - 无限画布模块
 * 原生实现（无第三方库），参考 infinite-canvas 的视口模型：
 *   viewport {x, y, k} → world transform: translate(x,y) scale(k)
 * 节点类型：text(提示词) / image(图片) / material(素材库) / video(视频生成)
 * 连线规则（宽松模式）：
 *   text → video（提示词）
 *   image → video（宽松：无 assetId 时生成阶段自动上传临时托管）
 *   material → video（严格：asset:// 引用火山素材库）
 * API：完全复用 AI Studio 当前平台配置（Config / API）
 */

const CanvasModule = {
    get STORAGE_KEY() { return ScopedStore.key('aistudio_canvas_v1'); },          // 旧版单空间数据（仅迁移用）
    get PROJECTS_KEY() { return ScopedStore.key('aistudio_canvas_projects'); },   // 项目索引 [{id,name,createdAt,updatedAt}]
    get PROJECT_CURRENT_KEY() { return ScopedStore.key('aistudio_canvas_current'); },
    PROJECT_POLL_TIMER: null,

    // ===== 状态 =====
    nodes: [],
    edges: [],
    currentProjectId: null,    // 当前打开的项目 id
    viewport: { x: 0, y: 0, k: 1 },
    selection: new Set(),      // 选中的节点 id
    selectedEdge: null,        // 选中的连线 id

    // ===== 交互状态 =====
    _drag: null,               // {type:'node'|'pan'|'select'|'edge', ...}
    _spaceDown: false,
    _tempEdge: null,           // {fromId, wx, wy}
    _undoStack: [],
    _redoStack: [],
    _saveTimer: null,
    _quotaWarned: false,
    _idCounter: 1,

    // ===== DOM 引用 =====
    _viewport: null,
    _world: null,
    _edgesSvg: null,
    _nodesLayer: null,
    _selectBox: null,

    // 模型列表（由 App.loadModels 注入）
    _models: { video: [], image: [], other: [] },
    _clipboard: [],            // Ctrl+C 复制的节点快照

    // 允许的连线：from 类型 → 允许的 to 类型
    // image/audio/video → material：入库通道（素材节点自动上传火山素材库并实时跟踪审核状态）
    // audio/video → video：音频/视频参考生成
    _EDGE_RULES: {
        text: ['video', 'image'],
        image: ['video', 'image', 'material'],
        material: ['video', 'image'],
        audio: ['video', 'material'],
        video: ['video', 'material'],
    },

    // 节点标题/图标
    _META: {
        text:     { title: '提示词' },
        image:    { title: '图片' },
        material: { title: '素材库' },
        audio:    { title: '音频' },
        video:    { title: '视频' },
    },

    // 节点内联 SVG 图标（与 AI Studio 顶栏同款 feather 风格）
    _ICONS: {
        text: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        image: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        material: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
        video: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
        audio: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        zap: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    },

    // ================================================================
    // 初始化
    // ================================================================

    init() {
        this._viewport = document.getElementById('canvasViewport');
        this._world = document.getElementById('canvasWorld');
        this._edgesSvg = document.getElementById('canvasEdgesSvg');
        this._nodesLayer = document.getElementById('canvasNodesLayer');
        if (!this._viewport || !this._world) return;

        this._buildSelectBox();
        this._restore();
        this._bindToolbar();
        this._bindViewport();
        this._bindKeyboard();
        this._bindContextMenu();
        this._bindMinimap();
        this._bindCanvasSettings();
        this._bindProjectPanel();
        // 素材库缓存变化（审核轮询/手动同步）→ 刷新画布内素材状态徽标
        document.addEventListener('aistudio-material-cache', () => this._refreshMaterialBadges());
        this.renderAll();
        this._renderProjects();

        Logger.info('[画布] 初始化完成');
    },

    /** 切到画布页时触发 */
    onShow() {
        // DOM 已就绪，无需特殊处理；预留给未来按需刷新
        this.renderEdges();
        this._minimapSchedule();
        this._renderProjects();
    },

    // ================================================================
    // 全局预览（小地图）：左下角，展示全部节点/连线与当前视口，
    // 点击/拖拽可导航视口
    // ================================================================

    /** rAF 合并调度的小地图重绘 */
    _minimapSchedule() {
        if (this._mmRaf) return;
        this._mmRaf = requestAnimationFrame(() => {
            this._mmRaf = null;
            this._renderMinimap();
        });
    },

    _bindMinimap() {
        this._mmWrap = document.getElementById('canvasMinimap');
        this._mmBody = document.getElementById('canvasMinimapBody');
        this._mmCanvas = document.getElementById('canvasMinimapCanvas');
        this._mmRect = document.getElementById('canvasMinimapRect');
        if (!this._mmBody || !this._mmCanvas) return;

        // 点击/拖拽小地图：把视口中心移到对应世界坐标
        const panTo = (e) => {
            if (!this._mmView) return;
            const rect = this._mmBody.getBoundingClientRect();
            const v = this._mmView;
            const wx = v.minX + (e.clientX - rect.left - v.ox) / v.scale;
            const wy = v.minY + (e.clientY - rect.top - v.oy) / v.scale;
            this.viewport.x = this._viewport.clientWidth / 2 - wx * this.viewport.k;
            this.viewport.y = this._viewport.clientHeight / 2 - wy * this.viewport.k;
            this._applyViewport();
        };
        this._mmBody.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { this._mmBody.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            panTo(e);
            const move = (ev) => panTo(ev);
            const up = () => {
                this._mmBody.removeEventListener('pointermove', move);
                this._mmBody.removeEventListener('pointerup', up);
                this.save();
            };
            this._mmBody.addEventListener('pointermove', move);
            this._mmBody.addEventListener('pointerup', up);
        });

        // 折叠/展开
        document.getElementById('canvasMinimapToggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._mmWrap.classList.toggle('collapsed');
            if (!this._mmWrap.classList.contains('collapsed')) this._minimapSchedule();
        });
    },

    _renderMinimap() {
        if (!this._mmCanvas || !this._mmBody || !this._viewport) return;
        const cw = this._mmBody.clientWidth, ch = this._mmBody.clientHeight;
        if (cw < 10 || ch < 10) return;

        // 当前视口对应的世界矩形
        const k = this.viewport.k;
        const vx = -this.viewport.x / k, vy = -this.viewport.y / k;
        const vw = this._viewport.clientWidth / k, vh = this._viewport.clientHeight / k;

        // 世界范围 = 节点包围盒 ∪ 视口矩形
        let minX = vx, minY = vy, maxX = vx + vw, maxY = vy + vh;
        this.nodes.forEach(n => {
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
            const h = el ? el.offsetHeight : 120;
            minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + h);
        });
        const pad = Math.max(maxX - minX, maxY - minY) * 0.06;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;

        const scale = Math.min(cw / (maxX - minX), ch / (maxY - minY));
        const ox = (cw - (maxX - minX) * scale) / 2;
        const oy = (ch - (maxY - minY) * scale) / 2;
        this._mmView = { minX, minY, scale, ox, oy };
        const toX = x => ox + (x - minX) * scale;
        const toY = y => oy + (y - minY) * scale;

        // Canvas 绘制（DPR 适配）
        const dpr = window.devicePixelRatio || 1;
        const cv = this._mmCanvas;
        if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
            cv.width = Math.round(cw * dpr);
            cv.height = Math.round(ch * dpr);
        }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // 连线
        ctx.strokeStyle = 'rgba(128,128,144,0.45)';
        ctx.lineWidth = 1;
        this.edges.forEach(e => {
            const a = this.getNode(e.from), b = this.getNode(e.to);
            if (!a || !b) return;
            ctx.beginPath();
            ctx.moveTo(toX(a.x + a.w / 2), toY(a.y + 30));
            ctx.lineTo(toX(b.x + b.w / 2), toY(b.y + 30));
            ctx.stroke();
        });

        // 节点（按类型着色，选中高亮）
        const colors = { text: '#94a3b8', image: '#5b9cf6', material: '#f5a623', audio: '#34d399', video: '#a86cf6' };
        this.nodes.forEach(n => {
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
            const h = el ? el.offsetHeight : 120;
            const x = toX(n.x), y = toY(n.y);
            const w = Math.max(3, n.w * scale), hh = Math.max(3, h * scale);
            ctx.fillStyle = colors[n.type] || '#94a3b8';
            ctx.globalAlpha = this.selection.has(n.id) ? 1 : 0.78;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, w, hh, 2); else ctx.rect(x, y, w, hh);
            ctx.fill();
        });
        ctx.globalAlpha = 1;

        // 视口矩形（DOM overlay，便于样式跟随主题）
        if (this._mmRect) {
            this._mmRect.style.left = toX(vx) + 'px';
            this._mmRect.style.top = toY(vy) + 'px';
            this._mmRect.style.width = Math.max(8, vw * scale) + 'px';
            this._mmRect.style.height = Math.max(8, vh * scale) + 'px';
        }
    },

    /** App.loadModels 注入模型分类 */
    setModels(classified) {
        this._models = {
            video: (classified && classified.video) || [],
            image: (classified && classified.image) || [],
            other: (classified && classified.other) || [],
        };
        this.populateVideoModelSelects();
        this.populateImageModelSelects();
    },

    // ================================================================
    // 工具函数
    // ================================================================

    _uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${(this._idCounter++).toString(36)}`;
    },

    _screenToWorld(sx, sy) {
        const rect = this._viewport.getBoundingClientRect();
        return {
            x: (sx - rect.left - this.viewport.x) / this.viewport.k,
            y: (sy - rect.top - this.viewport.y) / this.viewport.k,
        };
    },

    _escape(s) {
        const div = document.createElement('div');
        div.textContent = String(s == null ? '' : s);
        return div.innerHTML;
    },

    /** 撤销/重做各保留 5 步 */
    _HISTORY_MAX: 5,

    _pushHistory() {
        const snap = JSON.stringify({ nodes: this.nodes, edges: this.edges });
        // 与栈顶快照相同则不入栈（避免"点了撤销却看不出变化"的无效步）
        if (this._undoStack.length > 0 && this._undoStack[this._undoStack.length - 1] === snap) return;
        this._undoStack.push(snap);
        while (this._undoStack.length > this._HISTORY_MAX) this._undoStack.shift();
        this._redoStack.length = 0;
    },

    _snapshotNow() {
        return JSON.stringify({ nodes: this.nodes, edges: this.edges });
    },

    undo() {
        if (this._undoStack.length === 0) return;
        // 当前状态入 redo 栈（同样最多保留 5 步）
        this._redoStack.push(this._snapshotNow());
        while (this._redoStack.length > this._HISTORY_MAX) this._redoStack.shift();
        const snap = this._undoStack.pop();
        this._applySnapshot(snap);
    },

    redo() {
        if (this._redoStack.length === 0) return;
        this._undoStack.push(this._snapshotNow());
        const snap = this._redoStack.pop();
        this._applySnapshot(snap);
    },

    _applySnapshot(snap) {
        try {
            const s = JSON.parse(snap);
            this.nodes = s.nodes || [];
            this.edges = s.edges || [];
            this.selection.clear();
            this.selectedEdge = null;
            this.renderAll();
            this.save();
        } catch (e) {
            Logger.error('[画布] 撤销/重做失败: ' + e.message);
        }
    },

    // ===== 持久化（项目库）=====

    /** 项目索引：[{ id, name, createdAt, updatedAt }] */
    _projects() {
        try { return JSON.parse(localStorage.getItem(this.PROJECTS_KEY) || '[]'); }
        catch (e) { return []; }
    },
    _saveProjects(list) {
        localStorage.setItem(this.PROJECTS_KEY, JSON.stringify(list));
    },
    _projectKey(id) { return ScopedStore.key('aistudio_canvas_project_' + id); },
    _newProjectId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    /** 立即落盘当前项目（绕过防抖；切换项目/刷新前调用） */
    _saveNow() {
        clearTimeout(this._saveTimer);
        try {
            const id = this.currentProjectId;
            if (!id) return;
            localStorage.setItem(this._projectKey(id), JSON.stringify({
                nodes: this.nodes,
                edges: this.edges,
                viewport: this.viewport,
            }));
            const list = this._projects();
            const p = list.find(x => x.id === id);
            if (p) {
                p.updatedAt = Date.now();
                p.nodeCount = this.nodes.length;
                this._saveProjects(list);
            }
        } catch (e) {
            if (!this._quotaWarned) {
                this._quotaWarned = true;
                Logger.warn('[画布] 画布保存失败（本地存储空间不足），图片过多时请及时清理');
                UI.toast('画布自动保存失败：本地存储空间不足，图片节点过多时建议同步素材库后删除大图', 'warn', 6000);
            }
        }
    },

    save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveNow(), 300);
    },

    /** 把一份数据套用进当前画布（含中断状态清理、id 计数恢复） */
    _applyLoadedState(s) {
        this.nodes = Array.isArray(s.nodes) ? s.nodes : [];
        this.edges = Array.isArray(s.edges) ? s.edges : [];
        if (s.viewport && typeof s.viewport.k === 'number') this.viewport = s.viewport;
        // 恢复生成中节点为 idle（轮询/长请求不跨会话恢复）
        this.nodes.forEach(n => {
            if (n.type === 'video' && (n.data.status === 'generating' || n.data.status === 'uploading')) {
                n.data.status = 'error';
                n.data.error = '上次会话中断，请重新生成';
            }
            if (n.type === 'image' && (n.data.status === 'generating' || n.data.status === 'uploading')) {
                n.data.status = 'idle';
                n.data.error = '';
            }
        });
        let maxId = 0;
        this.nodes.concat(this.edges).forEach(x => {
            const m = String(x.id || '').match(/_(\w+)$/);
            if (m) maxId++;
        });
        this._idCounter = maxId + 1;
    },

    _restore() {
        try {
            let projects = this._projects();
            if (projects.length === 0) {
                // 迁移：旧版单空间数据 → 「默认项目」
                let legacy = null;
                const raw = localStorage.getItem(this.STORAGE_KEY);
                if (raw) { try { legacy = JSON.parse(raw); } catch (e) { legacy = null; } }
                const id = this._newProjectId();
                projects = [{ id, name: '默认项目', createdAt: Date.now(), updatedAt: Date.now() }];
                localStorage.setItem(this._projectKey(id), JSON.stringify(legacy || { nodes: [], edges: [], viewport: { x: 0, y: 0, k: 1 } }));
                this._saveProjects(projects);
            }
            const curId = localStorage.getItem(this.PROJECT_CURRENT_KEY);
            const current = projects.find(p => p.id === curId) || projects[0];
            this.currentProjectId = current.id;
            localStorage.setItem(this.PROJECT_CURRENT_KEY, current.id);
            const dataRaw = localStorage.getItem(this._projectKey(current.id));
            this._applyLoadedState(dataRaw ? JSON.parse(dataRaw) : { nodes: [], edges: [] });
        } catch (e) {
            Logger.warn('[画布] 恢复画布失败: ' + e.message);
            this.nodes = [];
            this.edges = [];
        }
    },

    // ===== 项目库管理 =====

    /** 切换项目：先落盘当前，再载入目标；清空撤销栈与选区 */
    _loadProject(id) {
        if (!this._projects().find(p => p.id === id)) return;
        if (id === this.currentProjectId) { this._renderProjects(); return; }
        this._saveNow();
        const dataRaw = localStorage.getItem(this._projectKey(id));
        try {
            this._applyLoadedState(dataRaw ? JSON.parse(dataRaw) : { nodes: [], edges: [] });
        } catch (e) {
            Logger.warn('[画布] 项目数据损坏，已重置: ' + e.message);
            this._applyLoadedState({ nodes: [], edges: [] });
        }
        this.currentProjectId = id;
        localStorage.setItem(this.PROJECT_CURRENT_KEY, id);
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this.selection.clear();
        this.selectedEdge = null;
        this._clearEdgeSelect();
        this.renderAll();
        this._renderProjects();
        Logger.info(`[画布] 切换项目: ${id}`);
    },

    _createProject(name) {
        const list = this._projects();
        const used = new Set(list.map(p => p.name));
        if (!name) {
            let i = list.length + 1;
            while (used.has(`项目 ${i}`)) i++;
            name = `项目 ${i}`;
        }
        const p = { id: this._newProjectId(), name, createdAt: Date.now(), updatedAt: Date.now(), nodeCount: 0 };
        list.unshift(p);
        localStorage.setItem(this._projectKey(p.id), JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, k: 1 } }));
        this._saveProjects(list);
        this._loadProject(p.id);
        return p;
    },

    _deleteProject(id) {
        const list = this._projects();
        const p = list.find(x => x.id === id);
        if (!p) return;
        const next = list.filter(x => x.id !== id);
        localStorage.removeItem(this._projectKey(id));
        if (next.length === 0) {
            // 最后一个项目：清空画布而不是删掉
            next.push({ id: this._newProjectId(), name: '默认项目', createdAt: Date.now(), updatedAt: Date.now(), nodeCount: 0 });
            localStorage.setItem(this._projectKey(next[0].id), JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, k: 1 } }));
        }
        this._saveProjects(next);
        if (id === this.currentProjectId) {
            this._loadProject(next[0].id);
        } else {
            this._renderProjects();
        }
    },

    _duplicateProject(id) {
        const list = this._projects();
        const src = list.find(x => x.id === id);
        if (!src) return;
        const dataRaw = localStorage.getItem(this._projectKey(id));
        const copy = {
            id: this._newProjectId(),
            name: src.name + ' 副本',
            createdAt: Date.now(), updatedAt: Date.now(),
            nodeCount: src.nodeCount || 0,
        };
        localStorage.setItem(this._projectKey(copy.id), dataRaw || JSON.stringify({ nodes: [], edges: [] }));
        const idx = list.findIndex(x => x.id === id);
        list.splice(idx + 1, 0, copy);
        this._saveProjects(list);
        this._renderProjects();
    },

    _renameProject(id, name) {
        const list = this._projects();
        const p = list.find(x => x.id === id);
        if (!p) return;
        p.name = (name || '').trim() || p.name;
        p.updatedAt = Date.now();
        this._saveProjects(list);
        this._renderProjects();
    },

    // ===== 项目库面板（右侧悬浮卡片）=====

    _bindProjectPanel() {
        const wrap = document.getElementById('canvasProjects');
        if (!wrap) return;
        this._projectsWrap = wrap;
        const panel = document.getElementById('canvasProjectsPanel');
        const handle = document.getElementById('canvasProjectsHandle');

        handle?.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) this._renderProjects();
        });
        panel?.addEventListener('click', (e) => e.stopPropagation());
        // 点击画布其他区域收起面板
        document.addEventListener('mousedown', (e) => {
            if (wrap.contains(e.target)) return;
            panel?.classList.add('hidden');
        });

        document.getElementById('canvasProjectNewBtn')?.addEventListener('click', () => {
            this._saveNow();
            const p = this._createProject();
            UI.toast(`已创建「${p.name}」`, 'success');
        });
    },

    _renderProjects() {
        const list = document.getElementById('canvasProjectsList');
        if (!list) return;
        // 事件委托绑在持久容器上（列表每次重渲染会重建子元素，
        // 绑在子元素上的 dblclick 会因单击触发的重渲染而失效——重命名 bug 根因）
        if (!list.dataset.delegated) {
            list.dataset.delegated = '1';
            list.addEventListener('dblclick', (e) => {
                const item = e.target.closest?.('.canvas-project-item');
                if (!item || !item.dataset.id) return;
                e.stopPropagation();
                // 双击前单击可能已触发项目切换并重建列表 → 用 id 查当前 DOM 的实时元素
                const live = list.querySelector(`.canvas-project-item[data-id="${item.dataset.id}"] .canvas-project-name`);
                if (live) this._startProjectRename(item.dataset.id, live);
            });
        }
        const projects = this._projects().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (projects.length === 0) {
            list.innerHTML = '<div class="canvas-projects-empty">暂无项目</div>';
            return;
        }
        list.innerHTML = '';
        projects.forEach(p => {
            const item = document.createElement('div');
            item.className = 'canvas-project-item' + (p.id === this.currentProjectId ? ' active' : '');
            item.dataset.id = p.id;

            const info = document.createElement('div');
            info.className = 'canvas-project-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'canvas-project-name';
            nameEl.textContent = p.name;
            nameEl.title = '双击重命名';
            info.appendChild(nameEl);
            const meta = document.createElement('div');
            meta.className = 'canvas-project-meta';
            const d = new Date(p.updatedAt || p.createdAt || Date.now());
            const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            meta.textContent = `${timeStr}${typeof p.nodeCount === 'number' ? ` · ${p.nodeCount} 节点` : ''}`;
            info.appendChild(meta);
            item.appendChild(info);

            const actions = document.createElement('div');
            actions.className = 'canvas-project-actions';
            const mkBtn = (title, svg, fn) => {
                const b = document.createElement('button');
                b.className = 'canvas-project-btn';
                b.title = title;
                b.innerHTML = svg;
                b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
                return b;
            };
            actions.appendChild(mkBtn('复制项目', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
                () => this._duplicateProject(p.id)));
            actions.appendChild(mkBtn('删除项目', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
                async () => {
                    if (await UI.confirm(`确定删除项目「${p.name}」吗？\n其中的画布内容将一并删除。`, { danger: true })) {
                        this._deleteProject(p.id);
                    }
                }));
            item.appendChild(actions);

            // 单击切换项目（280ms 延迟执行，给双击重命名让路）；350ms 内再次点击
            // 同一项目视为双击 → 取消切换、直接进入重命名。不依赖 dblclick 事件：
            // 单击会重建列表，浏览器对换了元素的两次点击不产生 dblclick。
            item.addEventListener('click', (e) => {
                if (e.target.closest('.canvas-project-rename')) return;
                const now = Date.now();
                const last = this._projClick || null;
                if (last && last.id === p.id && now - last.t < 350) {
                    this._projClick = null;
                    clearTimeout(this._projSwitchTimer);
                    const live = list.querySelector(`.canvas-project-item[data-id="${p.id}"] .canvas-project-name`);
                    if (live) this._startProjectRename(p.id, live);
                } else {
                    this._projClick = { id: p.id, t: now };
                    clearTimeout(this._projSwitchTimer);
                    this._projSwitchTimer = setTimeout(() => {
                        this._projClick = null;
                        this._loadProject(p.id);
                    }, 280);
                }
            });
            list.appendChild(item);
        });
    },

    /** 项目名称行内重命名（由容器级 dblclick 委托触发，nameEl 为当前 DOM 中的实时元素） */
    _startProjectRename(id, nameEl) {
        const p = this._projects().find(x => x.id === id);
        if (!p || !nameEl.isConnected) return;
        const info = nameEl.parentElement;
        if (!info || info.querySelector('input')) return;
        const input = document.createElement('input');
        input.className = 'canvas-project-rename';
        input.value = p.name;
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = () => {
            if (!input.isConnected) return; // Enter 直接提交后再触发 blur 时防重复
            input.removeEventListener('blur', commit);
            this._renameProject(p.id, input.value);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') commit();
            if (ev.key === 'Escape') { input.removeEventListener('blur', commit); this._renderProjects(); }
        });
    },

    // ================================================================
    // 节点增删
    // ================================================================

    addNode(type, wx, wy, data) {
        this._pushHistory();
        const defaults = {
            w: type === 'video' ? 320 : type === 'text' ? 240 : type === 'audio' ? 260 : 260,
        };
        const base = {
            id: this._uid(type),
            type,
            x: Math.round(wx - defaults.w / 2),
            y: Math.round(wy - 40),
            w: defaults.w,
            h: 0,
            data: {},
        };
        if (type === 'text') base.data = { text: '' };
        if (type === 'image') {
            base.data = {
                url: '', name: '', assetId: null,
                model: '', promptOwn: '', ratio: '1:1', resolution: '720P',
                status: 'idle', error: '',
            };
            // 新建图片节点默认用工具栏下方图片模型（若已加载）
            if (this._models.image.length > 0) base.data.model = this._models.image[0].id;
        }
        if (type === 'material') base.data = { assetId: '', url: '', name: '', mtype: 'image' };
        if (type === 'audio') {
            base.data = {
                url: '', name: '', assetId: null,
                status: 'idle', error: '',
            };
        }
        if (type === 'video') {
            base.data = {
                model: '', ratio: '16:9', resolution: '720p', duration: 5, fps: 30,
                status: 'idle', progress: 0, videoUrl: '', error: '',
            };
            // 新建视频节点默认用工具栏选择的模型
            const toolbarModel = document.getElementById('canvasModel')?.value;
            if (toolbarModel) base.data.model = toolbarModel;
        }
        base.data = Object.assign(base.data, data || {});
        this.nodes.push(base);
        this.renderAll();
        this.save();
        return base;
    },

    deleteNodes(ids) {
        const idSet = new Set(ids);
        if (idSet.size === 0) return;
        this._pushHistory();
        this.nodes = this.nodes.filter(n => !idSet.has(n.id));
        this.edges = this.edges.filter(e => !idSet.has(e.from) && !idSet.has(e.to));
        this.selection.clear();
        this.renderAll();
        this.save();
    },

    duplicateNode(id) {
        const src = this.nodes.find(n => n.id === id);
        if (!src) return;
        this._pushHistory();
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = this._uid(copy.type);
        copy.x += 30;
        copy.y += 30;
        if (copy.type === 'video') { copy.data.status = 'idle'; copy.data.videoUrl = ''; copy.data.error = ''; copy.data.progress = 0; }
        this.nodes.push(copy);
        this.selection = new Set([copy.id]);
        this.renderAll();
        this.save();
    },

    deleteEdge(edgeId) {
        if (!this.edges.find(e => e.id === edgeId)) return;
        this._pushHistory();
        this.edges = this.edges.filter(e => e.id !== edgeId);
        this.selectedEdge = null;
        this.renderEdges();
        this.save();
    },

    getNode(id) { return this.nodes.find(n => n.id === id); },

    /** 上游邻居（按连线方向：from → to，取 node 的上游） */
    upstream(id) {
        return this.edges
            .filter(e => e.to === id)
            .map(e => this.getNode(e.from))
            .filter(Boolean);
    },

    // ================================================================
    // 渲染
    // ================================================================

    renderAll() {
        this.renderNodes();
        this.renderEdges();
        this._renderSelection();
        this._updateZoomLabel();
        this._minimapSchedule();
    },

    renderNodes() {
        const layer = this._nodesLayer;
        const alive = new Set(this.nodes.map(n => n.id));
        // 移除已删除的节点 DOM
        Array.from(layer.children).forEach(el => {
            if (el.classList && el.classList.contains('cnode') && !alive.has(el.dataset.id)) el.remove();
        });
        this.nodes.forEach(n => this._renderNode(n));
        // 保持选中节点在最上层
        this.selection.forEach(id => {
            const el = layer.querySelector(`.cnode[data-id="${id}"]`);
            if (el) layer.appendChild(el);
        });
    },

    _renderNode(n) {
        let el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
        const isNew = !el;
        if (isNew) {
            el = document.createElement('div');
            el.className = 'cnode';
            el.dataset.id = n.id;
            el.dataset.type = n.type;
            this._nodesLayer.appendChild(el);
        }
        const meta = this._META[n.type];
        el.className = `cnode cnode-${n.type}` + (this.selection.has(n.id) ? ' selected' : '');
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';
        el.style.width = n.w + 'px';

        // 只在新建或类型内容差异大时全量重建 body；平时只更新需要动态的片段
        if (isNew) {
            el.dataset.mtype = n.data.mtype || 'image';
            el.innerHTML = this._nodeBodyHTML(n);
            this._bindNodeEvents(el, n);
            // 视频节点创建时立即填充模型下拉（模型可能在节点创建前就已加载完成）
            if (n.type === 'video') {
                const sel = el.querySelector('.cnode-video-model');
                if (sel) {
                    this._fillModelSelect(sel);
                    if (n.data.model && sel.querySelector(`option[value="${CSS.escape(n.data.model)}"]`)) {
                        sel.value = n.data.model;
                    }
                }
            }
            // 图片节点创建时立即填充生图模型下拉
            if (n.type === 'image') {
                const sel = el.querySelector('.cnode-image-model');
                if (sel) {
                    this._fillImageModelSelect(sel);
                    if (n.data.model && sel.querySelector(`option[value="${CSS.escape(n.data.model)}"]`)) {
                        sel.value = n.data.model;
                    }
                }
            }
        }
        // 素材节点内容类型变化（接入图片/视频/音频切换）时全量重建 body（预览分支不同）
        if (n.type === 'material' && el.dataset.mtype !== (n.data.mtype || 'image')) {
            el.dataset.mtype = n.data.mtype || 'image';
            el.innerHTML = this._nodeBodyHTML(n);
            this._bindNodeEvents(el, n);
        }
        // 动态更新视频节点状态区
        if (n.type === 'video') this._updateVideoNodeStatus(el, n);
        // 动态更新图片节点状态区
        if (n.type === 'image') this._updateImageNodeStatus(el, n);
        // 参数折叠区状态同步（撤销/重做/恢复后 body 不重建，需要手动对齐）
        if (n.type === 'image' || n.type === 'video') this._applyNodeOpts(el, n);
        // 撤销/重做/恢复后：把节点数据同步回 DOM 输入控件（body 不会重建）
        if (n.type === 'image') {
            const ta = el.querySelector('.cnode-image-prompt');
            if (ta && ta.value !== (n.data.promptOwn || '')) ta.value = n.data.promptOwn || '';
            const pairs = [
                ['.cnode-img-ratio', n.data.ratio],
                ['.cnode-img-res', n.data.resolution],
            ];
            pairs.forEach(([selCls, val]) => {
                const sel = el.querySelector(selCls);
                if (sel && val && sel.value !== String(val)) sel.value = String(val);
            });
            const mSel = el.querySelector('.cnode-image-model');
            if (mSel && n.data.model && mSel.value !== n.data.model
                && mSel.querySelector(`option[value="${CSS.escape(n.data.model)}"]`)) {
                mSel.value = n.data.model;
            }
        }
        if (n.type === 'text') {
            const ta = el.querySelector('.cnode-text-input');
            if (ta && ta.value !== n.data.text) ta.value = n.data.text || '';
        }
        if (n.type === 'video') {
            const ta = el.querySelector('.cnode-video-prompt');
            if (ta && ta.value !== (n.data.promptOwn || '')) ta.value = n.data.promptOwn || '';
            const pairs = [
                ['.cnode-p-ratio', n.data.ratio],
                ['.cnode-p-res', n.data.resolution],
            ];
            pairs.forEach(([selCls, val]) => {
                const sel = el.querySelector(selCls);
                if (sel && val && sel.value !== String(val)) sel.value = String(val);
            });
            // 时长滑块/数字输入同步
            const dur = String(this._clampDuration(n.data.duration));
            const dSlider = el.querySelector('.cnode-dur-slider');
            const dNum = el.querySelector('.cnode-dur-num');
            if (dSlider && dSlider.value !== dur) dSlider.value = dur;
            if (dNum && dNum.value !== dur) dNum.value = dur;
            const fpsSel = el.querySelector('.cnode-p-fps');
            if (fpsSel && n.data.fps && fpsSel.value !== String(n.data.fps)) fpsSel.value = String(n.data.fps);
            const mSel = el.querySelector('.cnode-video-model');
            if (mSel && n.data.model && mSel.value !== n.data.model
                && mSel.querySelector(`option[value="${CSS.escape(n.data.model)}"]`)) {
                mSel.value = n.data.model;
            }
        }
        // 图片/素材节点缩略图
        if ((n.type === 'image' || n.type === 'material') && el.querySelector('.cnode-img')) {
            const img = el.querySelector('.cnode-img');
            if (img.dataset.src !== n.data.url) {
                img.src = n.data.url || '';
                img.dataset.src = n.data.url || '';
                el.querySelector('.cnode-img-wrap').classList.toggle('empty', !n.data.url);
            }
            const sub = el.querySelector('.cnode-sub');
            if (sub && sub.textContent !== (n.data.name || '')) sub.textContent = n.data.name || '';
        }
        // 素材节点（视频类型）预览
        if (n.type === 'material' && n.data.mtype === 'video' && el.querySelector('.cnode-mat-video')) {
            const mv = el.querySelector('.cnode-mat-video');
            if (mv.dataset.src !== n.data.url) {
                mv.src = n.data.url || '';
                mv.dataset.src = n.data.url || '';
                mv.style.display = n.data.url ? '' : 'none';
                el.querySelector('.cnode-video-wrap')?.classList.toggle('empty', !n.data.url);
            }
            const sub = el.querySelector('.cnode-sub');
            if (sub && sub.textContent !== (n.data.name || '')) sub.textContent = n.data.name || '';
        }
        // 素材节点（音频类型）预览
        if (n.type === 'material' && n.data.mtype === 'audio' && el.querySelector('.cnode-mat-audio')) {
            const ma = el.querySelector('.cnode-mat-audio');
            if (ma.dataset.src !== n.data.url) {
                ma.src = n.data.url || '';
                ma.dataset.src = n.data.url || '';
                ma.style.display = n.data.url ? '' : 'none';
                el.querySelector('.cnode-audio-wrap')?.classList.toggle('empty', !n.data.url);
            }
            const sub = el.querySelector('.cnode-sub');
            if (sub && sub.textContent !== (n.data.name || '')) sub.textContent = n.data.name || '';
        }
        // 音频节点播放器/名称
        if (n.type === 'audio' && el.querySelector('.cnode-audio-player')) {
            const player = el.querySelector('.cnode-audio-player');
            if (player.dataset.src !== (n.data.url || '')) {
                player.dataset.src = n.data.url || '';
                player.src = n.data.url || '';
            }
            player.style.display = n.data.url ? '' : 'none';
            const wrap = el.querySelector('.cnode-audio-wrap');
            if (wrap) wrap.classList.toggle('empty', !n.data.url);
            const sub = el.querySelector('.cnode-sub');
            if (sub && sub.textContent !== (n.data.name || '')) sub.textContent = n.data.name || '';
        }
        // 素材徽标（含火山审核状态）
        if (n.type === 'image' || n.type === 'material') {
            const badge = el.querySelector('.cnode-lib-badge');
            if (badge) {
                const info = this._libBadgeInfo(n);
                badge.textContent = info.text;
                badge.classList.toggle('ok', info.ok);
                badge.classList.toggle('bad', info.bad);
                badge.classList.toggle('busy', info.busy);
            }
        }
    },

    _nodeBodyHTML(n) {
        const head = (extra) => `
            <div class="cnode-head">
                <span class="cnode-icon">${meta_icon(n.type)}</span>
                <span class="cnode-title">${meta_title(n.type)}</span>
                ${extra || ''}
                <button class="cnode-x" title="删除节点">×</button>
            </div>`;

        const meta = this._ICONS;
        function meta_icon(t) { return meta[t] || '·'; }
        function meta_title(t) { return { text: '提示词', image: '图片', material: '素材库', audio: '音频', video: '视频' }[t] || t; }

        if (n.type === 'text') {
            return `${head()}
                <div class="cnode-body">
                    <textarea class="cnode-text-input" placeholder="输入提示词，连线到视频节点…">${this._escape(n.data.text)}</textarea>
                </div>
                <div class="cnode-port cnode-port-in" data-port="in" title="输入"></div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线"></div>`;
        }

        if (n.type === 'image') {
            return `${head(`<span class="cnode-lib-badge">未入库</span>`)}
                <div class="cnode-body">
                    <div class="cnode-img-wrap empty">
                        <img class="cnode-img" draggable="false" alt="">
                        <div class="cnode-img-placeholder">双击上传图片<br>或拖拽图片文件到画布<br>或展开下方参数直接生成</div>
                    </div>
                    <div class="cnode-sub">${this._escape(n.data.name || '')}</div>
                    ${this._optsToggleHTML(n, '参数与生成')}
                    <textarea class="cnode-image-prompt" rows="2" placeholder="生图提示词（留空则用相连的文本节点）">${this._escape(n.data.promptOwn || '')}</textarea>
                    <select class="cnode-image-model" title="生图模型"><option value="">加载中...</option></select>
                    <div class="cnode-params">
                        <select class="cnode-img-ratio" title="画面比例">
                            <option value="21:9">21:9</option><option value="16:9">16:9</option>
                            <option value="4:3">4:3</option><option value="1:1" selected>1:1</option>
                            <option value="3:4">3:4</option><option value="9:16">9:16</option>
                        </select>
                        <select class="cnode-img-res" title="分辨率">
                            <option value="480P">480P</option><option value="720P" selected>720P</option>
                            <option value="1080P">1080P</option><option value="4K">4K</option>
                        </select>
                        <button class="cnode-btn cnode-img-generate-btn" title="生成图片（有上游图片时为图生图）">${this._ICONS.zap} 生图</button>
                    </div>
                    <div class="cnode-img-status"></div>
                    <div class="cnode-btn-row">
                        <button class="cnode-btn cnode-act-replace" title="从本机选择图片替换">替换图片</button>
                        <button class="cnode-btn cnode-act-sync" title="上传到火山素材库，获得 asset:// 引用">同步素材库</button>
                        <button class="cnode-btn cnode-act-img-download" title="下载当前图片到本地">下载</button>
                    </div>
                    </div>
                </div>
                <div class="cnode-port cnode-port-in" data-port="in" title="接收提示词/参考图"></div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频/图片节点"></div>`;
        }

        if (n.type === 'material') {
            const isVideo = n.data.mtype === 'video';
            const isAudio = n.data.mtype === 'audio';
            return `${head(`<span class="cnode-lib-badge">未入库</span>`)}
                <div class="cnode-body">
                    ${isVideo ? `
                    <div class="cnode-video-wrap mat-video empty">
                        <video class="cnode-mat-video" controls preload="metadata" style="display:none;"></video>
                        <div class="cnode-video-placeholder">视频素材区<br>连线视频节点自动入库</div>
                    </div>` : isAudio ? `
                    <div class="cnode-audio-wrap mat-audio empty">
                        <audio class="cnode-mat-audio" controls preload="metadata" style="display:none;"></audio>
                        <div class="cnode-audio-placeholder">音频素材区<br>连线音频节点自动入库</div>
                    </div>` : `
                    <div class="cnode-img-wrap empty">
                        <img class="cnode-img" draggable="false" alt="">
                        <div class="cnode-img-placeholder">从素材库选择</div>
                    </div>`}
                    <div class="cnode-sub">${this._escape(n.data.name || '')}</div>
                    <div class="cnode-btn-row">
                        <button class="cnode-btn cnode-act-pick">选择素材</button>
                        <button class="cnode-btn cnode-act-matsync" title="把接入素材同步上传到火山素材库（上方徽标实时显示审核状态）">同步素材</button>
                    </div>
                </div>
                <div class="cnode-port cnode-port-in" data-port="in" title="接收图片/视频/音频入库"></div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频/图片节点"></div>`;
        }

        if (n.type === 'audio') {
            return `${head()}
                <div class="cnode-body">
                    <div class="cnode-audio-wrap empty">
                        <audio class="cnode-audio-player" controls preload="metadata" style="display:none;"></audio>
                        <div class="cnode-audio-placeholder">双击上传音频<br>（mp3 / wav / m4a…）<br>连线到视频节点作为参考音频</div>
                    </div>
                    <div class="cnode-sub">${this._escape(n.data.name || '')}</div>
                </div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频节点（参考音频）"></div>`;
        }

        if (n.type === 'video') {
            return `${head()}
                <div class="cnode-body">
                    <div class="cnode-video-result" style="display:none;">
                        <video controls preload="metadata"></video>
                        <div class="cnode-btn-row">
                            <button class="cnode-btn cnode-act-preview">${this._ICONS.search} 查看</button>
                            <button class="cnode-btn cnode-act-download">下载</button>
                        </div>
                    </div>
                    <div class="cnode-video-wrap"><div class="cnode-video-placeholder">双击上传本机视频<br>右键可从素材库选择<br>（可连线到其他视频节点作参考生视频）</div></div>
                    ${this._optsToggleHTML(n, '参数与生成')}
                    <textarea class="cnode-video-prompt" rows="2" placeholder="视频提示词（留空则用相连的文本节点）">${this._escape(n.data.promptOwn || '')}</textarea>
                    <select class="cnode-video-model" title="视频模型"><option value="">加载中...</option></select>
                    <div class="cnode-params">
                        <select class="cnode-p-ratio" title="画面比例">
                            <option value="21:9">21:9</option><option value="16:9" selected>16:9</option>
                            <option value="4:3">4:3</option><option value="1:1">1:1</option><option value="9:16">9:16</option>
                        </select>
                        <select class="cnode-p-res" title="分辨率">
                            <option value="480p">480p</option><option value="720p" selected>720p</option><option value="1080p">1080p</option>
                        </select>
                        <select class="cnode-p-fps" title="帧率">
                            <option value="24">24fps</option><option value="30" selected>30fps</option><option value="60">60fps</option>
                        </select>
                    </div>
                    <div class="cnode-dur-row" title="时长：4~30 秒（普通模型最长 15 秒，30 秒仅 MiniMax-H3 支持）">
                        <input type="range" class="cnode-dur-slider" min="4" max="30" step="1" value="${parseInt(n.data.duration, 10) || 5}">
                        <input type="number" class="cnode-dur-num" min="4" max="30" step="1" value="${parseInt(n.data.duration, 10) || 5}">
                        <span class="cnode-dur-unit">s</span>
                    </div>
                    <div class="cnode-video-status"></div>
                    <button class="cnode-btn cnode-generate-btn">${this._ICONS.zap} 生成视频</button>
                    </div>
                </div>
                <div class="cnode-port cnode-port-in" data-port="in" title="接收图片/素材/音频/视频/文本"></div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频节点（参考视频）"></div>`;
        }
        return head();
    },

    /** 图片/视频节点「参数与生成」折叠区：折叠开关 + 参数容器（打开一个 .cnode-opts） */
    _optsToggleHTML(n, label) {
        const open = !!n.data.optsOpen;
        return `<button class="cnode-opts-toggle${open ? ' open' : ''}" title="展开/收起参数与操作">
                    <span>${label}</span>
                    <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="cnode-opts${open ? ' open' : ''}">`;
    },

    /** 把节点数据的折叠状态同步到 DOM（新建/撤销重做后都会调用） */
    _applyNodeOpts(el, n) {
        if (n.type !== 'image' && n.type !== 'video') return;
        const open = !!n.data.optsOpen;
        el.querySelector('.cnode-opts')?.classList.toggle('open', open);
        el.querySelector('.cnode-opts-toggle')?.classList.toggle('open', open);
    },

    _bindNodeEvents(el, n) {
        const node = () => this.getNode(el.dataset.id);

        // 拖拽移动（头部/body 空白处按下）
        el.addEventListener('mousedown', (e) => {
            const target = e.target;
            if (target.closest('textarea, select, input, button, video, audio, .cnode-port, .cnode-ref-labels')) return;
            e.stopPropagation();
            this._selectNode(el.dataset.id, e.shiftKey || e.ctrlKey || e.metaKey);
            const world = this._screenToWorld(e.clientX, e.clientY);
            this._drag = {
                type: 'node',
                startWx: world.x, startWy: world.y,
                origins: Array.from(this.selection).map(id => {
                    const nn = this.getNode(id);
                    return { id, x: nn.x, y: nn.y };
                }),
                moved: false,
            };
        });

        // 双击：图片节点打开预览（空节点上传）/ 素材节点选择 / 音频节点上传 / 视频节点上传
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('textarea, select, input, button, video, audio')) return;
            const nn = node();
            if (!nn) return;
            // 图片节点：已有图 → 双击打开大图预览（替换图片走卡片左下角的替换按钮）；空节点 → 双击上传
            if (nn.type === 'image') {
                if (nn.data && nn.data.url) this._openImagePreview(nn.data.url);
                else this._pickLocalImage(nn);
            }
            if (nn.type === 'material') this._pickMaterial(nn);
            if (nn.type === 'audio') this._pickLocalAudio(nn);
            if (nn.type === 'video') this._pickLocalVideo(nn);
        });

        // 删除按钮
        el.querySelector('.cnode-x')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteNodes([el.dataset.id]);
        });

        // 错误信息：点击整行复制完整内容（状态行由 innerHTML 重建，故用事件委托绑定在持久容器上）
        el.querySelectorAll('.cnode-video-status, .cnode-img-status').forEach(box => {
            box.addEventListener('mousedown', (e) => {
                if (e.target?.closest?.('.cnode-status-line.error')) e.stopPropagation(); // 防止触发节点拖拽/选框
            });
            box.addEventListener('click', (e) => {
                const line = e.target?.closest?.('.cnode-status-line.error');
                if (!line) return;
                e.stopPropagation();
                const text = line.textContent || '';
                if (!text) return;
                navigator.clipboard.writeText(text).then(
                    () => UI.toast('错误信息已复制到剪贴板', 'success', 2000),
                    () => UI.toast('复制失败，请手动选中复制', 'warn', 2500),
                );
            });
        });

        // 参数折叠开关（图片/视频节点）
        el.querySelector('.cnode-opts-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const nn = node(); if (!nn) return;
            nn.data.optsOpen = !nn.data.optsOpen;
            this._applyNodeOpts(el, nn);
            this.save();
        });

        // 文本输入
        el.querySelector('.cnode-text-input')?.addEventListener('input', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.text = e.target.value;
            this.save();
        });

        // 视频节点参数
        el.querySelector('.cnode-video-prompt')?.addEventListener('input', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.promptOwn = e.target.value;
            this.save();
        });
        el.querySelector('.cnode-video-model')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.model = e.target.value;
            this.save();
        });
        el.querySelector('.cnode-p-ratio')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.ratio = e.target.value; this.save();
        });
        el.querySelector('.cnode-p-res')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.resolution = e.target.value; this.save();
        });
        // 时长：滑块与数字输入双向同步（4~30 秒，对齐 infinite-canvas）
        const durSlider = el.querySelector('.cnode-dur-slider');
        const durNum = el.querySelector('.cnode-dur-num');
        const applyDuration = (v) => {
            const secs = this._clampDuration(v);
            const nn = node(); if (!nn) return;
            nn.data.duration = secs;
            if (durSlider) durSlider.value = secs;
            if (durNum) durNum.value = secs;
            this.save();
        };
        durSlider?.addEventListener('input', (e) => applyDuration(e.target.value));
        durNum?.addEventListener('change', (e) => applyDuration(e.target.value));
        // 兜底：用 Pointer Events 手动接管拖动。
        // 原生 range 在 user-select:none 的节点容器里会出现"点击轨道跳值、按住拖动不跟手"的
        // Chromium 怪癖；手动捕获指针后按横坐标换算数值，任何容器下都能拖。
        durSlider?.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();  // 取消原生拖动/兼容鼠标事件，完全接管
            try { durSlider.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            const rect = durSlider.getBoundingClientRect();
            const min = Number(durSlider.min) || 4, max = Number(durSlider.max) || 30;
            const setFromX = (clientX) => {
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
                applyDuration(Math.round(min + ratio * (max - min)));
            };
            setFromX(e.clientX);
            const onMove = (ev) => setFromX(ev.clientX);
            const onUp = () => {
                durSlider.removeEventListener('pointermove', onMove);
                durSlider.removeEventListener('pointerup', onUp);
                durSlider.removeEventListener('pointercancel', onUp);
            };
            durSlider.addEventListener('pointermove', onMove);
            durSlider.addEventListener('pointerup', onUp);
            durSlider.addEventListener('pointercancel', onUp);
        });
        el.querySelector('.cnode-p-fps')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.fps = parseInt(e.target.value, 10) || 30; this.save();
        });

        // 图片节点生图参数
        el.querySelector('.cnode-image-prompt')?.addEventListener('input', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.promptOwn = e.target.value;
            this.save();
        });
        el.querySelector('.cnode-image-model')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.model = e.target.value;
            this.save();
        });
        el.querySelector('.cnode-img-ratio')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.ratio = e.target.value; this.save();
        });
        el.querySelector('.cnode-img-res')?.addEventListener('change', (e) => {
            const nn = node(); if (!nn) return;
            nn.data.resolution = e.target.value; this.save();
        });
        el.querySelector('.cnode-img-generate-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generateImage(el.dataset.id);
        });

        // 生成按钮
        el.querySelector('.cnode-generate-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generateVideo(el.dataset.id);
        });

        // 视频结果按钮
        el.querySelector('.cnode-act-preview')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const nn = node();
            if (nn?.data.videoUrl) UI.previewVideo(nn.data.videoUrl);
        });
        el.querySelector('.cnode-act-download')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const nn = node();
            if (nn?.data.videoUrl) UI.downloadFile(nn.data.videoUrl, `canvas-video-${Date.now()}.mp4`);
        });

        // 图片/素材操作按钮
        el.querySelector('.cnode-act-replace')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._pickLocalImage(node());
        });
        el.querySelector('.cnode-act-sync')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this._syncImageToLib(node());
        });
        el.querySelector('.cnode-act-pick')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._pickMaterial(node());
        });
        // 素材节点「同步素材」：以当前接入素材为准刷新并上传到火山素材库
        el.querySelector('.cnode-act-matsync')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._syncMaterial(node());
        });

        // 图片节点下载
        el.querySelector('.cnode-act-img-download')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const nn = node();
            if (!nn?.data.url) { UI.toast('该节点还没有图片', 'warn'); return; }
            const name = (nn.data.name && !nn.data.name.startsWith('data:'))
                ? (nn.data.name.replace(/\.[a-z0-9]+$/i, '') || 'canvas-image') + '-canvas.png'
                : `canvas-image-${Date.now()}.png`;
            UI.downloadFile(nn.data.url, name);
        });

        // 端口：拖出连线
        el.querySelectorAll('.cnode-port-out').forEach(port => {
            port.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this._tempEdge = { fromId: el.dataset.id, wx: 0, wy: 0 };
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._tempEdge.wx = world.x;
                this._tempEdge.wy = world.y;
                this._edgesSvg.classList.add('drawing');
            });
        });
    },

    _updateVideoNodeStatus(el, n) {
        this.renderEdges();   // 连线跟随生成状态（蚂蚁线/完成实线）
        const statusEl = el.querySelector('.cnode-video-status');
        const btn = el.querySelector('.cnode-generate-btn');
        const resultEl = el.querySelector('.cnode-video-result');
        if (!statusEl) return;

        const videoEl = resultEl?.querySelector('video');
        const phEl = el.querySelector('.cnode-video-wrap');
        if (n.data.videoUrl && videoEl && videoEl.dataset.src !== n.data.videoUrl) {
            videoEl.src = n.data.videoUrl;
            videoEl.dataset.src = n.data.videoUrl;
            resultEl.style.display = '';
            if (phEl) phEl.style.display = 'none';
        } else if (!n.data.videoUrl && resultEl) {
            resultEl.style.display = 'none';
            if (phEl) phEl.style.display = '';
        }

        let html = '';
        let busy = false;
        if (n.data.status === 'uploading') {
            busy = true;
            html = `<div class="cnode-status-line uploading">上传素材中 ${n.data.progress || 0}%</div><div class="cnode-progress"><div style="width:${n.data.progress || 0}%"></div></div>`;
        } else if (n.data.status === 'generating') {
            busy = true;
            html = `<div class="cnode-status-line generating">${this._escape(n.data.statusText || '视频生成中...')} ${n.data.progress ? n.data.progress + '%' : ''}</div><div class="cnode-progress"><div style="width:${n.data.progress || 0}%"></div></div>`;
        } else if (n.data.status === 'error') {
            html = `<div class="cnode-status-line error" title="点击复制完整错误信息">${this._escape(n.data.error || '生成失败')}</div>`;
        } else if (n.data.status === 'done') {
            html = `<div class="cnode-status-line ok">✓ 生成完成（${this._escape(n.data.model || '')}）</div>`;
        }
        statusEl.innerHTML = html;
        // 生成中/出错时自动展开参数区，让进度与错误信息可见
        if (busy || n.data.status === 'error') {
            const opts = el.querySelector('.cnode-opts');
            if (opts && !opts.classList.contains('open')) {
                n.data.optsOpen = true;
                this._applyNodeOpts(el, n);
            }
        }
        if (btn) {
            btn.disabled = busy;
            btn.innerHTML = busy ? '生成中...' : `${this._ICONS.zap} 生成视频`;
        }
    },

    /** 把当前模型列表生成为下拉选项 HTML */
    _fillModelSelect(sel) {
        const opts = [];
        if (this._models.video.length > 0) {
            this._models.video.forEach(m => opts.push(`<option value="${this._escape(m.id)}">${this._escape(m.id)}</option>`));
        }
        if (this._models.other.length > 0) {
            opts.push(`<optgroup label="其他模型（部分可能不支持）">`);
            this._models.other.forEach(m => opts.push(`<option value="${this._escape(m.id)}">${this._escape(m.id)}</option>`));
            opts.push(`</optgroup>`);
        }
        if (opts.length === 0) opts.push('<option value="">无可用模型</option>');
        sel.innerHTML = opts.join('');
    },

    /** 把当前模型列表填充到所有视频节点的模型下拉 */
    populateVideoModelSelects() {
        document.querySelectorAll('.cnode-video-model').forEach(sel => {
            const cur = sel.value;
            this._fillModelSelect(sel);
            if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur;
        });
    },

    /** 填充图片节点的生图模型下拉 */
    _fillImageModelSelect(sel) {
        const opts = [];
        if (this._models.image.length > 0) {
            this._models.image.forEach(m => opts.push(`<option value="${this._escape(m.id)}">${this._escape(m.id)}</option>`));
        } else if (this._models.other.length > 0) {
            opts.push(`<optgroup label="其他模型（部分可能不支持）">`);
            this._models.other.forEach(m => opts.push(`<option value="${this._escape(m.id)}">${this._escape(m.id)}</option>`));
            opts.push(`</optgroup>`);
        }
        if (opts.length === 0) opts.push('<option value="">无可用生图模型</option>');
        sel.innerHTML = opts.join('');
    },

    /** 把模型列表填充到所有图片节点的生图模型下拉 */
    populateImageModelSelects() {
        document.querySelectorAll('.cnode-image-model').forEach(sel => {
            const cur = sel.value;
            this._fillImageModelSelect(sel);
            if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur;
        });
    },

    /** 图片节点实际像素尺寸（复用文生图页的 RESOLUTION_SIZE_MAP） */
    _imageSize(node) {
        try {
            // 与文生图/图生图页统一：模型感知档位计算（gpt-image 走 GPT_IMAGE_TIERS，火山系走标准阶梯）
            if (typeof ImageSize !== 'undefined' && ImageSize.compute) {
                return ImageSize.compute(node.data.model || '', node.data.resolution || '720P', node.data.ratio || '1:1').size;
            }
            return '1920x1920';
        } catch (e) { return '1920x1920'; }
    },

    /** 参考图 → Blob（gpt-image multipart 直传用；支持 dataURI 与公网 URL） */
    async _refToBlob(src, name) {
        try {
            const resp = await fetch(src);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await resp.blob();
        } catch (e) {
            throw new Error(`参考图「${name || '图片'}」获取失败（${e.message}）。gpt-image 需要图片字节本身，请换用本地上传的图片`);
        }
    },

    /** 双击打开图片大图预览（点击/Esc/再次双击关闭） */
    _openImagePreview(url) {
        document.getElementById('cnode-img-lightbox')?.remove();
        const ov = document.createElement('div');
        ov.id = 'cnode-img-lightbox';
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '图片预览';
        img.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.5);';
        ov.appendChild(img);
        ov.addEventListener('click', () => ov.remove());
        ov.addEventListener('dblclick', (e) => { e.stopPropagation(); ov.remove(); });
        const esc = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
        document.body.appendChild(ov);
    },

    /** 视频时长钳制：4~30 秒整数（对齐 infinite-canvas 的 VIDEO_SECONDS_MIN/MAX） */
    _clampDuration(v) {
        const s = Math.floor(Number(v) || 5);
        return Math.max(4, Math.min(30, s));
    },

    _updateImageNodeStatus(el, n) {
        this.renderEdges();   // 连线跟随生成状态（蚂蚁线/完成实线）
        const statusEl = el.querySelector('.cnode-img-status');
        const btn = el.querySelector('.cnode-img-generate-btn');
        if (!statusEl) return;
        let html = '';
        let busy = false;
        if (n.data.status === 'generating') {
            busy = true;
            html = `<div class="cnode-status-line generating">图片生成中...</div>`;
        } else if (n.data.status === 'uploading') {
            busy = true;
            html = `<div class="cnode-status-line uploading">上传参考图中...</div>`;
        } else if (n.data.status === 'error') {
            html = `<div class="cnode-status-line error" title="点击复制完整错误信息">${this._escape(n.data.error || '生成失败')}</div>`;
        }
        statusEl.innerHTML = html;
        // 生成中/出错时自动展开参数区，让进度与错误信息可见
        if (busy || n.data.status === 'error') {
            const opts = el.querySelector('.cnode-opts');
            if (opts && !opts.classList.contains('open')) {
                n.data.optsOpen = true;
                this._applyNodeOpts(el, n);
            }
        }
        if (btn) {
            btn.disabled = busy;
            btn.innerHTML = busy ? '生成中' : `${this._ICONS.zap} 生图`;
        }
    },

    // ================================================================
    // 图片生成（复用 AI Studio 文生图 / 图生图 API 链路）
    // ================================================================

    /**
     * 图片节点生成：
     *  - 无上游参考图 → 文生图 API.generateImage（纯文生图）
     *  - 有上游参考图 → 图生图 API.generateImageEdit（参考图可为 asset:// 引用 / 公网 URL / 自动托管）
     *  - 提示词 = 节点自身提示词 + 相连文本节点
     *  - 结果写回节点图片，可继续连线到视频节点做图生视频
     */
    async generateImage(nodeId) {
        const node = this.getNode(nodeId);
        if (!node || node.type !== 'image') return;
        if (node.data.status === 'generating' || node.data.status === 'uploading') return;

        const el = this._nodesLayer.querySelector(`.cnode[data-id="${nodeId}"]`);
        const modelSel = el?.querySelector('.cnode-image-model');
        const model = (modelSel && modelSel.value) || node.data.model || '';
        if (!model) { UI.toast('没有可用的生图模型，请到设置页检查 API 配置', 'error'); return; }
        node.data.model = model;
        if (modelSel && modelSel.value !== model) modelSel.value = model;

        const ups = this.upstream(nodeId);
        const textNodes = ups.filter(n => n.type === 'text');
        const mediaNodes = ups.filter(n => n.type === 'image' || n.type === 'material');

        const promptParts = [];
        if ((node.data.promptOwn || '').trim()) promptParts.push(node.data.promptOwn.trim());
        textNodes.forEach(t => { if ((t.data.text || '').trim()) promptParts.push(t.data.text.trim()); });
        const prompt = promptParts.join('\n\n');

        if (mediaNodes.length === 0 && !prompt) {
            UI.toast('请先填写生图提示词，或连线文本/图片节点', 'warn');
            return;
        }

        const abort = new AbortController();
        node._abort = abort;
        // 注意：生成开始不清除 done 标志——重新生成时节点仍显示旧图，出线保持原来的彩色线
        const setStatus = (status, extra) => {
            node.data.status = status;
            Object.assign(node.data, extra || {});
            this._updateImageNodeStatus(el, node);
        };

        try {
            // —— 收集参考图（宽松模式，与图生图页面同规则） ——
            // gpt-image 系：multipart 需要图片字节本身，跳过临时图床托管，直接用 dataURI/URL
            const isGptImage = /gpt-image/i.test(model || '');
            const refItems = [];
            for (const m of mediaNodes) {
                if (VideoModule._validAssetId(m.data.assetId)) {
                    refItems.push({ asset: 'asset://' + m.data.assetId, name: m.data.name || '未命名' });
                } else if (m.data.url && m.data.url.startsWith('http')) {
                    refItems.push({ url: m.data.url, name: m.data.name || '未命名' });
                } else if (m.data.url) {
                    refItems.push({ dataUrl: m.data.url, name: m.data.name || '未命名' });
                }
            }
            const refs = [];
            for (const it of refItems) {
                if (it.asset) { refs.push(it.asset); continue; }
                if (it.url) { refs.push(it.url); continue; }
                if (isGptImage) { refs.push(it.dataUrl); continue; }   // multipart 直接取字节，无需托管
                setStatus('uploading');
                const v = await VideoModule._uploadToTempHost(it.dataUrl, it.name);
                if (!v || v.startsWith('data:')) {
                    throw new Error(`参考图「${it.name}」上传公网托管失败，建议同步到素材库后重试`);
                }
                refs.push(v);
            }

            setStatus('generating');
            Logger.req(`[画布] 图片生成: 模型=${model}, 模式=${refs.length > 0 ? (isGptImage ? '图生图-multipart(' + refs.length + '图)' : '图生图(' + refs.length + '图)') : '文生图'}, 尺寸=${this._imageSize(node)}`);

            let result;
            if (refs.length > 0 && isGptImage) {
                // gpt-image 系：multipart 直传参考图文件字节（与图生图页同规则，探测验证唯一生效通道）
                const files = [];
                for (let i = 0; i < refItems.length; i++) {
                    const src = refItems[i].dataUrl || refItems[i].url;
                    if (!src) {
                        throw new Error(`参考图「${refItems[i].name}」是素材库引用，gpt-image 不支持，请重新上传本地图片`);
                    }
                    const blob = await this._refToBlob(src, refItems[i].name);
                    const ext = (blob.type && blob.type.includes('jpeg')) ? 'jpg' : (blob.type && blob.type.includes('webp')) ? 'webp' : 'png';
                    files.push({ blob, name: `canvas-ref-${i + 1}.${ext}` });
                }
                result = await API.generateImageEditMultipart({
                    prompt, model,
                    size: this._imageSize(node),
                    files,
                    ratio: node.data.ratio || '1:1',
                    qualityLabel: node.data.resolution || '720P',
                    signal: abort.signal,
                });
            } else if (refs.length > 0) {
                result = await API.generateImageEdit({
                    prompt, model,
                    size: this._imageSize(node),
                    images: refs,
                    ratio: node.data.ratio || '1:1',
                    qualityLabel: node.data.resolution || '720p',
                    signal: abort.signal,
                });
            } else {
                result = await API.generateImage({
                    prompt, model,
                    size: this._imageSize(node),
                    n: 1,
                    signal: abort.signal,
                });
            }

            const item = result?.data && result.data[0];
            const url = item && (item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : ''));
            if (!url) throw new Error('API 未返回图片数据');

            node.data.url = url;
            node.data.assetId = null;   // 新图未入库
            node.data.name = `生成的图片-${new Date().toLocaleTimeString()}`;
            setStatus('idle', { error: '', done: true });
            this.renderAll();
            this.save();
            UI.toast('图片生成成功！可继续连线到视频节点', 'success');
            Logger.success('[画布] 图片生成完成');
        } catch (err) {
            if (err.name === 'AbortError') {
                setStatus('idle', { error: '' });
                Logger.warn('[画布] 用户取消图片生成');
            } else {
                Logger.error(`[画布] 图片生成失败: ${err.message}`);
                setStatus('error', { error: err.message, progress: 0 });
                UI.toast('图片生成失败: ' + err.message, 'error', 5000);
            }
        } finally {
            node._abort = null;
        }
    },

    // ================================================================
    // 连线渲染
    // ================================================================

    _portPos(nodeId, port) {
        const el = this._nodesLayer.querySelector(`.cnode[data-id="${nodeId}"]`);
        const n = this.getNode(nodeId);
        if (!el || !n) return null;
        const portEl = el.querySelector(port === 'in' ? '.cnode-port-in' : '.cnode-port-out');
        if (portEl) {
            return {
                x: n.x + portEl.offsetLeft + portEl.offsetWidth / 2,
                y: n.y + portEl.offsetTop + portEl.offsetHeight / 2,
            };
        }
        // 没有对应端口（如视频节点只有 in）时回退到边中点
        const h = el.offsetHeight || 120;
        return port === 'in'
            ? { x: n.x, y: n.y + h / 2 }
            : { x: n.x + n.w, y: n.y + h / 2 };
    },

    _edgePath(x1, y1, x2, y2) {
        const dx = Math.max(40, Math.min(200, Math.abs(x2 - x1) * 0.5));
        return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    },

    renderEdges() {
        if (!this._edgesSvg) return;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = this._edgesSvg;
        svg.innerHTML = '';

        const drawEdge = (edge, selected, refHl) => {
            const p1 = this._portPos(edge.from, 'out');
            const p2 = this._portPos(edge.to, 'in');
            if (!p1 || !p2) return;
            const d = this._edgePath(p1.x, p1.y, p2.x, p2.y);
            // 生成状态可视化：生成中=动态蚂蚁线（图=蓝/视频=紫），完成=对应色半透明实线
            // 蚂蚁线只看终点：只有"流向正在生成的节点"的入线才播放动画；
            // 生成中节点自己牵出去的线不出蚂蚁线——若节点仍保留旧成图/成片（status done 或
            // generating 但 videoUrl 尚在 / done 标志未清），出线保持原来的彩色线
            const from = this.getNode(edge.from), to = this.getNode(edge.to);
            let stateCls = '';
            if (to && to.data && (to.data.status === 'generating' || to.data.status === 'uploading')) {
                stateCls = to.type === 'video' ? ' edge-anim-video' : ' edge-anim-image';
            }
            if (!stateCls) {
                for (const n of [from, to]) {
                    if (!n || !n.data) continue;
                    if (n.type === 'video' && (n.data.status === 'done' || (n.data.status === 'generating' && n.data.videoUrl))) { stateCls = ' edge-done-video'; break; }
                    if (n.type === 'image' && n.data.done) { stateCls = ' edge-done-image'; break; }
                }
            }
            // 宽透明命中层
            const hit = document.createElementNS(ns, 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('class', 'canvas-edge-hit');
            hit.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.selectedEdge = edge.id;
                this.selection.clear();
                this._renderSelection();
                this.renderEdges();
            });
            hit.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectedEdge = edge.id;
                this.renderEdges();
                this._showContextMenu(e.clientX, e.clientY, [
                    { label: '删除连线', danger: true, action: () => this.deleteEdge(edge.id) },
                ]);
            });
            svg.appendChild(hit);
            const vis = document.createElementNS(ns, 'path');
            vis.setAttribute('d', d);
            vis.setAttribute('class', 'canvas-edge'
                + (selected ? ' selected' : '')
                + (refHl ? ' edge-ref-hl' : '')
                + stateCls);
            svg.appendChild(vis);
        };

        this.edges.forEach(e => drawEdge(e, this.selectedEdge === e.id, this._refPick && e.from === this._refPick.srcId && e.to === this._refPick.nodeId));

        // 视频节点左侧参考图序号标签（多图参考时可按 图片1/图片2… 在提示词中引用）
        // 图片节点同样支持多图参考，显示 图片1/图片2… 小标
        this.nodes.forEach(n => { if (n.type === 'video' || n.type === 'image') this._updateRefLabels(n); });

        // 临时连线
        if (this._tempEdge) {
            const p1 = this._portPos(this._tempEdge.fromId, 'out');
            if (p1) {
                const vis = document.createElementNS(ns, 'path');
                vis.setAttribute('d', this._edgePath(p1.x, p1.y, this._tempEdge.wx, this._tempEdge.wy));
                vis.setAttribute('class', 'canvas-edge temp');
                svg.appendChild(vis);
            }
        }
    },

    /**
     * 节点左侧的参考素材序号标签：上游媒体 ≥2 个时显示 图片1/音频1/视频1/…（竖向贴左排列），
     * 同类素材按上游顺序编号，与生成接口的参考顺序一致，方便用户在提示词里按序号引用。
     * 视频节点：图片/音频/视频参考；图片节点：仅图片类参考（图片1/图片2…）。
     * 点击标签：对应小标红色高亮 + 连线红色加粗 + 来源节点卡片红色粗边框；再点取消。
     */
    _updateRefLabels(n) {
        const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
        if (!el) return;
        let box = el.querySelector('.cnode-ref-labels');
        const media = this.upstream(n.id).filter(m => {
            if (n.type === 'image') {
                // 图片节点只统计图片类参考（视频/音频素材对图片生成无意义）
                if (m.type === 'material') return !['video', 'audio'].includes(m.data.mtype);
                return m.type === 'image';
            }
            return ['image', 'material', 'audio', 'video'].includes(m.type);
        });
        if (media.length < 2) {
            if (box) box.remove();
            return;
        }
        if (!box) {
            box = document.createElement('div');
            box.className = 'cnode-ref-labels';
            box.dataset.for = n.id; // 标签归属的目标节点，点击高亮时用来匹配 _refPick.nodeId
            el.appendChild(box);
            // 拦截按下事件，避免触发节点的选中/拖拽
            box.addEventListener('mousedown', (e) => e.stopPropagation());
            box.addEventListener('click', (e) => {
                const tag = e.target.closest('.cnode-ref-label');
                if (!tag) return;
                e.stopPropagation();
                const src = this.getNode(tag.dataset.src);
                if (!src) return;
                // 再点同一个标签：取消高亮；否则选中来源节点并红色高亮（小标+连线+卡片）
                if (this._refPick && this._refPick.nodeId === n.id && this._refPick.srcId === src.id) {
                    this._setRefPick(null);
                    return;
                }
                this._selectNode(src.id);
                this._setRefPick({ nodeId: n.id, srcId: src.id });
            });
        }
        const typeNames = { image: '图片', audio: '音频', video: '视频' };
        // 素材节点按内容类型归类：视频/音频类型素材 → 视频/音频，其余 → 图片
        const kindOf = (m) => m.type === 'material'
            ? (m.data.mtype === 'video' ? 'video' : m.data.mtype === 'audio' ? 'audio' : 'image')
            : m.type;
        // 同类素材按上游顺序编号（与生成接口的参考数组顺序一致）
        const counters = { image: 0, audio: 0, video: 0 };
        const sig = media.map(m => m.id).join(',');
        if (box.dataset.sig !== sig) {
            box.dataset.sig = sig;
            box.innerHTML = media.map((m) => {
                const kind = kindOf(m);
                counters[kind]++;
                const label = `${typeNames[kind] || kind}${counters[kind]}`;
                const name = this._escape(m.data.name || '未命名');
                const tip = n.type === 'image'
                    ? `${label}：${name} —— 作为第 ${counters[kind]} 张参考图参与图片生成，点击红色高亮对应素材`
                    : `${label}：${name} —— 在提示词中可用「${label}」引用这个素材`;
                return `<span class="cnode-ref-label" data-src="${m.id}" title="${tip}">${label}</span>`;
            }).join('');
        }
        // 高亮状态（每次都刷新，不依赖 sig）：被点选的标签加红色 active
        box.querySelectorAll('.cnode-ref-label').forEach(tag => {
            tag.classList.toggle('active', !!this._refPick
                && this._refPick.nodeId === n.id
                && tag.dataset.src === this._refPick.srcId);
        });
    },

    /**
     * 设置/清除参考标签点选高亮：
     * _refPick = { nodeId, srcId } —— nodeId 是带小标的目标节点，srcId 是来源节点。
     * 联动三处红色高亮：小标（.cnode-ref-label.active）、连线（.edge-ref-hl）、来源卡片（.ref-pick 红色粗边框）。
     */
    _setRefPick(pick) {
        this._refPick = pick || null;
        this._renderSelection();
        this.renderEdges();
        this._refreshRefLabelActive();
    },

    /** 只刷新小标 .active 状态（_refPick 被其他选中路径清除时，避免标签残留高亮） */
    _refreshRefLabelActive() {
        this._nodesLayer.querySelectorAll('.cnode-ref-labels').forEach(box => {
            const owner = box.dataset.for;
            box.querySelectorAll('.cnode-ref-label').forEach(tag => {
                tag.classList.toggle('active', !!this._refPick
                    && this._refPick.nodeId === owner
                    && tag.dataset.src === this._refPick.srcId);
            });
        });
    },

    /** 判断 from 节点能否连到 to 节点 */    _canConnect(fromId, toId) {
        const from = this.getNode(fromId);
        const to = this.getNode(toId);
        if (!from || !to || from.id === to.id) return false;
        const allowed = this._EDGE_RULES[from.type] || [];
        if (!allowed.includes(to.type)) return false;
        // 去重
        if (this.edges.find(e => e.from === fromId && e.to === toId)) return false;
        // 素材节点只接收 1 个接入节点：一个素材节点对应一个素材，接入后由素材节点上传同步到火山素材库
        if (to.type === 'material' && this.edges.some(e => e.to === toId)) return false;
        // 视频节点最多 1 个文本输入 + 6 个媒体输入
        return true;
    },

    _connect(fromId, toId) {
        if (!this._canConnect(fromId, toId)) {
            const from = this.getNode(fromId), to = this.getNode(toId);
            if (from && to) {
                if (to.type === 'material' && this.edges.some(e => e.to === toId)) {
                    UI.toast('素材库节点只能接入 1 个素材，请先删除原有连线再接入新素材', 'warn', 5000);
                } else {
                    UI.toast(`不支持 ${this._META[from.type]?.title || from.type} → ${this._META[to.type]?.title || to.type} 的连线`, 'warn');
                }
            }
            return;
        }
        this._pushHistory();
        this.edges.push({ id: this._uid('edge'), from: fromId, to: toId });
        // 素材节点入库通道：接入即吸收来源素材内容，未入库自动上传跟踪审核
        const to = this.getNode(toId);
        if (to && to.type === 'material') {
            this._absorbMaterial(to, this.getNode(fromId), true);
        }
        this.renderEdges();
        this.save();
    },

    // ================================================================
    // 视口 / 交互
    // ================================================================

    _applyViewport() {
        this._world.style.transform = `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.k})`;
        this._updateZoomLabel();
        this._minimapSchedule();
    },

    _updateZoomLabel() {
        const el = document.getElementById('canvasZoomLabel');
        if (el) el.textContent = Math.round(this.viewport.k * 100) + '%';
    },

    zoomAt(cx, cy, factor) {
        const rect = this._viewport.getBoundingClientRect();
        const nx = cx - rect.left, ny = cy - rect.top;
        const k2 = Math.min(3, Math.max(0.1, this.viewport.k * factor));
        const ratio = k2 / this.viewport.k;
        this.viewport.x = nx - (nx - this.viewport.x) * ratio;
        this.viewport.y = ny - (ny - this.viewport.y) * ratio;
        this.viewport.k = k2;
        this._applyViewport();
        this.save();
    },

    fitView() {
        if (this.nodes.length === 0) {
            this.viewport = { x: 0, y: 0, k: 1 };
            this._applyViewport();
            return;
        }
        const rect = this._viewport.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.nodes.forEach(n => {
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
            const h = el ? el.offsetHeight : 120;
            minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + h);
        });
        const pad = 60;
        const k = Math.min(1.5, Math.max(0.1, Math.min(
            (rect.width - pad * 2) / (maxX - minX),
            (rect.height - pad * 2) / (maxY - minY)
        )));
        this.viewport.k = k;
        this.viewport.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
        this.viewport.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
        this._applyViewport();
        this.save();
    },

    _bindViewport() {
        const vp = this._viewport;

        // 滚轮缩放（以光标为中心；输入控件上不拦截，保留原生滚动）
        vp.addEventListener('wheel', (e) => {
            if (e.target.closest && e.target.closest('textarea, select')) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            this.zoomAt(e.clientX, e.clientY, factor);
        }, { passive: false });

        vp.addEventListener('mousedown', (e) => {
            // 背景按下：pan / 框选 / 取消连线
            if (e.target.closest('.cnode')) return;
            this._clearEdgeSelect();
            if ((e.shiftKey || e.ctrlKey || e.metaKey) && e.button === 0) {
                // 框选（Shift 或 Ctrl 均可）
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._drag = { type: 'select', startWx: world.x, startWy: world.y };
            } else if (e.button === 0 || e.button === 1) {
                // 拖拽平移
                this._drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.viewport.x, oy: this.viewport.y };
                vp.classList.add('panning');
            }
            if (this._tempEdge) {
                // 点击空白取消连线
                this._tempEdge = null;
                this.renderEdges();
            }
        });

        window.addEventListener('mousemove', (e) => this._onMouseMove(e));
        window.addEventListener('mouseup', (e) => this._onMouseUp(e));

        // 阻止画布内浏览器默认拖拽
        vp.addEventListener('dragover', (e) => e.preventDefault());
        vp.addEventListener('drop', (e) => {
            e.preventDefault();
            this._handleDrop(e);
        });

        // 粘贴图片
        window.addEventListener('paste', (e) => this._handlePaste(e));
    },

    _onMouseMove(e) {
        if (!this._drag) {
            if (this._tempEdge) {
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._tempEdge.wx = world.x;
                this._tempEdge.wy = world.y;
                this.renderEdges();
            }
            return;
        }
        const d = this._drag;
        if (d.type === 'pan') {
            this.viewport.x = d.ox + (e.clientX - d.sx);
            this.viewport.y = d.oy + (e.clientY - d.sy);
            this._applyViewport();
        } else if (d.type === 'node') {
            const world = this._screenToWorld(e.clientX, e.clientY);
            const dx = world.x - d.startWx, dy = world.y - d.startWy;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                // 首次真正移动前记录历史（此刻节点坐标仍为拖动前的原始位置）
                if (!d.moved) { d.moved = true; this._pushHistory(); }
                d.origins.forEach(o => {
                    const nn = this.getNode(o.id);
                    if (nn) {
                        nn.x = Math.round(o.x + dx);
                        nn.y = Math.round(o.y + dy);
                        const el = this._nodesLayer.querySelector(`.cnode[data-id="${o.id}"]`);
                        if (el) { el.style.left = nn.x + 'px'; el.style.top = nn.y + 'px'; }
                    }
                });
                this.renderEdges();
            }
        } else if (d.type === 'select') {
            const world = this._screenToWorld(e.clientX, e.clientY);
            const x = Math.min(d.startWx, world.x), y = Math.min(d.startWy, world.y);
            const w = Math.abs(world.x - d.startWx), h = Math.abs(world.y - d.startWy);
            this._showSelectBox(x, y, w, h);
            d.cur = { x, y, w, h };
        }
    },

    _onMouseUp(e) {
        const d = this._drag;
        this._viewport.classList.remove('panning');
        if (!d) {
            // 连线落下：检测目标节点
            if (this._tempEdge) {
                const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cnode');
                if (targetEl && targetEl.dataset.id !== this._tempEdge.fromId) {
                    this._connect(this._tempEdge.fromId, targetEl.dataset.id);
                } else if (!targetEl && !e.target?.closest?.('.canvas-minimap')) {
                    // 空白处松手：弹出"新建节点并连线"选项（按连线规则过滤类型）
                    const fromId = this._tempEdge.fromId;
                    const from = this.getNode(fromId);
                    const allowed = (from && this._EDGE_RULES[from.type]) || [];
                    if (allowed.length > 0) {
                        const world = this._screenToWorld(e.clientX, e.clientY);
                        const titles = { text: '提示词', image: '图片', material: '素材库', video: '视频', audio: '音频' };
                        this._showContextMenu(e.clientX, e.clientY, allowed.map(t => ({
                            label: t === 'material' && ['image', 'video', 'audio'].includes(from.type)
                                ? '新建「素材库」节点并入库'
                                : `新建「${titles[t]}」节点并连线`,
                            action: () => {
                                if (t === 'material' && from.type === 'image') {
                                    // 图片入库通道：图片节点保留原图，素材节点承接上传与审核状态
                                    this._materializeImage(fromId, world.x, world.y - 20);
                                    return;
                                }
                                if (t === 'material' && from.type === 'video') {
                                    // 视频入库通道：视频节点保留原视频，素材节点承接上传与审核状态
                                    this._materializeVideo(fromId, world.x, world.y - 20);
                                    return;
                                }
                                if (t === 'material' && from.type === 'audio') {
                                    // 音频入库通道：音频节点保留原音频，素材节点承接上传与审核状态
                                    this._materializeAudio(fromId, world.x, world.y - 20);
                                    return;
                                }
                                const n = this.addNode(t, world.x, world.y - 20);
                                this._connect(fromId, n.id);
                            },
                        })));
                    }
                }
                this._tempEdge = null;
                this.renderEdges();
            }
            return;
        }
        this._drag = null;

        if (d.type === 'node' && d.moved) {
            this.save();
        } else if (d.type === 'select' && d.cur) {
            const r = d.cur;
            this._refPick = null; // 框选清除标签点选的高亮
            this._refreshRefLabelActive();
            this.selection.clear();
            this.nodes.forEach(n => {
                const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
                const h = el ? el.offsetHeight : 120;
                if (n.x < r.x + r.w && n.x + n.w > r.x && n.y < r.y + r.h && n.y + h > r.y) {
                    this.selection.add(n.id);
                }
            });
            this._hideSelectBox();
            this.renderNodes();
        }
    },

    // ===== 选择 =====

    _selectNode(id, additive) {
        this._refPick = null; // 普通选中路径清除标签点选高亮（标签点选会在随后重新设置）
        this._refreshRefLabelActive();
        if (additive) {
            if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
        } else {
            this.selection = new Set([id]);
        }
        this._clearEdgeSelect();
        // 只切类名，不重建节点 DOM —— 整体重建会让浏览器认为 mousedown/mouseup 目标
        // 无共同祖先，click/dblclick 事件不再产生（双击上传/双击选中失效的根因）
        this._renderSelection();
    },

    _renderSelection() {
        this._nodesLayer.querySelectorAll('.cnode').forEach(el => {
            el.classList.toggle('selected', this.selection.has(el.dataset.id));
            // 标签点选的来源节点用红色粗边框高亮（_refPick 在其他选中路径中被清除）
            el.classList.toggle('ref-pick', !!this._refPick
                && el.dataset.id === this._refPick.srcId
                && this.selection.has(el.dataset.id));
        });
    },

    _clearEdgeSelect() {
        if (this.selectedEdge) {
            this.selectedEdge = null;
            this.renderEdges();
        }
    },

    // ===== 框选矩形 =====

    _buildSelectBox() {
        this._selectBox = document.createElement('div');
        this._selectBox.className = 'canvas-select-box';
        this._selectBox.style.display = 'none';
        this._world.appendChild(this._selectBox);
    },

    _showSelectBox(x, y, w, h) {
        this._selectBox.style.display = '';
        this._selectBox.style.left = x + 'px';
        this._selectBox.style.top = y + 'px';
        this._selectBox.style.width = w + 'px';
        this._selectBox.style.height = h + 'px';
    },

    _hideSelectBox() { this._selectBox.style.display = 'none'; },

    // ================================================================
    // 键盘
    // ================================================================

    _bindKeyboard() {
        window.addEventListener('keydown', (e) => {
            // 只在画布页激活时响应
            const panel = document.getElementById('tab-canvas');
            if (!panel || !panel.classList.contains('active')) return;
            // 输入控件内不拦截
            const inInput = e.target.closest && e.target.closest('textarea, select, input, [contenteditable]');
            if (e.code === 'Space' && !inInput) {
                this._spaceDown = true;
            }
            if (inInput) return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selection.size > 0) {
                    e.preventDefault();
                    this.deleteNodes(Array.from(this.selection));
                } else if (this.selectedEdge) {
                    e.preventDefault();
                    this.deleteEdge(this.selectedEdge);
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault(); this.undo();
            } else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
                       ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
                e.preventDefault(); this.redo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                this.nodes.forEach(n => this.selection.add(n.id));
                this.renderNodes();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                // 复制选中节点
                if (this.selection.size > 0) {
                    this._clipboard = this.nodes
                        .filter(n => this.selection.has(n.id))
                        .map(n => JSON.parse(JSON.stringify(n)));
                    UI.toast(`已复制 ${this._clipboard.length} 个节点`, 'info', 1500);
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                if (this._clipboard.length > 0) {
                    this._pushHistory();
                    const newIds = [];
                    this._clipboard.forEach(src => {
                        const copy = JSON.parse(JSON.stringify(src));
                        copy.id = this._uid(copy.type);
                        copy.x += 40; copy.y += 40;
                        if (copy.type === 'video') { copy.data.status = 'idle'; copy.data.videoUrl = ''; copy.data.error = ''; copy.data.progress = 0; }
                        if (copy.type === 'image') { copy.data.status = 'idle'; copy.data.error = ''; }
                        this.nodes.push(copy);
                        newIds.push(copy.id);
                    });
                    this.selection = new Set(newIds);
                    this.renderAll();
                    this.save();
                }
            } else if (e.key === 'Escape') {
                this.selection.clear();
                this._clearEdgeSelect();
                this.renderNodes();
                this._hideContextMenu();
            } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); this.fitView();
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') this._spaceDown = false;
        });
    },

    // ================================================================
    // 右键菜单
    // ================================================================

    _buildContextMenu() {
        if (document.getElementById('canvasContextMenu')) return;
        const menu = document.createElement('div');
        menu.id = 'canvasContextMenu';
        menu.className = 'canvas-context-menu hidden';
        document.body.appendChild(menu);
        document.addEventListener('mousedown', (e) => {
            if (!menu.contains(e.target)) this._hideContextMenu();
        }, true);
    },

    _showContextMenu(x, y, items) {
        this._buildContextMenu();
        const menu = document.getElementById('canvasContextMenu');
        menu.innerHTML = '';
        items.forEach(it => {
            if (it === '-') {
                const hr = document.createElement('div');
                hr.className = 'canvas-menu-sep';
                menu.appendChild(hr);
                return;
            }
            const div = document.createElement('div');
            div.className = 'canvas-menu-item' + (it.danger ? ' danger' : '');
            div.textContent = it.label;
            div.addEventListener('click', () => { this._hideContextMenu(); it.action(); });
            menu.appendChild(div);
        });
        menu.classList.remove('hidden');
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
    },

    _hideContextMenu() {
        document.getElementById('canvasContextMenu')?.classList.add('hidden');
    },

    _bindContextMenu() {
        this._viewport.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const nodeEl = e.target.closest('.cnode');
            if (nodeEl) {
                const id = nodeEl.dataset.id;
                const n = this.getNode(id);
                if (!this.selection.has(id)) this._selectNode(id, false);
                const items = [
                    { label: '复制节点', action: () => this.duplicateNode(id) },
                    '-',
                    { label: '删除节点', danger: true, action: () => this.deleteNodes(Array.from(this.selection)) },
                ];
                if (n && n.type === 'image' && !n.data.assetId) {
                    items.unshift({ label: '同步到素材库', action: () => this._syncImageToLib(n) });
                }
                if (n && n.type === 'material') {
                    items.unshift({ label: '重新选择素材', action: () => this._pickMaterial(n) });
                    items.unshift({ label: '同步到素材库', action: () => this._syncMaterial(n) });
                }
                if (n && n.type === 'audio') {
                    items.unshift({ label: '重新选择音频', action: () => this._pickLocalAudio(n) });
                    if (!n.data.assetId) {
                        items.unshift({ label: '同步到素材库', action: () => this._syncAudioToLib(n) });
                    }
                }
                if (n && n.type === 'video') {
                    items.unshift({ label: '从素材库选择视频', action: () => this._pickVideoMaterial(n) });
                    items.unshift({ label: '上传本机视频', action: () => this._pickLocalVideo(n) });
                    if (n.data.videoUrl && !n.data.assetId) {
                        items.unshift({ label: '同步到素材库', action: () => this._syncVideoToLib(n) });
                    }
                }
                this._showContextMenu(e.clientX, e.clientY, items);
            } else {
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._showContextMenu(e.clientX, e.clientY, [
                    { label: '添加提示词节点', action: () => this.addNode('text', world.x, world.y) },
                    { label: '添加图片节点', action: () => this.addNode('image', world.x, world.y) },
                    { label: '从素材库添加', action: () => { const n = this.addNode('material', world.x, world.y); this._pickMaterial(n); } },
                    { label: '添加音频节点', action: () => { const n = this.addNode('audio', world.x, world.y); this._pickLocalAudio(n); } },
                    { label: '添加视频节点', action: () => this.addNode('video', world.x, world.y) },
                    '-',
                    { label: '全选', action: () => { this.nodes.forEach(n => this.selection.add(n.id)); this.renderNodes(); } },
                    { label: '适应画布', action: () => this.fitView() },
                    '-',
                    { label: '清空画布', danger: true, action: () => this.clearAll() },
                ]);
            }
        });
    },

    async clearAll() {
        if (this.nodes.length === 0) return;
        if (!(await UI.confirm('确定清空画布上的所有节点和连线吗？', { danger: true }))) return;
        this._pushHistory();
        this.nodes = [];
        this.edges = [];
        this.selection.clear();
        this.selectedEdge = null;
        this.renderAll();
        this.save();
    },

    // ================================================================
    // 图片 / 素材获取
    // ================================================================

    _pickLocalImage(node) {
        if (!node) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files && input.files[0];
            document.body.removeChild(input);
            if (file) await this._setImageFromFile(node, file);
        };
        input.click();
    },

    _pickLocalAudio(node) {
        if (!node) return;
        // 首选原生对话框（模态、永远置前，规避 input.click() 的手势/焦点兼容问题）；
        // 无 preload 的环境（无头测试）回退到 input.click()
        if (window.electronAPI && typeof window.electronAPI.pickAudio === 'function') {
            window.electronAPI.pickAudio().then(async (r) => {
                if (!r || !r.ok) {
                    if (r && r.error) UI.toast('选择音频失败: ' + r.error, 'error');
                    return;
                }
                await this._applyAudioData(node, `data:${this._audioMime(r.ext)};base64,${r.base64}`, r.name);
            });
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files && input.files[0];
            document.body.removeChild(input);
            if (file) await this._setAudioFromFile(node, file);
        };
        input.click();
    },

    _audioMime(ext) {
        return ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', wma: 'audio/x-ms-wma' })[ext] || 'audio/mpeg';
    },

    /** 音频节点数据落地 + 界面刷新（原生对话框与 file input 两条路径共用） */
    async _applyAudioData(node, dataUrl, name) {
        node.data.url = dataUrl;
        node.data.name = name;
        node.data.assetId = null;
        node.data.error = '';
        this.renderAll();
        this.save();
        Logger.info(`[画布] 音频节点已设置: ${name}`);
    },

    async _setAudioFromFile(node, file) {
        if (!file.type.startsWith('audio/')) {
            UI.toast('只支持音频文件', 'warn');
            return;
        }
        try {
            const dataUrl = await API.fileToBase64(file);
            await this._applyAudioData(node, dataUrl, file.name);
        } catch (e) {
            UI.toast('读取音频失败: ' + e.message, 'error');
        }
    },

    // ---------------- 视频节点：本机上传 / 素材库 / 入库 ----------------

    _pickLocalVideo(node) {
        if (!node) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/mp4,video/webm,video/quicktime,video/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files && input.files[0];
            document.body.removeChild(input);
            if (file) await this._setVideoFromFile(node, file);
        };
        input.click();
    },

    /** 本机视频落地为参考视频（视频生视频）：存为 data URL，参考生成时自动托管转 URL */
    async _setVideoFromFile(node, file) {
        if (!file.type.startsWith('video/')) {
            UI.toast('只支持视频文件（mp4 / webm / mov）', 'warn');
            return;
        }
        if (file.size > 100 * 1024 * 1024) {
            UI.toast('视频超过 100MB，请先压缩后再上传', 'warn');
            return;
        }
        try {
            UI.showLoading('正在读取视频...');
            const dataUrl = await API.fileToBase64(file);
            node.data.videoUrl = dataUrl;
            node.data.name = file.name;
            node.data.assetId = null;
            node.data.status = 'idle';
            node.data.progress = 0;
            node.data.statusText = '';
            node.data.error = '';
            this.renderAll();
            this.save();
            Logger.info(`[画布] 视频节点已设置本机视频: ${file.name}`);
        } catch (e) {
            UI.toast('读取视频失败: ' + e.message, 'error');
        } finally {
            UI.hideLoading();
        }
    },

    /** 视频节点从素材库选择视频（作为参考视频，入库的可走 asset:// 引用） */
    _pickVideoMaterial(node) {
        if (!node) return;
        if (typeof MaterialLib === 'undefined') { UI.toast('素材库模块未加载', 'error'); return; }
        MaterialLib.openPicker((item) => {
            const nn = this.getNode(node.id);
            if (!nn) return;
            nn.data.videoUrl = item.url || item.sourceUrl || '';
            nn.data.assetId = VideoModule._validAssetId(item.id) ? item.id : '';
            nn.data.name = item.name || '素材视频';
            nn.data.status = 'idle';
            nn.data.progress = 0;
            nn.data.statusText = '';
            nn.data.error = '';
            this.renderAll();
            this.save();
            UI.toast('已从素材库选择视频，可连线到其他视频节点作参考', 'success');
            Logger.info(`[画布] 视频节点已选择素材视频: ${nn.data.name} (assetId=${nn.data.assetId || '无'})`);
        }, 'video');
    },

    /** 把视频节点的视频同步到素材库（生成结果/本机视频均可入库复用） */
    async _syncVideoToLib(node) {
        if (!node || !node.data.videoUrl) { UI.toast('请先给视频节点上传或生成视频', 'warn'); return; }
        if (node.data.assetId) { UI.toast('该视频已在素材库中', 'info'); return; }
        try {
            UI.showLoading('正在同步视频到素材库...');
            const resp = await fetch(node.data.videoUrl);
            const blob = await resp.blob();
            const file = new File([blob], node.data.name || `canvas-video-${Date.now()}.mp4`, { type: blob.type || 'video/mp4' });
            const httpUrl = await MaterialLib.uploadFile(file);
            const rec = MaterialLib.getAll().find(i => i.url === httpUrl || i.sourceUrl === httpUrl);
            if (rec && VideoModule._validAssetId(rec.id)) {
                node.data.assetId = rec.id;
                node.data.name = rec.name || node.data.name;
                this.renderAll();
                this.save();
                UI.toast('视频已同步到素材库，参考生成时将用 asset:// 引用', 'success');
                Logger.success(`[画布] 视频已入库: ${rec.id}`);
            } else {
                if (httpUrl && httpUrl.startsWith('http')) node.data.videoUrl = httpUrl;
                this.renderAll();
                this.save();
                UI.toast('视频已上传，火山审核通过后即可用 asset:// 引用（当前仍可宽松模式直接参考）', 'info', 5000);
            }
        } catch (e) {
            UI.toast('同步视频素材库失败: ' + e.message, 'error');
        } finally {
            UI.hideLoading();
            this.renderAll();
        }
    },

    async _setImageFromFile(node, file) {
        if (!file.type.startsWith('image/')) {
            UI.toast('只支持图片文件', 'warn');
            return;
        }
        try {
            const dataUrl = await API.fileToBase64(file);
            node.data.url = dataUrl;
            node.data.name = file.name;
            node.data.assetId = null;
            this.renderAll();
            this.save();
            Logger.info(`[画布] 图片节点已设置: ${file.name}`);
        } catch (e) {
            UI.toast('读取图片失败: ' + e.message, 'error');
        }
    },

    /** 从 MaterialLib 本地缓存按 assetId 反查素材记录（含审核状态） */
    _materialRecord(assetId) {
        if (!assetId || typeof MaterialLib === 'undefined') return null;
        try { return MaterialLib.getAll().find(i => i.id === assetId) || null; }
        catch (e) { return null; }
    },

    /** 节点入库徽标状态：{ text, ok, bad, busy } */
    _libBadgeInfo(n) {
        const assetId = n.data.assetId;
        if (!VideoModule._validAssetId(assetId)) {
            if (n.type === 'material' && n.data.uploading) return { text: '上传中', ok: false, bad: false, busy: true };
            return { text: '未入库', ok: false, bad: false, busy: false };
        }
        const rec = this._materialRecord(assetId);
        const status = rec ? rec.status : 'active';
        if (status === 'active') return { text: '审核通过', ok: true, bad: false, busy: false };
        if (status === 'processing' || status === 'pending') return { text: '审核中', ok: false, bad: false, busy: true };
        if (status === 'failed' || status === 'error') return { text: '审核失败', ok: false, bad: true, busy: false };
        return { text: '已入库', ok: true, bad: false, busy: false };
    },

    /**
     * 素材节点吸收接入素材：以来源节点当前内容为准刷新素材节点数据（单一素材模型）。
     * autoUpload=true 且未入库时自动上传跟踪审核（接入即入库通道）。
     */
    _absorbMaterial(m, src, autoUpload) {
        if (!m || m.type !== 'material' || !src) return;
        const url = src.type === 'video' ? (src.data.videoUrl || '') : (src.data.url || '');
        m.data.mtype = src.type;
        m.data.url = url;
        m.data.sourceUrl = url;
        m.data.name = src.data.name || m.data.name || '接入素材';
        m.data.assetId = VideoModule._validAssetId(src.data.assetId) ? src.data.assetId : '';
        this.renderAll();
        this.save();
        if (!url) {
            UI.toast(`接入的${this._META[src.type]?.title || src.type}节点还没有内容`, 'warn');
            return;
        }
        if (VideoModule._validAssetId(m.data.assetId)) {
            UI.toast('素材已在火山素材库，直接继承引用（审核状态见节点徽标）', 'success');
            return;
        }
        if (autoUpload) {
            m.data.uploading = true;
            if (src.type === 'video') this._syncMaterialVideo(m);
            else if (src.type === 'audio') this._syncMaterialAudio(m);
            else this._syncImageToLib(m);
        }
    },

    /**
     * 统一同步入口（「同步素材」按钮 / 右键「同步到素材库」）：
     * 先以当前接入素材（唯一入边来源节点）为准刷新素材节点内容，再按类型上传同步；
     * 已入库则提示当前审核状态。
     */
    async _syncMaterial(m) {
        if (!m || m.type !== 'material') return;
        const inEdge = this.edges.find(e => e.to === m.id);
        const src = inEdge ? this.getNode(inEdge.from) : null;
        if (src) {
            const url = src.type === 'video' ? (src.data.videoUrl || '') : (src.data.url || '');
            if (!url) {
                UI.toast(`接入的${this._META[src.type]?.title || src.type}节点还没有内容，无法同步`, 'warn');
                return;
            }
            m.data.mtype = src.type;
            m.data.url = url;
            m.data.sourceUrl = url;
            m.data.name = src.data.name || m.data.name || '接入素材';
            m.data.assetId = VideoModule._validAssetId(src.data.assetId) ? src.data.assetId : '';
        }
        if (!m.data.url) {
            UI.toast('素材节点还没有接入素材，请先连线图片/视频/音频节点', 'warn');
            return;
        }
        this.renderAll();
        this.save();
        if (VideoModule._validAssetId(m.data.assetId)) {
            UI.toast('该素材已在素材库中，审核状态见节点上方徽标', 'info');
            return;
        }
        if (m.data.mtype === 'video') await this._syncMaterialVideo(m);
        else if (m.data.mtype === 'audio') await this._syncMaterialAudio(m);
        else await this._syncImageToLib(m);
    },

    /**
     * 图片节点 → 素材库节点（入库通道）：
     *  - 图片节点保留原图，新建素材节点承接上传与审核状态
     *  - 图片已在库（有有效 assetId）→ 素材节点直接继承引用，秒完成
     *  - 否则自动走 _syncImageToLib 上传（uguu 托管 → 火山素材库 → 轮询审核）
     */
    _materializeImage(fromId, wx, wy) {
        const from = this.getNode(fromId);
        if (!from || from.type !== 'image' || !from.data.url) {
            UI.toast('图片节点还没有图片，无法入库', 'warn');
            return;
        }
        const m = this.addNode('material', wx, wy, { name: from.data.name || '画布图片' });
        this.edges.push({ id: this._uid('edge'), from: fromId, to: m.id });
        this._absorbMaterial(m, from, true);
    },

    /**
     * 视频节点 → 素材库节点（视频入库通道，与图片入库通道对称）：
     *  - 视频节点保留原视频，新建素材节点（mtype=video）承接上传与审核状态
     *  - 视频已在库（有有效 assetId）→ 素材节点直接继承引用，秒完成
     *  - 否则自动走 _syncMaterialVideo 上传（托管 → 火山素材库 → 轮询审核）
     */
    _materializeVideo(fromId, wx, wy) {
        const from = this.getNode(fromId);
        if (!from || from.type !== 'video' || !from.data.videoUrl) {
            UI.toast('视频节点还没有视频，无法入库', 'warn');
            return;
        }
        const m = this.addNode('material', wx, wy, { name: from.data.name || '画布视频' });
        this.edges.push({ id: this._uid('edge'), from: fromId, to: m.id });
        this._absorbMaterial(m, from, true);
    },

    /** 视频素材节点同步到火山素材库（托管公网 → CreateAsset → 轮询审核，徽标实时刷新） */
    async _syncMaterialVideo(m) {
        if (!m || m.type !== 'material') { UI.toast('素材节点不存在', 'warn'); return; }
        if (!m.data.url) { UI.toast('素材节点还没有视频内容，请先连线视频节点或从素材库选择', 'warn'); return; }
        if (VideoModule._validAssetId(m.data.assetId)) { UI.toast('该视频已在素材库中', 'info'); return; }
        try {
            m.data.uploading = true;
            this.renderAll();
            UI.showLoading('正在同步视频到素材库...');
            const resp = await fetch(m.data.url);
            const blob = await resp.blob();
            const file = new File([blob], m.data.name || `canvas-video-${Date.now()}.mp4`, { type: blob.type || 'video/mp4' });
            // uploadFile 返回托管后的 httpUrl，本地缓存记录以 httpUrl 为键
            const httpUrl = await MaterialLib.uploadFile(file);
            const rec = MaterialLib.getAll().find(i => i.url === httpUrl || i.sourceUrl === httpUrl);
            const nn = this.getNode(m.id);
            if (!nn) return;
            if (rec && VideoModule._validAssetId(rec.id)) {
                nn.data.assetId = rec.id;
                nn.data.name = rec.name || nn.data.name;
                // 用托管 URL 替换 data: 引用，审核轮询后徽标自动变为审核中/通过
                if (httpUrl && httpUrl.startsWith('http')) { nn.data.url = httpUrl; nn.data.sourceUrl = httpUrl; }
                this.save();
                UI.toast('视频已上传到素材库，等待火山审核（审核通过后才能生成视频）', 'info', 5000);
                Logger.success(`[画布] 视频素材已入库: ${rec.id}`);
            } else {
                if (httpUrl && httpUrl.startsWith('http')) { nn.data.url = httpUrl; nn.data.sourceUrl = httpUrl; }
                this.save();
                UI.toast('视频已上传，火山审核通过后即可用 asset:// 引用', 'info', 5000);
            }
        } catch (e) {
            UI.toast('同步视频素材库失败: ' + e.message, 'error');
        } finally {
            const nn = this.getNode(m?.id);
            if (nn && nn.data) nn.data.uploading = false;
            UI.hideLoading();
            this.renderAll();
        }
    },

    /**
     * 音频节点 → 素材库节点（音频入库通道，与图片/视频通道对称）：
     *  - 音频节点保留原音频，新建素材节点（mtype=audio）承接上传与审核状态
     *  - 音频已在库（有有效 assetId）→ 素材节点直接继承引用，秒完成
     *  - 否则自动走 _syncMaterialAudio 上传（托管 → 火山素材库 → 轮询审核）
     */
    _materializeAudio(fromId, wx, wy) {
        const from = this.getNode(fromId);
        if (!from || from.type !== 'audio' || !from.data.url) {
            UI.toast('音频节点还没有音频，无法入库', 'warn');
            return;
        }
        const m = this.addNode('material', wx, wy, { name: from.data.name || '画布音频' });
        this.edges.push({ id: this._uid('edge'), from: fromId, to: m.id });
        this._absorbMaterial(m, from, true);
    },

    /** 音频素材节点同步到火山素材库（托管公网 → CreateAsset → 轮询审核，徽标实时刷新） */
    async _syncMaterialAudio(m) {
        if (!m || m.type !== 'material') { UI.toast('素材节点不存在', 'warn'); return; }
        if (!m.data.url) { UI.toast('素材节点还没有音频内容，请先连线音频节点或从素材库选择', 'warn'); return; }
        if (VideoModule._validAssetId(m.data.assetId)) { UI.toast('该音频已在素材库中', 'info'); return; }
        try {
            m.data.uploading = true;
            this.renderAll();
            UI.showLoading('正在同步音频到素材库...');
            const resp = await fetch(m.data.url);
            const blob = await resp.blob();
            const file = new File([blob], m.data.name || `canvas-audio-${Date.now()}.mp3`, { type: blob.type || 'audio/mpeg' });
            // uploadFile 返回托管后的 httpUrl，本地缓存记录以 httpUrl 为键
            const httpUrl = await MaterialLib.uploadFile(file);
            const rec = MaterialLib.getAll().find(i => i.url === httpUrl || i.sourceUrl === httpUrl);
            const nn = this.getNode(m.id);
            if (!nn) return;
            if (rec && VideoModule._validAssetId(rec.id)) {
                nn.data.assetId = rec.id;
                nn.data.name = rec.name || nn.data.name;
                if (httpUrl && httpUrl.startsWith('http')) { nn.data.url = httpUrl; nn.data.sourceUrl = httpUrl; }
                this.save();
                UI.toast('音频已上传到素材库，等待火山审核（审核通过后才能生成视频）', 'info', 5000);
                Logger.success(`[画布] 音频素材已入库: ${rec.id}`);
            } else {
                if (httpUrl && httpUrl.startsWith('http')) { nn.data.url = httpUrl; nn.data.sourceUrl = httpUrl; }
                this.save();
                UI.toast('音频已上传，火山审核通过后即可用 asset:// 引用', 'info', 5000);
            }
        } catch (e) {
            UI.toast('同步音频素材库失败: ' + e.message, 'error');
        } finally {
            const nn = this.getNode(m?.id);
            if (nn && nn.data) nn.data.uploading = false;
            UI.hideLoading();
            this.renderAll();
        }
    },

    /** MaterialLib 缓存变化（审核状态轮询/同步）后刷新画布徽标与连线 */
    _refreshMaterialBadges() {
        let dirty = false;
        this.nodes.forEach(n => {
            if (n.type !== 'image' && n.type !== 'material') return;
            if (!n.data.assetId) return;
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
            if (!el) return;
            const badge = el.querySelector('.cnode-lib-badge');
            if (badge) {
                const info = this._libBadgeInfo(n);
                if (badge.textContent !== info.text) dirty = true;
                badge.textContent = info.text;
                badge.classList.toggle('ok', info.ok);
                badge.classList.toggle('bad', info.bad);
                badge.classList.toggle('busy', info.busy);
            }
        });
        // 素材节点上传完成后清 uploading 标记并重绘连线状态
        this.nodes.forEach(n => {
            if (n.type === 'material' && n.data.uploading && VideoModule._validAssetId(n.data.assetId)) {
                n.data.uploading = false;
                dirty = true;
            }
        });
        if (dirty) { this.renderEdges(); this.save(); }
    },

    /** 把图片节点的图同步到火山素材库（获得 asset:// 引用资格） */
    async _syncImageToLib(node) {
        if (!node || !node.data.url) { UI.toast('请先给图片节点设置图片', 'warn'); return; }
        if (node.data.assetId) { UI.toast('该图片已在素材库中', 'info'); return; }
        try {
            UI.showLoading('正在同步到素材库...');
            const file = await this._dataUrlToFile(node.data.url, node.data.name || 'canvas-image.png');
            // uploadFile 返回托管后的 httpUrl；本地缓存里的记录也是以 httpUrl 为键，必须用它反查
            const httpUrl = await MaterialLib.uploadFile(file);
            const rec = MaterialLib.getAll().find(i => i.url === httpUrl || i.sourceUrl === httpUrl);
            if (rec && VideoModule._validAssetId(rec.id)) {
                node.data.assetId = rec.id;
                node.data.name = rec.name || node.data.name;
                // 用托管 URL 替换 base64：展示不受影响，生成可直接引用，也节省本地存储
                node.data.url = httpUrl;
                this.renderAll();
                this.save();
                UI.toast('已同步到素材库，可使用 asset:// 引用', 'success');
                Logger.success(`[画布] 图片已入库: ${rec.id}`);
            } else {
                // 托管成功但没拿到有效 assetId（审核中/同步失败）：仍然换用 httpUrl，宽松模式可继续用
                if (httpUrl && httpUrl.startsWith('http')) node.data.url = httpUrl;
                this.renderAll();
                this.save();
                UI.toast('素材已上传，火山审核通过后即可用 asset:// 引用（当前仍可宽松模式直接生成）', 'info', 5000);
            }
        } catch (e) {
            UI.toast('同步素材库失败: ' + e.message, 'error');
        } finally {
            if (node && node.data) node.data.uploading = false;
            UI.hideLoading();
            this.renderAll();
        }
    },

    async _dataUrlToFile(dataUrl, filename) {
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        return new File([blob], filename, { type: blob.type || 'image/png' });
    },

    /** 音频节点同步到素材库（托管公网 + 火山素材库审核，成功后用 asset:// 引用生成） */
    async _syncAudioToLib(node) {
        if (!node || !node.data.url) { UI.toast('请先给音频节点上传音频', 'warn'); return; }
        if (node.data.assetId) { UI.toast('该音频已在素材库中', 'info'); return; }
        try {
            UI.showLoading('正在同步音频到素材库...');
            const file = await this._dataUrlToFile(node.data.url, node.data.name || 'canvas-audio.mp3');
            const httpUrl = await MaterialLib.uploadFile(file);
            const rec = MaterialLib.getAll().find(i => i.url === httpUrl || i.sourceUrl === httpUrl);
            if (rec && VideoModule._validAssetId(rec.id)) {
                node.data.assetId = rec.id;
                node.data.name = rec.name || node.data.name;
                node.data.url = httpUrl; // 换托管 URL：展示不受影响，生成可直接引用，且节省本地存储
                this.renderAll();
                this.save();
                UI.toast('音频已同步到素材库，生成时将用 asset:// 引用', 'success');
                Logger.success(`[画布] 音频已入库: ${rec.id}`);
            } else {
                if (httpUrl && httpUrl.startsWith('http')) node.data.url = httpUrl;
                this.renderAll();
                this.save();
                UI.toast('音频已上传，火山审核通过后即可用 asset:// 引用（当前仍可宽松模式直接生成）', 'info', 5000);
            }
        } catch (e) {
            UI.toast('同步音频素材库失败: ' + e.message, 'error');
        } finally {
            UI.hideLoading();
            this.renderAll();
        }
    },

    /** 打开素材库选择素材（按节点内容类型过滤：视频/音频素材节点选对应类型，其余选图片） */
    _pickMaterial(node) {
        if (typeof MaterialLib === 'undefined') { UI.toast('素材库模块未加载', 'error'); return; }
        const mt = node?.data?.mtype;
        const filter = (mt === 'video' || mt === 'audio') ? mt : 'image';
        MaterialLib.openPicker((item) => {
            const nn = this.getNode(node.id);
            if (!nn) return;
            nn.data = {
                assetId: VideoModule._validAssetId(item.id) ? item.id : '',
                url: item.url || item.sourceUrl || '',
                name: item.name || '素材',
                mtype: item.type || filter,
            };
            this.renderAll();
            this.save();
            Logger.info(`[画布] 素材节点已选择: ${nn.data.name} (assetId=${nn.data.assetId || '无'})`);
        }, filter);
    },

    // ===== 拖放 / 粘贴 =====

    _handleDrop(e) {
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        if (files.length === 0) return;
        const world = this._screenToWorld(e.clientX, e.clientY);
        files.forEach((file, i) => {
            const node = this.addNode('image', world.x + i * 30, world.y + i * 30);
            this._setImageFromFile(node, file);
        });
    },

    _handlePaste(e) {
        const panel = document.getElementById('tab-canvas');
        if (!panel || !panel.classList.contains('active')) return;
        // 输入框内粘贴不处理
        if (e.target.closest && e.target.closest('textarea, input')) return;
        const items = Array.from(e.clipboardData?.items || []);
        const imgItem = items.find(i => i.type.startsWith('image/'));
        if (!imgItem) return;
        const file = imgItem.getAsFile();
        if (!file) return;
        const rect = this._viewport.getBoundingClientRect();
        const world = this._screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const node = this.addNode('image', world.x, world.y);
        this._setImageFromFile(node, file);
    },

    // ================================================================
    // 视频生成（复用 AI Studio API 链路）
    // ================================================================

    /**
     * 收集视频节点的上游输入并生成视频。
     * 宽松模式：image 节点无 assetId 时，非本地模型自动上传临时托管转成 URL。
     */
    async generateVideo(nodeId) {
        const node = this.getNode(nodeId);
        if (!node || node.type !== 'video') return;
        if (node.data.status === 'generating' || node.data.status === 'uploading') return;

        // 模型优先级：节点下拉当前显示值 > 节点存储值 > 工具栏选择
        const nodeModelSel = this._nodesLayer.querySelector(`.cnode[data-id="${nodeId}"] .cnode-video-model`);
        const model = (nodeModelSel && nodeModelSel.value)
            || node.data.model
            || document.getElementById('canvasModel')?.value
            || '';
        if (!model) { UI.toast('请先选择视频模型', 'error'); return; }
        node.data.model = model;
        if (nodeModelSel && nodeModelSel.value !== model) nodeModelSel.value = model;

        const ups = this.upstream(nodeId);
        const textNodes = ups.filter(n => n.type === 'text');
        // 图片参考：image 节点 + 图片类型素材节点；视频/音频类型素材节点归入对应参考
        const mediaNodes = ups.filter(n => n.type === 'image' || (n.type === 'material' && n.data.mtype !== 'video' && n.data.mtype !== 'audio'));
        // 音频参考：audio 节点 + 音频类型素材节点（素材库音频 → 参考音频）
        const audioNodes = ups.filter(n => n.type === 'audio' || (n.type === 'material' && n.data.mtype === 'audio'));
        // 视频参考：video 节点 + 视频类型素材节点（素材库视频 → 视频生视频）
        const videoRefNodes = ups.filter(n => n.type === 'video' || (n.type === 'material' && n.data.mtype === 'video'));
        // 审核拦截针对所有素材节点（图片/视频类型均须审核通过）
        const materialNodes = ups.filter(n => n.type === 'material');

        // 提示词：节点自身提示词 + 相连文本节点内容
        const promptParts = [];
        if ((node.data.promptOwn || '').trim()) promptParts.push(node.data.promptOwn.trim());
        textNodes.forEach(t => { if ((t.data.text || '').trim()) promptParts.push(t.data.text.trim()); });
        const prompt = promptParts.join('\n\n');

        if (mediaNodes.length === 0 && audioNodes.length === 0 && videoRefNodes.length === 0 && !prompt) {
            UI.toast('请先连线图片/素材/音频/视频节点，或填写提示词', 'warn');
            return;
        }

        // 严格模式：上游素材节点必须在库且审核通过（审核中/失败一律禁止生成）
        for (const m of materialNodes) {
            if (m.type !== 'material') continue;
            const name = m.data.name || '未命名素材';
            const reportError = (msg) => {
                UI.toast(msg, 'error', 6000);
                node.data.status = 'idle';
                node.data.error = msg;
                this._updateVideoNodeStatus(
                    this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            };
            if (!VideoModule._validAssetId(m.data.assetId)) {
                reportError(`素材「${name}」尚未完成入库，请先入库并等审核通过后再生成视频`);
                return;
            }
            const st = this._materialRecord(m.data.assetId)?.status;
            if (st === 'processing' || st === 'pending') {
                reportError(`素材「${name}」火山审核中，审核通过后才能生成视频`);
                return;
            }
            if (st === 'failed' || st === 'error') {
                reportError(`素材「${name}」审核失败，请重新处理该素材后再试`);
                return;
            }
        }

        const isLocalModel = API._isLocalModel(model);
        const abort = new AbortController();
        node._abort = abort;

        try {
            // —— 解析媒体输入 ——
            // 火山约束：首帧模式与参考图模式不能混用（400: first/last frame content cannot be
            // mixed with reference media content）。因此：单个媒体 → 首帧模式；多个媒体 →
            // 全部走参考图模式（不设首帧）。
            const mediaValues = [];
            for (let i = 0; i < mediaNodes.length; i++) {
                const m = mediaNodes[i];
                let value = null;
                if (m.type === 'material') {
                    value = VideoModule._validAssetId(m.data.assetId)
                        ? 'asset://' + m.data.assetId
                        : (m.data.url || null);
                } else {
                    // image 节点
                    if (VideoModule._validAssetId(m.data.assetId)) {
                        value = 'asset://' + m.data.assetId;
                    } else if (isLocalModel) {
                        value = m.data.url; // base64 直传
                    } else if (m.data.url && m.data.url.startsWith('http')) {
                        value = m.data.url;
                    } else if (m.data.url) {
                        // 宽松模式：上传临时托管
                        node.data.status = 'uploading';
                        node.data.progress = 0;
                        this._updateVideoNodeStatus(
                            this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
                        value = await VideoModule._uploadToTempHost(m.data.url, m.data.name || 'canvas-image');
                        if (!value || value.startsWith('data:')) {
                            throw new Error(`图片「${m.data.name || '未命名'}」上传公网托管失败，建议同步到素材库后重试`);
                        }
                    }
                }
                if (value) mediaValues.push(value);
            }

            // 上传中状态提示（音频/参考视频走公网托管时展示）
            const setUploading = (text) => {
                node.data.status = 'uploading';
                node.data.progress = 0;
                node.data.statusText = text;
                this._updateVideoNodeStatus(
                    this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            };

            // —— 参考音频（audio 节点）——
            const refAudioValues = [];
            for (const a of audioNodes) {
                let value = null;
                if (VideoModule._validAssetId(a.data.assetId)) {
                    value = 'asset://' + a.data.assetId;
                } else if (a.data.url) {
                    if (isLocalModel) {
                        value = a.data.url; // base64 直传
                    } else if (a.data.url.startsWith('http')) {
                        value = a.data.url;
                    } else {
                        setUploading(`正在上传参考音频「${a.data.name || '未命名'}」...`);
                        value = await VideoModule._uploadToTempHost(a.data.url, a.data.name || 'canvas-audio');
                        if (!value || value.startsWith('data:')) {
                            throw new Error(`音频「${a.data.name || '未命名'}」上传公网托管失败，无法作为参考音频`);
                        }
                    }
                }
                if (value) refAudioValues.push(value);
            }

            // —— 参考视频（video 节点 / 视频类型素材节点：本机上传/素材库选择/生成结果均可）——
            const refVideoValues = [];
            for (const v of videoRefNodes) {
                const vurl = v.data.videoUrl || v.data.url || '';
                let value = null;
                if (VideoModule._validAssetId(v.data.assetId)) {
                    value = 'asset://' + v.data.assetId;
                } else if (vurl) {
                    if (isLocalModel) {
                        value = vurl;
                    } else if (vurl.startsWith('http')) {
                        value = vurl;
                    } else if (vurl.startsWith('data:')) {
                        setUploading(`正在上传参考视频「${v.data.name || '视频'}」...`);
                        value = await VideoModule._uploadToTempHost(vurl, v.data.name || 'canvas-ref-video');
                        if (!value || value.startsWith('data:')) {
                            throw new Error('参考视频上传公网托管失败，无法作为参考视频');
                        }
                    }
                }
                if (value) refVideoValues.push(value);
                else UI.toast(`视频「${v.data.name || '未命名'}」还没有视频内容（可双击上传或右键从素材库选择），已跳过`, 'warn', 4000);
            }

            // —— 模式约束（与图生视频页多模态分支同规则）——
            // 火山约束：首帧模式与参考图/参考视频不能混用（400）。因此：
            //  - 仅 1 个图片/素材且无音频/视频参考 → 首帧模式
            //  - 其余（多图 / 有音频 / 有视频参考）→ 多模态参考模式（不设首帧）
            let firstFrameUrl = null;
            const refImages = [];
            const refVideos = refVideoValues;
            const refAudios = refAudioValues;
            if (mediaValues.length === 1 && refVideos.length === 0 && refAudios.length === 0) {
                firstFrameUrl = mediaValues[0];
            } else {
                refImages.push(...mediaValues);
            }

            node.data.status = 'generating';
            node.data.progress = 0;
            node.data.statusText = '正在创建生成任务...';
            node.data.error = '';
            this._updateVideoNodeStatus(
                this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            Logger.req(`[画布] 创建视频任务: 模型=${model}, 首帧=${firstFrameUrl ? '有' : '无'}, 参考图=${refImages.length}, 参考视频=${refVideos.length}, 参考音频=${refAudios.length}, 提示词="${(prompt || '').substring(0, 50)}..."`);

            const duration = this._clampDuration(node.data.duration);
            node.data.duration = duration;
            // 时长校验：与图生视频页同规则（普通模型 ≤15s；30s 仅 MiniMax-H3）
            const invalidDuration = VideoModule._validateDuration(model, duration);
            if (invalidDuration) {
                UI.toast(invalidDuration, 'error', 6000);
                node.data.status = 'idle';
                node.data.error = invalidDuration;
                this._updateVideoNodeStatus(
                    this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
                return;
            }

            const params = {
                model,
                prompt,
                resolution: node.data.resolution || '720p',
                ratio: node.data.ratio || '16:9',
                duration,
                fps: node.data.fps || 30,
                firstFrameUrl,
                lastFrameUrl: null,
                referenceImages: refImages.length > 0 ? refImages : null,
                referenceVideos: refVideos.length > 0 ? refVideos : null,
                referenceAudios: refAudios.length > 0 ? refAudios : null,
            };

            const task = await API.createVideoTask(params);
            const taskId = task.video_id || task.task_id || task.id || task.data?.task_id;
            if (!taskId) throw new Error('API 未返回任务ID，请到日志查看响应');

            const result = await API.pollVideoTask(taskId, (pct, status) => {
                node.data.progress = pct || 0;
                node.data.statusText = status || '生成中...';
                this._updateVideoNodeStatus(
                    this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            }, API.VIDEO_POLL_INTERVAL_MS, API.VIDEO_POLL_TIMEOUT_MS, abort.signal);

            const videoUrl = VideoModule._pickVideoUrl(result);
            if (!videoUrl) throw new Error('任务完成但未返回视频地址');

            node.data.status = 'done';
            node.data.progress = 100;
            node.data.videoUrl = videoUrl;
            this._updateVideoNodeStatus(
                this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            UI.toast('视频生成成功！', 'success');
            Logger.success(`[画布] 视频生成完成: ${videoUrl}`);
            this.save();
        } catch (err) {
            if (err.name === 'AbortError' || /取消/i.test(err.message || '')) {
                node.data.status = 'idle';
                node.data.progress = 0;
                Logger.warn('[画布] 用户取消生成');
            } else {
                Logger.error(`[画布] 视频生成失败: ${err.message}`);
                node.data.status = 'error';
                node.data.error = err.message;
                node.data.progress = 0;
                UI.toast('生成失败: ' + err.message, 'error', 5000);
            }
            this._updateVideoNodeStatus(
                this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
        } finally {
            node._abort = null;
        }
    },

    // ================================================================
    // 工具栏
    // ================================================================

    _bindToolbar() {
        const $ = id => document.getElementById(id);
        const centerWorld = () => {
            const rect = this._viewport.getBoundingClientRect();
            return this._screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
        };

        $('canvasAddTextBtn')?.addEventListener('click', () => { const w = centerWorld(); this.addNode('text', w.x, w.y); });
        $('canvasAddImageBtn')?.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
            input.style.display = 'none';
            document.body.appendChild(input);
            input.onchange = () => {
                const w = centerWorld();
                Array.from(input.files || []).forEach((f, i) => {
                    const node = this.addNode('image', w.x + i * 30, w.y + i * 30);
                    this._setImageFromFile(node, f);
                });
                document.body.removeChild(input);
            };
            input.click();
        });
        $('canvasAddMaterialBtn')?.addEventListener('click', () => {
            const w = centerWorld();
            const node = this.addNode('material', w.x, w.y);
            this._pickMaterial(node);
        });
        $('canvasAddVideoBtn')?.addEventListener('click', () => { const w = centerWorld(); this.addNode('video', w.x, w.y); });
        $('canvasAddAudioBtn')?.addEventListener('click', () => {
            const w = centerWorld();
            const node = this.addNode('audio', w.x, w.y);
            this._pickLocalAudio(node);
        });

        $('canvasUndoBtn')?.addEventListener('click', () => this.undo());
        $('canvasRedoBtn')?.addEventListener('click', () => this.redo());
        $('canvasZoomInBtn')?.addEventListener('click', () => {
            const rect = this._viewport.getBoundingClientRect();
            this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2);
        });
        $('canvasZoomOutBtn')?.addEventListener('click', () => {
            const rect = this._viewport.getBoundingClientRect();
            this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2);
        });
        $('canvasFitBtn')?.addEventListener('click', () => this.fitView());
        $('canvasClearBtn')?.addEventListener('click', () => this.clearAll());

        // 对齐与排列：Ctrl/Shift 框选或 Ctrl+点击多选后点击使用
        document.querySelectorAll('.canvas-align-btn').forEach(btn => {
            btn.addEventListener('click', () => this._alignSelected(btn.dataset.align));
        });

        // 画布使用提示关闭
        $('canvasHintClose')?.addEventListener('click', () => {
            $('canvasHint')?.classList.add('hidden');
            localStorage.setItem(ScopedStore.key('aistudio_canvas_hint_closed'), '1');
        });
        if (localStorage.getItem(ScopedStore.key('aistudio_canvas_hint_closed')) === '1') {
            $('canvasHint')?.classList.add('hidden');
        }
    },

    /**
     * 对齐/排列选中的节点（≥2 个；等距分布需 ≥3 个）
     * mode: left | centerX | right | top | centerY | bottom | distX | distY
     */
    _alignSelected(mode) {
        const ids = Array.from(this.selection);
        if (ids.length < 2) {
            UI.toast('请先选中至少 2 个节点（Ctrl+拖拽框选或 Ctrl+点击）', 'warn');
            return;
        }
        const items = ids.map(id => {
            const n = this.getNode(id);
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${id}"]`);
            return n ? { n, w: el?.offsetWidth || n.w || 200, h: el?.offsetHeight || 120 } : null;
        }).filter(Boolean);
        if (items.length < 2) return;
        // 必须在修改坐标之前压栈，否则快照里已是排列后的状态，撤销会失效
        this._pushHistory();

        if (mode === 'distX' || mode === 'distY') {
            if (items.length < 3) {
                UI.toast('等距分布至少需要 3 个节点', 'warn');
                return;
            }
            const key = mode === 'distX' ? 'x' : 'y';
            const sizeKey = mode === 'distX' ? 'w' : 'h';
            items.sort((a, b) => a.n[key] - b.n[key]);
            const first = items[0], last = items[items.length - 1];
            const total = (last.n[key] + last[sizeKey]) - first.n[key];
            const sum = items.reduce((acc, it) => acc + it[sizeKey], 0);
            const gap = (total - sum) / (items.length - 1);
            let cursor = first.n[key];
            items.forEach(it => {
                it.n[key] = Math.round(cursor);
                cursor += it[sizeKey] + gap;
            });
        } else {
            const minX = Math.min(...items.map(it => it.n.x));
            const maxX = Math.max(...items.map(it => it.n.x + it.w));
            const minY = Math.min(...items.map(it => it.n.y));
            const maxY = Math.max(...items.map(it => it.n.y + it.h));
            items.forEach(it => {
                switch (mode) {
                    case 'left': it.n.x = minX; break;
                    case 'right': it.n.x = maxX - it.w; break;
                    case 'centerX': it.n.x = Math.round((minX + maxX) / 2 - it.w / 2); break;
                    case 'top': it.n.y = minY; break;
                    case 'bottom': it.n.y = maxY - it.h; break;
                    case 'centerY': it.n.y = Math.round((minY + maxY) / 2 - it.h / 2); break;
                }
            });
        }

        items.forEach(({ n }) => {
            const el = this._nodesLayer.querySelector(`.cnode[data-id="${n.id}"]`);
            if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
        });
        this.renderEdges();
        this._minimapSchedule();
        this.save();
    },

    // ================================================================
    // 画布设置：背景样式（点阵/网格线/无）、背景色、工具栏自动隐藏
    // ================================================================

    _loadSettings() {
        try { return JSON.parse(localStorage.getItem(ScopedStore.key('aistudio_canvas_settings')) || '{}'); }
        catch (e) { return {}; }
    },

    _saveSettings() {
        localStorage.setItem(ScopedStore.key('aistudio_canvas_settings'), JSON.stringify(this._settings || {}));
    },

    _applyBackground() {
        const vp = this._viewport;
        if (!vp) return;
        const s = this._settings || {};
        // 图案与底色解耦：点/网格图案叠在底色上，互不影响
        const style = ['dots', 'grid', 'none'].includes(s.bgStyle) ? s.bgStyle : 'dots';
        vp.classList.remove('bg-dots', 'bg-grid', 'bg-none');
        vp.classList.add('bg-' + style);
        // 底色：自定义色优先；否则默认值（深色模式=黑，浅色模式=R170 G200 B185）
        vp.style.backgroundColor = s.bgColor || this._defaultBgColor();
        const sel = document.getElementById('canvasBgStyle');
        const color = document.getElementById('canvasBgColor');
        if (sel && sel.value !== style) sel.value = style;
        if (color) {
            const effective = s.bgColor || this._defaultBgColor();
            if (color.value !== effective) color.value = effective;
            color.disabled = false;
            color.title = s.bgColor
                ? '画布背景色自定义（点「默认」恢复随主题的默认色）'
                : '当前为默认配色（深色模式=黑色，浅色模式=浅绿灰），可直接调整';
        }
    },

    /** 默认背景色：随主题 */
    _defaultBgColor() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? '#000000' : '#aac8b9'; // 浅色 R170 G200 B185
    },

    _bindCanvasSettings() {
        this._settings = this._loadSettings();
        const $ = id => document.getElementById(id);

        $('canvasBgStyle')?.addEventListener('change', (e) => {
            this._settings.bgStyle = ['dots', 'grid', 'none'].includes(e.target.value) ? e.target.value : 'dots';
            this._saveSettings();
            this._applyBackground();
        });
        // 「默认」按钮：仅重置背景色为主题默认值（深=黑/浅=浅绿灰），不影响点/网格图案设置
        $('canvasBgDefaultBtn')?.addEventListener('click', () => {
            this._settings.bgColor = '';
            this._saveSettings();
            this._applyBackground();
            UI.toast('已恢复默认背景色（深色模式=黑色，浅色模式=浅绿灰）', 'success', 2200);
        });
        $('canvasBgColor')?.addEventListener('input', (e) => {
            this._settings.bgColor = e.target.value;
            this._saveSettings();
            this._applyBackground();
        });
        $('canvasBgColor')?.addEventListener('change', () => this.save());
        this._applyBackground();

        // 主题切换时，默认背景模式需要跟随重配色
        this._themeObserver = new MutationObserver(() => this._applyBackground());
        this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        this._bindToolbarAutoHide();
    },

    _bindToolbarAutoHide() {
        const panel = document.getElementById('tab-canvas');
        const bar = panel?.querySelector('.canvas-toolbar');
        if (!panel || !bar) return;

        let hideTimer = null;
        const show = () => { clearTimeout(hideTimer); panel.classList.add('toolbar-visible'); };
        const scheduleHide = () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => panel.classList.remove('toolbar-visible'), 2200);
        };

        // 固定/自动 切换
        const pinBtn = document.getElementById('canvasToolbarPinBtn');
        const applyPin = () => {
            panel.classList.toggle('toolbar-pinned', !!this._settings.toolbarPin);
            if (pinBtn) {
                pinBtn.classList.toggle('active', !!this._settings.toolbarPin);
                pinBtn.title = this._settings.toolbarPin
                    ? '已固定：点击取消固定（工具栏自动隐藏，鼠标移到顶部唤出）'
                    : '固定工具栏（不再自动隐藏）';
            }
        };
        applyPin();
        pinBtn?.addEventListener('click', () => {
            this._settings.toolbarPin = !this._settings.toolbarPin;
            this._saveSettings();
            applyPin();
            if (this._settings.toolbarPin) {
                clearTimeout(hideTimer);
                panel.classList.add('toolbar-visible');
            } else {
                show();
                scheduleHide();
            }
        });

        // 自动隐藏模式：鼠标移到面板顶部区域或工具栏上 → 唤出；离开 → 2.2s 后隐藏
        if (this._settings.toolbarPin) return;
        show();
        scheduleHide();
        panel.addEventListener('mousemove', (e) => {
            if (this._settings.toolbarPin) return;
            const rect = panel.getBoundingClientRect();
            if (e.clientY - rect.top < 64 || e.target.closest?.('.canvas-toolbar')) show();
            else scheduleHide();
        });
        panel.addEventListener('mouseleave', () => {
            if (!this._settings.toolbarPin) scheduleHide();
        });
    },
};
