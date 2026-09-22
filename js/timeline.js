/** H3 long-video timeline editor. */
const TimelineModule = {
    STORAGE_KEY: 'h3-timeline-draft-v1',
    segments: [],
    _nextId: 1,

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
            </article>`;
        }).join('');

        container.querySelectorAll('[data-field]').forEach(input => {
            input.addEventListener('input', event => this.updateSegment(Number(event.target.dataset.index), event.target.dataset.field, event.target.value));
        });
        container.querySelectorAll('[data-remove]').forEach(button => {
            button.addEventListener('click', () => this.removeSegment(Number(button.dataset.remove)));
        });
        this._renderTrack();
        this._validate(false);
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
            Logger.success(`[H3 时间线] 任务已创建: ${taskId || '未返回任务 ID'}`);
            UI.toast('长视频任务已提交', 'success');
            document.getElementById('timelinePlanStatus').textContent = taskId ? `任务 ${taskId}` : '已提交';
        } catch (error) {
            Logger.error(`[H3 时间线] ${error.message}`);
            UI.toast(`提交失败：${error.message}`, 'error', 6000);
        } finally {
            button.disabled = false;
            button.textContent = '提交长视频任务';
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
