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
    STORAGE_KEY: 'aistudio_canvas_v1',

    // ===== 状态 =====
    nodes: [],
    edges: [],
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
    _EDGE_RULES: {
        text: ['video', 'image'],
        image: ['video', 'image'],
        material: ['video', 'image'],
    },

    // 节点标题/图标
    _META: {
        text:     { title: '提示词' },
        image:    { title: '图片' },
        material: { title: '素材库' },
        video:    { title: '视频' },
    },

    // 节点内联 SVG 图标（与 AI Studio 顶栏同款 feather 风格）
    _ICONS: {
        text: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        image: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        material: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
        video: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
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
        this.renderAll();

        Logger.info('[画布] 初始化完成');
    },

    /** 切到画布页时触发 */
    onShow() {
        // DOM 已就绪，无需特殊处理；预留给未来按需刷新
        this.renderEdges();
        this._minimapSchedule();
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
        const colors = { text: '#94a3b8', image: '#5b9cf6', material: '#f5a623', video: '#a86cf6' };
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

    _pushHistory() {
        this._undoStack.push(JSON.stringify({ nodes: this.nodes, edges: this.edges }));
        if (this._undoStack.length > 50) this._undoStack.shift();
        this._redoStack.length = 0;
    },

    _snapshotNow() {
        return JSON.stringify({ nodes: this.nodes, edges: this.edges });
    },

    undo() {
        if (this._undoStack.length === 0) return;
        // 当前状态入 redo 栈
        this._redoStack.push(this._snapshotNow());
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

    // ===== 持久化 =====

    save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                    nodes: this.nodes,
                    edges: this.edges,
                    viewport: this.viewport,
                }));
            } catch (e) {
                if (!this._quotaWarned) {
                    this._quotaWarned = true;
                    Logger.warn('[画布] 画布保存失败（本地存储空间不足），图片过多时请及时清理');
                    UI.toast('画布自动保存失败：本地存储空间不足，图片节点过多时建议同步素材库后删除大图', 'warn', 6000);
                }
            }
        }, 300);
    },

    _restore() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
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
        } catch (e) {
            Logger.warn('[画布] 恢复画布失败: ' + e.message);
            this.nodes = [];
            this.edges = [];
        }
    },

    // ================================================================
    // 节点增删
    // ================================================================

    addNode(type, wx, wy, data) {
        this._pushHistory();
        const defaults = {
            w: type === 'video' ? 320 : type === 'text' ? 240 : 260,
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
                model: '', promptOwn: '', ratio: '1:1', resolution: '720p',
                status: 'idle', error: '',
            };
            // 新建图片节点默认用工具栏下方图片模型（若已加载）
            if (this._models.image.length > 0) base.data.model = this._models.image[0].id;
        }
        if (type === 'material') base.data = { assetId: '', url: '', name: '', mtype: 'image' };
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
        // 动态更新视频节点状态区
        if (n.type === 'video') this._updateVideoNodeStatus(el, n);
        // 动态更新图片节点状态区
        if (n.type === 'image') this._updateImageNodeStatus(el, n);
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
        // 素材徽标
        if (n.type === 'image' || n.type === 'material') {
            const badge = el.querySelector('.cnode-lib-badge');
            if (badge) {
                const has = n.type === 'material' ? !!n.data.assetId : !!n.data.assetId;
                badge.textContent = has ? '已入库' : (n.type === 'material' ? '未入库' : '未入库');
                badge.classList.toggle('ok', has);
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
        function meta_title(t) { return { text: '提示词', image: '图片', material: '素材库', video: '视频' }[t] || t; }

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
                        <div class="cnode-img-placeholder">双击上传图片<br>或拖拽图片文件到画布<br>或直接用下方按钮生成</div>
                    </div>
                    <div class="cnode-sub">${this._escape(n.data.name || '')}</div>
                    <textarea class="cnode-image-prompt" rows="2" placeholder="生图提示词（留空则用相连的文本节点）">${this._escape(n.data.promptOwn || '')}</textarea>
                    <select class="cnode-image-model" title="生图模型"><option value="">加载中...</option></select>
                    <div class="cnode-params">
                        <select class="cnode-img-ratio" title="画面比例">
                            <option value="21:9">21:9</option><option value="16:9">16:9</option>
                            <option value="4:3">4:3</option><option value="1:1" selected>1:1</option>
                            <option value="3:4">3:4</option><option value="9:16">9:16</option>
                        </select>
                        <select class="cnode-img-res" title="分辨率">
                            <option value="480p">480p</option><option value="720p" selected>720p</option>
                            <option value="1080p">1080p</option><option value="4K">4K</option>
                        </select>
                        <button class="cnode-btn cnode-img-generate-btn" title="生成图片（有上游图片时为图生图）">${this._ICONS.zap} 生图</button>
                    </div>
                    <div class="cnode-img-status"></div>
                    <div class="cnode-btn-row">
                        <button class="cnode-btn cnode-act-replace" title="从本机选择图片替换">替换图片</button>
                        <button class="cnode-btn cnode-act-sync" title="上传到火山素材库，获得 asset:// 引用">同步素材库</button>
                    </div>
                </div>
                <div class="cnode-port cnode-port-in" data-port="in" title="接收提示词/参考图"></div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频/图片节点"></div>`;
        }

        if (n.type === 'material') {
            return `${head(`<span class="cnode-lib-badge">未入库</span>`)}
                <div class="cnode-body">
                    <div class="cnode-img-wrap empty">
                        <img class="cnode-img" draggable="false" alt="">
                        <div class="cnode-img-placeholder">从素材库选择</div>
                    </div>
                    <div class="cnode-sub">${this._escape(n.data.name || '')}</div>
                    <div class="cnode-btn-row">
                        <button class="cnode-btn cnode-act-pick">选择素材</button>
                    </div>
                </div>
                <div class="cnode-port cnode-port-out" data-port="out" title="拖拽连线到视频节点"></div>`;
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
                <div class="cnode-port cnode-port-in" data-port="in" title="接收图片/素材/文本"></div>`;
        }
        return head();
    },

    _bindNodeEvents(el, n) {
        const node = () => this.getNode(el.dataset.id);

        // 拖拽移动（头部/body 空白处按下）
        el.addEventListener('mousedown', (e) => {
            const target = e.target;
            if (target.closest('textarea, select, input, button, video, .cnode-port')) return;
            e.stopPropagation();
            this._selectNode(el.dataset.id, e.shiftKey);
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

        // 双击：图片节点上传 / 素材节点选择
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('textarea, select, input, button, video')) return;
            const nn = node();
            if (!nn) return;
            if (nn.type === 'image') this._pickLocalImage(nn);
            if (nn.type === 'material') this._pickMaterial(nn);
        });

        // 删除按钮
        el.querySelector('.cnode-x')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteNodes([el.dataset.id]);
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
        const statusEl = el.querySelector('.cnode-video-status');
        const btn = el.querySelector('.cnode-generate-btn');
        const resultEl = el.querySelector('.cnode-video-result');
        if (!statusEl) return;

        const videoEl = resultEl?.querySelector('video');
        if (n.data.videoUrl && videoEl && videoEl.dataset.src !== n.data.videoUrl) {
            videoEl.src = n.data.videoUrl;
            videoEl.dataset.src = n.data.videoUrl;
            resultEl.style.display = '';
        } else if (!n.data.videoUrl && resultEl) {
            resultEl.style.display = 'none';
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
            html = `<div class="cnode-status-line error">${this._escape(n.data.error || '生成失败')}</div>`;
        } else if (n.data.status === 'done') {
            html = `<div class="cnode-status-line ok">✓ 生成完成（${this._escape(n.data.model || '')}）</div>`;
        }
        statusEl.innerHTML = html;
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
            const map = (typeof RESOLUTION_SIZE_MAP !== 'undefined') ? RESOLUTION_SIZE_MAP : null;
            const size = map && map[node.data.resolution] && map[node.data.resolution][node.data.ratio];
            return size || '1920x1920';
        } catch (e) { return '1920x1920'; }
    },

    /** 视频时长钳制：4~30 秒整数（对齐 infinite-canvas 的 VIDEO_SECONDS_MIN/MAX） */
    _clampDuration(v) {
        const s = Math.floor(Number(v) || 5);
        return Math.max(4, Math.min(30, s));
    },

    _updateImageNodeStatus(el, n) {
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
            html = `<div class="cnode-status-line error">${this._escape(n.data.error || '生成失败')}</div>`;
        }
        statusEl.innerHTML = html;
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
        const setStatus = (status, extra) => {
            node.data.status = status;
            Object.assign(node.data, extra || {});
            this._updateImageNodeStatus(el, node);
        };

        try {
            // —— 收集参考图（宽松模式，与图生图页面同规则） ——
            const refs = [];
            for (const m of mediaNodes) {
                let v = null;
                if (VideoModule._validAssetId(m.data.assetId)) {
                    v = 'asset://' + m.data.assetId;
                } else if (m.data.url && m.data.url.startsWith('http')) {
                    v = m.data.url;
                } else if (m.data.url) {
                    setStatus('uploading');
                    v = await VideoModule._uploadToTempHost(m.data.url, m.data.name || 'canvas-image');
                    if (!v || v.startsWith('data:')) {
                        throw new Error(`参考图「${m.data.name || '未命名'}」上传公网托管失败，建议同步到素材库后重试`);
                    }
                }
                if (v) refs.push(v);
            }

            setStatus('generating');
            Logger.req(`[画布] 图片生成: 模型=${model}, 模式=${refs.length > 0 ? '图生图(' + refs.length + '图)' : '文生图'}, 尺寸=${this._imageSize(node)}`);

            let result;
            if (refs.length > 0) {
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
            setStatus('idle', { error: '' });
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

        const drawEdge = (edge, selected) => {
            const p1 = this._portPos(edge.from, 'out');
            const p2 = this._portPos(edge.to, 'in');
            if (!p1 || !p2) return;
            const d = this._edgePath(p1.x, p1.y, p2.x, p2.y);
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
            vis.setAttribute('class', 'canvas-edge' + (selected ? ' selected' : ''));
            svg.appendChild(vis);
        };

        this.edges.forEach(e => drawEdge(e, this.selectedEdge === e.id));

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

    /** 判断 from 节点能否连到 to 节点 */
    _canConnect(fromId, toId) {
        const from = this.getNode(fromId);
        const to = this.getNode(toId);
        if (!from || !to || from.id === to.id) return false;
        const allowed = this._EDGE_RULES[from.type] || [];
        if (!allowed.includes(to.type)) return false;
        // 去重
        if (this.edges.find(e => e.from === fromId && e.to === toId)) return false;
        // 视频节点最多 1 个文本输入 + 6 个媒体输入
        return true;
    },

    _connect(fromId, toId) {
        if (!this._canConnect(fromId, toId)) {
            const from = this.getNode(fromId), to = this.getNode(toId);
            if (from && to) UI.toast(`不支持 ${this._META[from.type]?.title || from.type} → ${this._META[to.type]?.title || to.type} 的连线`, 'warn');
            return;
        }
        this._pushHistory();
        this.edges.push({ id: this._uid('edge'), from: fromId, to: toId });
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
            if (!e.shiftKey && (e.button === 0 || e.button === 1)) {
                // 拖拽平移
                this._drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.viewport.x, oy: this.viewport.y };
                vp.classList.add('panning');
            } else if (e.shiftKey && e.button === 0) {
                // 框选
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._drag = { type: 'select', startWx: world.x, startWy: world.y };
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
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.moved = true;
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
        if (additive) {
            if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
        } else {
            this.selection = new Set([id]);
        }
        this._clearEdgeSelect();
        this.renderNodes();
    },

    _renderSelection() {
        this._nodesLayer.querySelectorAll('.cnode').forEach(el => {
            el.classList.toggle('selected', this.selection.has(el.dataset.id));
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
                }
                this._showContextMenu(e.clientX, e.clientY, items);
            } else {
                const world = this._screenToWorld(e.clientX, e.clientY);
                this._showContextMenu(e.clientX, e.clientY, [
                    { label: '添加提示词节点', action: () => this.addNode('text', world.x, world.y) },
                    { label: '添加图片节点', action: () => this.addNode('image', world.x, world.y) },
                    { label: '从素材库添加', action: () => { const n = this.addNode('material', world.x, world.y); this._pickMaterial(n); } },
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
            UI.hideLoading();
        }
    },

    async _dataUrlToFile(dataUrl, filename) {
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        return new File([blob], filename, { type: blob.type || 'image/png' });
    },

    /** 打开素材库选择素材（图片类型） */
    _pickMaterial(node) {
        if (typeof MaterialLib === 'undefined') { UI.toast('素材库模块未加载', 'error'); return; }
        MaterialLib.openPicker((item) => {
            const nn = this.getNode(node.id);
            if (!nn) return;
            nn.data = {
                assetId: VideoModule._validAssetId(item.id) ? item.id : '',
                url: item.url || item.sourceUrl || '',
                name: item.name || '素材',
                mtype: item.type || 'image',
            };
            this.renderAll();
            this.save();
            Logger.info(`[画布] 素材节点已选择: ${nn.data.name} (assetId=${nn.data.assetId || '无'})`);
        }, 'image');
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
        const mediaNodes = ups.filter(n => n.type === 'image' || n.type === 'material');

        // 提示词：节点自身提示词 + 相连文本节点内容
        const promptParts = [];
        if ((node.data.promptOwn || '').trim()) promptParts.push(node.data.promptOwn.trim());
        textNodes.forEach(t => { if ((t.data.text || '').trim()) promptParts.push(t.data.text.trim()); });
        const prompt = promptParts.join('\n\n');

        if (mediaNodes.length === 0 && !prompt) {
            UI.toast('请先连线图片/素材节点，或填写提示词', 'warn');
            return;
        }

        const isLocalModel = API._isLocalModel(model);
        const abort = new AbortController();
        node._abort = abort;

        try {
            // —— 解析媒体输入 ——
            let firstFrameUrl = null;
            const refImages = [];
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
                if (!value) continue;
                if (firstFrameUrl === null) firstFrameUrl = value;
                else refImages.push(value);
            }

            node.data.status = 'generating';
            node.data.progress = 0;
            node.data.statusText = '正在创建生成任务...';
            node.data.error = '';
            this._updateVideoNodeStatus(
                this._nodesLayer.querySelector(`.cnode[data-id="${node.id}"]`), node);
            Logger.req(`[画布] 创建视频任务: 模型=${model}, 首帧=${firstFrameUrl ? '有' : '无'}, 参考图=${refImages.length}, 提示词="${(prompt || '').substring(0, 50)}..."`);

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

        // 画布使用提示关闭
        $('canvasHintClose')?.addEventListener('click', () => {
            $('canvasHint')?.classList.add('hidden');
            localStorage.setItem('aistudio_canvas_hint_closed', '1');
        });
        if (localStorage.getItem('aistudio_canvas_hint_closed') === '1') {
            $('canvasHint')?.classList.add('hidden');
        }
    },
};
