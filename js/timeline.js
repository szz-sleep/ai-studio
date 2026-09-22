/** H3 long-video timeline editor. */
const TimelineModule = {
    STORAGE_KEY: 'h3-timeline-draft-v1',
    segments: [],
    _nextId: 1,
    activeTaskId: null,
    pollController: null,

    init() {
        const container = document.getElementById('timelineSegments');
        if (!container || typeof H3TimelinePlan === 'undefined') return;
        this._loadDraft();
        if (!this.segments.length) {
            this.segments = [
                this._newSegment(0, 7, ''),
                this._newSegment(6, 13, '')
            ];
        }

        document.getElementById('timelineAddSegmentBtn').addEventListener('click', () => this.addSegment());
        document.getElementById('timelinePreviewJsonBtn').addEventListener('click', () => this.previewPlan());
        document.getElementById('timelineSubmitBtn').addEventListener('click', () => this.submit());
        document.getElementById('timelineCancelTaskBtn').addEventListener('click', () => this.cancelTask());
        ['timelineModel', 'timelineSize', 'timelineFps', 'timelineSeed', 'timelineGlobalPrompt', 'timelineSteps', 'timelineLowSteps', 'timelineDrift', 'timelineSoftAudio']
            .forEach(id => document.getElementById(id)?.addEventListener('input', () => this._onChange()));
        this.render();
    },

    _newSegment(start, end, prompt) {
        return { id: `segment-${String(this._nextId++).padStart(2, '0')}`, start, end, prompt, assets: [] };
    },

    addSegment() {
        const previous = this.segments[this.segments.length - 1];
        const start = previous ? Math.max(0, previous.end - 1) : 0;
        const end = start + 7;
        this.segments.push(this._newSegment(start, end, ''));
        this.render();
        this._saveDraft();
    },

    removeSegment(index) {
        if (this.segments.length === 1) {
            UI.toast('时间线至少保留一个分段', 'warn');
            return;
        }
        this.segments.splice(index, 1);
        this.render();
        this._saveDraft();
    },

    updateSegment(index, field, value) {
        if (!this.segments[index]) return;
        this.segments[index][field] = field === 'prompt' ? value : Number(value);
        this._onChange(false);
    },

    render() {
        const container = document.getElementById('timelineSegments');
        container.innerHTML = this.segments.map((segment, index) => {
            const overlap = index ? Math.max(0, this.segments[index - 1].end - segment.start) : 0;
            return `<article class="timeline-segment-card" data-index="${index}">
                <div class="timeline-segment-head">
                    <div><span class="timeline-segment-index">${String(index + 1).padStart(2, '0')}</span><strong>分段 ${index + 1}</strong><span class="timeline-overlap">${index ? `重叠 ${overlap.toFixed(2)} 秒` : '起始镜头'}</span></div>
                    <button type="button" class="timeline-remove" data-remove="${index}" aria-label="删除分段 ${index + 1}">删除</button>
                </div>
                <div class="timeline-time-row">
                    <label>开始（秒）<input type="number" min="0" step="0.01" value="${segment.start}" data-field="start" data-index="${index}"></label>
                    <span>→</span>
                    <label>结束（秒）<input type="number" min="0.01" step="0.01" value="${segment.end}" data-field="end" data-index="${index}"></label>
                </div>
                <label class="timeline-prompt-label">本段提示词
                    <textarea rows="3" data-field="prompt" data-index="${index}" placeholder="留空时使用全局提示词">${this._escape(segment.prompt)}</textarea>
                </label>
                <div class="timeline-assets-head"><span>参考素材</span><button type="button" class="btn-secondary timeline-add-asset" data-add-asset="${index}">＋ 从素材库添加</button></div>
                <div class="timeline-assets">${this._renderAssets(segment.assets || [], index)}</div>
            </article>`;
        }).join('');

        container.querySelectorAll('[data-field]').forEach(input => {
            input.addEventListener('input', event => this.updateSegment(Number(event.target.dataset.index), event.target.dataset.field, event.target.value));
        });
        container.querySelectorAll('[data-remove]').forEach(button => {
            button.addEventListener('click', () => this.removeSegment(Number(button.dataset.remove)));
        });
        container.querySelectorAll('[data-add-asset]').forEach(button => {
            button.addEventListener('click', () => this.openAssetPicker(Number(button.dataset.addAsset)));
        });
        container.querySelectorAll('[data-remove-asset]').forEach(button => {
            button.addEventListener('click', () => this.removeAsset(Number(button.dataset.segment), Number(button.dataset.removeAsset)));
        });
        this._renderTrack();
        this._validate(false);
    },

    _renderAssets(assets, segmentIndex) {
        if (!assets.length) return '<span class="timeline-assets-empty">尚未分配素材</span>';
        const labels = { image: '图片', video: '视频', audio: '音频' };
        return assets.map((asset, assetIndex) => `<span class="timeline-asset-chip asset-${asset.type}">
            <span>${labels[asset.type] || '素材'} · ${this._escape(asset.name || asset.id)}</span>
            <button type="button" data-segment="${segmentIndex}" data-remove-asset="${assetIndex}" aria-label="移除素材">×</button>
        </span>`).join('');
    },

    openAssetPicker(segmentIndex) {
        if (typeof MaterialLib === 'undefined') {
            UI.toast('素材库尚未初始化', 'error');
            return;
        }
        MaterialLib.openPicker(item => {
            const segment = this.segments[segmentIndex];
            if (!segment) return;
            if ((segment.assets || []).some(asset => asset.id === item.id)) {
                UI.toast('该素材已添加到本段', 'warn');
                return;
            }
            const sameTypeCount = (segment.assets || []).filter(asset => asset.type === item.type).length;
            if (item.type === 'image' && sameTypeCount >= 9) {
                UI.toast('每段最多添加 9 张参考图片', 'warn');
                return;
            }
            if (item.type === 'audio' && sameTypeCount >= 3) {
                UI.toast('每段最多添加 3 个参考音频', 'warn');
                return;
            }
            const isRemoteAsset = item.id && !item.id.startsWith('local_') && !item.id.startsWith('temp_');
            const uri = isRemoteAsset ? `asset://${item.id}` : (item.sourceUrl || item.url);
            if (!uri) {
                UI.toast('素材缺少可用地址', 'error');
                return;
            }
            segment.assets = segment.assets || [];
            segment.assets.push({ id: item.id, name: item.name || '未命名素材', type: item.type, uri, role: 'reference' });
            this.render();
            this._saveDraft();
        });
    },

    removeAsset(segmentIndex, assetIndex) {
        const segment = this.segments[segmentIndex];
        if (!segment) return;
        segment.assets = (segment.assets || []).filter((_, index) => index !== assetIndex);
        this.render();
        this._saveDraft();
    },

    _renderTrack() {
        const track = document.getElementById('timelineTrack');
        const duration = Math.max(...this.segments.map(segment => Number(segment.end) || 0), 1);
        track.innerHTML = this.segments.map((segment, index) => {
            const left = Math.max(0, Number(segment.start) / duration * 100);
            const width = Math.max(1, (Number(segment.end) - Number(segment.start)) / duration * 100);
            return `<div class="timeline-block block-${index % 5}" style="left:${left}%;width:${width}%" title="分段 ${index + 1}: ${segment.start}s–${segment.end}s">${index + 1}</div>`;
        }).join('');
        document.getElementById('timelineDurationSummary').textContent = `总时长 ${duration.toFixed(2)} 秒 · ${this.segments.length} 段`;
    },

    _collectInput() {
        return {
            model: document.getElementById('timelineModel').value.trim(),
            size: document.getElementById('timelineSize').value,
            fps: Number(document.getElementById('timelineFps').value),
            seed: document.getElementById('timelineSeed').value,
            global_prompt: document.getElementById('timelineGlobalPrompt').value.trim(),
            sampling: {
                steps: Number(document.getElementById('timelineSteps').value),
                low_resolution_steps: Number(document.getElementById('timelineLowSteps').value),
                enable_drift_control: document.getElementById('timelineDrift').checked,
                enable_soft_audio: document.getElementById('timelineSoftAudio').checked
            },
            segments: this.segments.map(segment => ({ ...segment }))
        };
    },

    _validate(showToast) {
        const result = H3TimelinePlan.validatePlan(this._collectInput());
        const status = document.getElementById('timelineValidation');
        const planStatus = document.getElementById('timelinePlanStatus');
        status.textContent = result.valid ? '时间线校验通过' : result.errors[0];
        status.className = `timeline-validation ${result.valid ? 'valid' : 'invalid'}`;
        planStatus.textContent = result.valid ? '计划有效' : '需要修改';
        if (!result.valid && showToast) UI.toast(result.errors[0], 'error', 5000);
        return result;
    },

    previewPlan() {
        const result = this._validate(true);
        if (!result.valid) return null;
        document.getElementById('timelineJsonPreview').textContent = JSON.stringify(result.plan, null, 2);
        return result.plan;
    },

    async submit() {
        const plan = this.previewPlan();
        if (!plan) return;
        const button = document.getElementById('timelineSubmitBtn');
        button.disabled = true;
        button.textContent = '正在提交…';
        try {
            const task = await API.createTimelineVideoTask(plan);
            const taskId = task.id || task.task_id || task.data?.id;
            if (!taskId) throw new Error('后端未返回任务 ID');
            Logger.success(`[H3 时间线] 任务已创建: ${taskId || '未返回任务 ID'}`);
            UI.toast('长视频任务已提交', 'success');
            document.getElementById('timelinePlanStatus').textContent = `任务 ${taskId}`;
            this.activeTaskId = taskId;
            this._showTaskPanel(task.data || task);
            this._pollTask(taskId);
        } catch (error) {
            Logger.error(`[H3 时间线] ${error.message}`);
            UI.toast(`提交失败：${error.message}`, 'error', 6000);
        } finally {
            button.disabled = false;
            button.textContent = '提交长视频任务';
        }
    },

    _showTaskPanel(task) {
        document.getElementById('timelineTaskPanel').classList.remove('hidden');
        this._renderTaskProgress(task || {});
    },

    _renderTaskProgress(task) {
        const data = task.data || task;
        const progress = Math.max(0, Math.min(100, Number.parseFloat(data.progress) || 0));
        const status = String(data.status || 'queued').toLowerCase();
        const phaseLabels = {
            queued: '排队中', preparing: '准备模型', low_resolution_sampling: '低分辨率采样',
            high_resolution_sampling: '高分辨率采样', assembling: '合并音视频', completed: '已完成',
            failed: '失败', cancelled: '已取消', running: '生成中', processing: '生成中'
        };
        document.getElementById('timelineTaskStatus').textContent = phaseLabels[data.phase] || phaseLabels[status] || status;
        document.getElementById('timelineProgressFill').style.width = `${progress}%`;
        const current = Number(data.current_segment || 0);
        const total = Number(data.segment_count || this.segments.length);
        document.getElementById('timelineProgressText').textContent = `${Math.round(progress)}%${current ? ` · 分段 ${current}/${total}` : ''}`;

        const segmentStates = Array.isArray(data.segments) ? data.segments : this.segments.map((segment, index) => ({
            id: segment.id,
            status: current > index + 1 ? 'completed' : current === index + 1 ? 'running' : 'queued',
            progress: current > index + 1 ? 100 : current === index + 1 ? progress : 0
        }));
        document.getElementById('timelineSegmentProgress').innerHTML = segmentStates.map((segment, index) => {
            const pct = Math.max(0, Math.min(100, Number.parseFloat(segment.progress) || (segment.status === 'completed' ? 100 : 0)));
            return `<div class="timeline-segment-progress-row"><span>${index + 1}</span><div><i style="width:${pct}%"></i></div><em>${this._escape(segment.status || 'queued')}</em></div>`;
        }).join('');

        const terminal = ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'].includes(status);
        document.getElementById('timelineCancelTaskBtn').disabled = terminal;
        if (['completed', 'success', 'succeeded'].includes(status)) {
            document.getElementById('timelineProgressFill').style.width = '100%';
            const outputUrl = data.output?.url || data.url;
            if (outputUrl) {
                document.getElementById('timelineJsonPreview').textContent = JSON.stringify(data, null, 2);
                UI.toast('H3 长视频生成完成', 'success');
            }
        }
    },

    async _pollTask(taskId) {
        if (this.pollController) this.pollController.abort();
        this.pollController = new AbortController();
        const signal = this.pollController.signal;
        const terminal = ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'];
        while (!signal.aborted && this.activeTaskId === taskId) {
            try {
                const task = await API.getTimelineVideoTask(taskId, { signal });
                const data = task.data || task;
                this._renderTaskProgress(data);
                if (terminal.includes(String(data.status || '').toLowerCase())) {
                    this.activeTaskId = null;
                    return;
                }
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 5000);
                    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('已取消轮询', 'AbortError')); }, { once: true });
                });
            } catch (error) {
                if (error.name === 'AbortError') return;
                Logger.warn(`[H3 时间线] 查询任务失败，将重试: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 8000));
            }
        }
    },

    async cancelTask() {
        if (!this.activeTaskId) return;
        if (!(await UI.confirm('确定取消当前 H3 长视频任务吗？', { danger: true }))) return;
        const taskId = this.activeTaskId;
        try {
            const task = await API.cancelTimelineVideoTask(taskId);
            this.pollController?.abort();
            this.activeTaskId = null;
            this._renderTaskProgress(task);
            UI.toast('已请求取消任务', 'success');
        } catch (error) {
            Logger.error(`[H3 时间线] 取消失败: ${error.message}`);
            UI.toast(`取消失败：${error.message}`, 'error');
        }
    },

    _onChange(rerenderTrack = true) {
        if (rerenderTrack) this._renderTrack();
        else {
            this._renderTrack();
            document.querySelectorAll('.timeline-segment-card').forEach((card, index) => {
                const badge = card.querySelector('.timeline-overlap');
                const overlap = index ? Math.max(0, this.segments[index - 1].end - this.segments[index].start) : 0;
                badge.textContent = index ? `重叠 ${overlap.toFixed(2)} 秒` : '起始镜头';
            });
        }
        this._validate(false);
        this._saveDraft();
    },

    _saveDraft() {
        try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._collectInput())); } catch (error) { Logger.warn(`[H3 时间线] 草案保存失败: ${error.message}`); }
    },

    _loadDraft() {
        try {
            const draft = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || 'null');
            if (!draft || !Array.isArray(draft.segments)) return;
            this.segments = draft.segments;
            this._nextId = this.segments.length + 1;
            const values = {
                timelineModel: draft.model, timelineSize: draft.size, timelineFps: draft.fps,
                timelineSeed: draft.seed, timelineGlobalPrompt: draft.global_prompt,
                timelineSteps: draft.sampling?.steps, timelineLowSteps: draft.sampling?.low_resolution_steps
            };
            Object.entries(values).forEach(([id, value]) => { if (value !== undefined && value !== null) document.getElementById(id).value = value; });
            document.getElementById('timelineDrift').checked = draft.sampling?.enable_drift_control !== false;
            document.getElementById('timelineSoftAudio').checked = draft.sampling?.enable_soft_audio !== false;
        } catch (_) { localStorage.removeItem(this.STORAGE_KEY); }
    },

    _escape(value) {
        const node = document.createElement('div');
        node.textContent = String(value || '');
        return node.innerHTML;
    }
};
