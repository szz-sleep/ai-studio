/** H3 long-video timeline editor. */
const TimelineModule = {
    STORAGE_KEY: 'h3-timeline-draft-v1',
    TASKS_KEY: 'h3-timeline-tasks-v1',
    segments: [],
    _nextId: 1,
    activeTaskId: null,
    jobs: [],
    pollControllers: new Map(),
    savingOutputs: new Set(),
    previewUrl: null,
    previewTaskId: null,
    assetPreviewUrls: new Map(),
    pendingUploads: new Map(),
    nextUploadId: 1,

    init() {
        const container = document.getElementById('timelineSegments');
        if (!container || typeof H3TimelinePlan === 'undefined') return;
        this._loadDraft();
        if (!this.segments.length) {
            this.segments = [
                this._newSegment(0, 175 / 24, ''),
                this._newSegment(153 / 24, 328 / 24, '')
            ];
        }

        document.getElementById('timelineAddSegmentBtn').addEventListener('click', () => this.addSegment());
        document.getElementById('timelinePreviewJsonBtn').addEventListener('click', () => this.previewPlan());
        document.getElementById('timelineSubmitBtn').addEventListener('click', () => this.submit());
        document.getElementById('timelineCancelTaskBtn').addEventListener('click', () => this.cancelTask());
        document.getElementById('timelineVideoMenuBtn').addEventListener('click', () => {
            const menu = document.getElementById('timelineVideoMenu');
            const expanded = menu.classList.toggle('hidden') === false;
            document.getElementById('timelineVideoMenuBtn').setAttribute('aria-expanded', String(expanded));
        });
        document.getElementById('timelineVideoDownloadBtn').addEventListener('click', () => this.downloadOutput());
        document.getElementById('timelineJobsList').addEventListener('click', event => {
            const remove = event.target.closest('[data-delete-task]');
            if (remove) { this.deleteTask(remove.dataset.deleteTask); return; }
            const button = event.target.closest('[data-task-id]');
            if (button) this.selectTask(button.dataset.taskId);
        });
        ['timelineModel', 'timelineSize', 'timelineFps', 'timelineSeed', 'timelineGlobalPrompt', 'timelineSteps', 'timelineLowSteps', 'timelineDrift', 'timelineSoftAudio']
            .forEach(id => document.getElementById(id)?.addEventListener('input', () => {
                if (id === 'timelineSize' || id === 'timelineSteps') this._syncUpscaleOptions();
                this._onChange();
            }));
        this._syncUpscaleOptions();
        window.addEventListener('beforeunload', () => {
            for (const url of this.assetPreviewUrls.values()) URL.revokeObjectURL(url);
        });
        this.render();
        this._loadJobs();
    },

    _scope() {
        return `${Config.getPlatform()}|${Config.getCurrentPlatformConfig().baseUrl || ''}`;
    },

    _saveJobs() {
        try { localStorage.setItem(this.TASKS_KEY, JSON.stringify(this.jobs.slice(0, 30))); }
        catch (error) { Logger.warn(`[H3 时间线] 无法保存任务列表: ${error.message}`); }
    },

    _loadJobs() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.TASKS_KEY) || '[]');
            this.jobs = Array.isArray(saved) ? saved.filter(job => job.scope === this._scope()).slice(0, 30) : [];
        } catch { this.jobs = []; }
        this._renderJobs();
        if (this.jobs.length) this.selectTask(this.jobs[0].id);
        this.jobs.forEach(job => this._pollTask(job.id));
    },

    _renderJobs() {
        const list = document.getElementById('timelineJobsList');
        list.innerHTML = this.jobs.length ? this.jobs.map(job => {
            const status = this._escape(job.status || 'queued');
            const date = new Date(job.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `<div class="timeline-job-row"><button type="button" class="timeline-job ${job.id === this.activeTaskId ? 'selected' : ''}" data-task-id="${this._escape(job.id)}"><span>${date} · ${this._escape(job.model)}</span><strong>${status} · ${Math.round(Number(job.progress) || 0)}%</strong></button><button type="button" class="timeline-job-delete" data-delete-task="${this._escape(job.id)}" aria-label="删除任务 ${this._escape(job.id)}" title="删除此任务">×</button></div>`;
        }).join('') : '<span class="timeline-jobs-empty">暂无任务</span>';
    },

    async deleteTask(taskId) {
        const job = this.jobs.find(item => item.id === taskId);
        if (!job) return;
        const terminal = ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'];
        const running = !terminal.includes(String(job.status || '').toLowerCase());
        const message = running ? '此任务仍在运行。删除将先取消生成，确定继续吗？' : '确定从 H3 任务列表删除此任务吗？';
        if (!(await UI.confirm(message, { danger: true }))) return;
        try {
            if (running) await API.cancelTimelineVideoTask(taskId);
        } catch (error) {
            UI.toast(`取消失败，任务未删除：${error.message}`, 'error');
            return;
        }
        this.pollControllers.get(taskId)?.abort();
        this.pollControllers.delete(taskId);
        this.jobs = this.jobs.filter(item => item.id !== taskId);
        this._saveJobs();
        if (this.activeTaskId === taskId) {
            this.activeTaskId = null;
            const video = document.getElementById('timelineOutputVideo');
            video.pause(); video.removeAttribute('src'); video.load();
            document.getElementById('timelineVideoWrap').classList.add('hidden');
            if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = null;
            this.previewTaskId = null;
            document.getElementById('timelineVideoMenu').classList.add('hidden');
            if (this.jobs.length) this.selectTask(this.jobs[0].id);
            else {
                document.getElementById('timelineTaskPanel').classList.add('hidden');
                document.getElementById('timelinePlanStatus').textContent = '等待编辑';
            }
        }
        this._renderJobs();
        UI.toast('H3 任务已从列表删除', 'success');
    },

    selectTask(taskId) {
        const job = this.jobs.find(item => item.id === taskId);
        if (!job) return;
        this.activeTaskId = taskId;
        this._renderJobs();
        document.getElementById('timelinePlanStatus').textContent = `任务 ${taskId}`;
        this._showTaskPanel(job.lastResponse || { status: job.status, progress: job.progress, segment_count: job.segmentCount });
        if (this.previewTaskId !== taskId) {
            const video = document.getElementById('timelineOutputVideo');
            video.pause(); video.removeAttribute('src'); video.load();
            document.getElementById('timelineVideoWrap').classList.add('hidden');
            if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = null;
            this.previewTaskId = null;
        }
        if (job.status === 'completed') this._showOutput(taskId);
    },

    _syncUpscaleOptions() {
        const size = document.getElementById('timelineSize').value;
        const low = document.getElementById('timelineLowSteps');
        const upscale = size === '1920x1080' || size === '1080x1920';
        low.disabled = !upscale;
        if (upscale && Number(low.value) >= Number(document.getElementById('timelineSteps').value)) {
            low.value = Math.max(1, Number(document.getElementById('timelineSteps').value) - 2);
        }
    },

    _newSegment(start, end, prompt) {
        return { id: `segment-${String(this._nextId++).padStart(2, '0')}`, start, end, prompt, assets: [] };
    },

    addSegment() {
        const previous = this.segments[this.segments.length - 1];
        const start = previous ? Math.max(0, previous.end - 22 / 24) : 0;
        const end = start + 175 / 24;
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
                <div class="timeline-assets-head"><span>H3 参考素材</span><button type="button" class="btn-secondary timeline-add-asset" data-add-asset="${index}">＋ 上传图片 / 视频 / 音频</button><input type="file" hidden data-upload-asset="${index}" accept="image/png,image/jpeg,video/*,audio/*" multiple></div>
                <div class="timeline-assets">${this._renderAssets(segment.assets || [], index)}</div>
                <div class="timeline-upload-list">${this._renderPendingUploads(segment.id)}</div>
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
        container.querySelectorAll('[data-upload-asset]').forEach(input => {
            input.addEventListener('change', async () => {
                const index = Number(input.dataset.uploadAsset);
                const files = Array.from(input.files || []);
                for (const file of files) await this.uploadAsset(index, file);
            });
        });
        container.querySelectorAll('[data-remove-asset]').forEach(button => {
            button.addEventListener('click', () => this.removeAsset(Number(button.dataset.segment), Number(button.dataset.removeAsset)));
        });
        container.querySelectorAll('[data-asset-role]').forEach(select => {
            select.addEventListener('change', event => {
                const asset = this.segments[Number(event.target.dataset.segment)]?.assets?.[Number(event.target.dataset.assetRole)];
                if (asset) { asset.role = event.target.value; this._onChange(false); }
            });
        });
        this._renderTrack();
        this._validate(false);
    },

    _renderAssets(assets, segmentIndex) {
        if (!assets.length) return '<span class="timeline-assets-empty">尚未分配素材</span>';
        return assets.map((asset, assetIndex) => {
            const src = this._escape(this.assetPreviewUrls.get(asset.id) || API._url(`/v1/video/timeline/assets/${encodeURIComponent(asset.id)}`));
            const media = asset.type === 'image' ? `<img src="${src}" alt="" loading="lazy">`
                : asset.type === 'video' ? `<video src="${src}" muted preload="metadata" playsinline></video>`
                : '<span class="timeline-asset-audio-icon" aria-hidden="true">♫</span>';
            const enlarged = asset.type === 'image' ? `<img src="${src}" alt="${this._escape(asset.name || '图片参考')}">`
                : asset.type === 'video' ? `<video src="${src}" controls preload="metadata" playsinline></video>`
                : `<audio src="${src}" controls preload="none"></audio>`;
            return `<span class="timeline-asset-chip asset-${asset.type}" tabindex="0" aria-label="${this._escape(asset.name || asset.id)}">
            <span class="timeline-asset-thumb">${media}</span>
            ${asset.type === 'video' ? `<select aria-label="视频参考方式" data-segment="${segmentIndex}" data-asset-role="${assetIndex}"><option value="guide" ${!['edit', 'boundary'].includes(asset.role) ? 'selected' : ''}>固定引导</option><option value="edit" ${asset.role === 'edit' ? 'selected' : ''}>可编辑参考</option><option value="boundary" ${asset.role === 'boundary' ? 'selected' : ''}>边界参考</option></select>` : ''}
            ${asset.type === 'audio' ? `<select aria-label="音频参考方式" data-segment="${segmentIndex}" data-asset-role="${assetIndex}"><option value="reference" ${asset.role !== 'locked' ? 'selected' : ''}>参考音频</option><option value="locked" ${asset.role === 'locked' ? 'selected' : ''}>保留原音</option></select>` : ''}
            <button type="button" data-segment="${segmentIndex}" data-remove-asset="${assetIndex}" aria-label="移除素材">×</button>
            <span class="timeline-asset-popover">${enlarged}</span>
        </span>`;
        }).join('');
    },

    _renderPendingUploads(segmentId) {
        return Array.from(this.pendingUploads.values()).filter(item => item.segmentId === segmentId).map(item =>
            `<div class="timeline-upload-item" data-upload-id="${item.id}" role="status">
                <div><span>${this._escape(item.name)}</span><strong data-upload-label>${item.progress === 100 ? '处理中…' : `${item.progress}%`}</strong></div>
                <div class="timeline-upload-track"><i data-upload-fill style="width:${item.progress}%"></i></div>
            </div>`).join('');
    },

    _updateUploadProgress(id, progress) {
        const item = this.pendingUploads.get(id);
        if (!item) return;
        item.progress = progress;
        const row = Array.from(document.querySelectorAll('[data-upload-id]')).find(node => node.dataset.uploadId === id);
        if (!row) return;
        row.querySelector('[data-upload-fill]').style.width = `${progress}%`;
        row.querySelector('[data-upload-label]').textContent = progress === 100 ? '处理中…' : `${progress}%`;
    },

    openAssetPicker(segmentIndex) {
        document.querySelector(`[data-upload-asset="${segmentIndex}"]`)?.click();
    },

    async uploadAsset(segmentIndex, file) {
        const segment = this.segments[segmentIndex];
        if (!segment) return;
        const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : '';
        if (!type || (type === 'image' && segment.assets.filter(a => a.type === type).length >= 9) ||
            (type === 'audio' && segment.assets.filter(a => a.type === type).length >= 3)) {
            UI.toast('素材格式不支持或本段素材已达到上限', 'error'); return;
        }
        const uploadId = `upload-${this.nextUploadId++}`;
        this.pendingUploads.set(uploadId, { id: uploadId, segmentId: segment.id, name: file.name, progress: 0 });
        this.render();
        try {
            const uploaded = await API.uploadTimelineAsset(file, progress => this._updateUploadProgress(uploadId, progress));
            if (!this.segments.includes(segment)) return;
            segment.assets.push({ id: uploaded.id, name: file.name, type: uploaded.type, uri: uploaded.uri, role: 'reference' });
            this.assetPreviewUrls.set(uploaded.id, URL.createObjectURL(file));
            this._saveDraft();
            UI.toast(`已上传 H3 素材：${file.name}`, 'success');
        } catch (error) { UI.toast(`上传失败：${error.message}`, 'error'); }
        finally { this.pendingUploads.delete(uploadId); this.render(); }
    },

    removeAsset(segmentIndex, assetIndex) {
        const segment = this.segments[segmentIndex];
        if (!segment) return;
        const removed = segment.assets?.[assetIndex];
        const previewUrl = removed && this.assetPreviewUrls.get(removed.id);
        if (previewUrl) { URL.revokeObjectURL(previewUrl); this.assetPreviewUrls.delete(removed.id); }
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
        if (this.pendingUploads.size) {
            UI.toast('请等待 H3 参考素材上传完成', 'warn');
            return;
        }
        const plan = this.previewPlan();
        if (!plan) return;
        document.getElementById('timelineVideoMenu').classList.add('hidden');
        document.getElementById('timelineVideoMenuBtn').setAttribute('aria-expanded', 'false');
        const button = document.getElementById('timelineSubmitBtn');
        button.disabled = true;
        button.textContent = '正在提交…';
        try {
            const task = await API.createTimelineVideoTask(plan);
            const taskId = task.id || task.task_id || task.data?.id;
            if (!taskId) throw new Error('后端未返回任务 ID');
            Logger.success(`[H3 时间线] 任务已创建: ${taskId || '未返回任务 ID'}`);
            UI.toast('长视频任务已提交', 'success');
            this.jobs.unshift({ id: taskId, scope: this._scope(), time: Date.now(), model: plan.model,
                prompt: plan.global_prompt || plan.segments[0]?.prompt || '', segmentCount: plan.segments.length,
                status: 'queued', progress: 0, lastResponse: task.data || task });
            this.jobs = this.jobs.slice(0, 30);
            this._saveJobs();
            this.selectTask(taskId);
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
            queued: '排队中', preparing: '准备参考素材', submitting: '提交 ComfyUI 工作流', low_resolution_sampling: '低分辨率采样',
            high_resolution_sampling: '高分辨率采样', assembling: '合并音视频', sampling: '工作流生成中',
            transferring: '正在取回视频', reconnecting: '等待 ComfyUI 响应', completed: '已完成',
            failed: '失败', cancelled: '已取消', cancelling: '正在取消', running: '生成中', processing: '生成中'
        };
        document.getElementById('timelineTaskStatus').textContent = phaseLabels[data.phase] || phaseLabels[status] || status;
        document.getElementById('timelineProgressFill').style.width = `${progress}%`;
        const current = Number(data.current_segment || 0);
        const total = Number(data.segment_count || this.jobs.find(job => job.id === this.activeTaskId)?.segmentCount || this.segments.length);
        document.getElementById('timelineProgressText').textContent = status === 'failed' && data.error
            ? `失败：${String(data.error).slice(0, 500)}`
            : `${Math.round(progress)}%${status === 'completed' ? ` · ${total} 段完成` : data.phase === 'sampling' && total > 1 ? ` · ${total} 段工作流生成中` : current ? ` · 分段 ${current}/${total}` : ''}`;

        const segmentStates = Array.isArray(data.segments) ? data.segments : Array.from({ length: total }, (_, index) => ({
            id: `segment-${index + 1}`,
            status: status === 'completed' ? 'completed' : data.phase === 'sampling' ? 'processing' : current > index + 1 ? 'completed' : current === index + 1 ? 'running' : 'queued',
            progress: status === 'completed' || current > index + 1 ? 100 : data.phase === 'sampling' ? 0 : current === index + 1 ? progress : 0
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
                const taskId = data.id || data.task_id || this.activeTaskId;
                if (taskId === this.activeTaskId) this._showOutput(taskId);
            }
        }
    },

    async _showOutput(taskId) {
        if (!taskId) return;
        if (this.previewTaskId === taskId) return;
        const job = this.jobs.find(item => item.id === taskId);
        if (job?.localUrl) {
            if (this.activeTaskId === taskId) {
                const video = document.getElementById('timelineOutputVideo');
                video.src = job.localUrl;
                this.previewTaskId = taskId;
                document.getElementById('timelineVideoWrap').classList.remove('hidden');
            }
            return;
        }
        if (this.savingOutputs.has(taskId)) return;
        this.savingOutputs.add(taskId);
        try {
            const blob = await API.downloadTimelineVideoTask(taskId);
            let localUrl = null;
            if (window.electronAPI?.saveHistoryVideo) {
                const saved = await window.electronAPI.saveHistoryVideo({ bytes: await blob.arrayBuffer(), filename: taskId });
                if (saved?.ok) {
                    localUrl = saved.fileUrl;
                    if (job) { job.localUrl = localUrl; this._saveJobs(); }
                    if (typeof History !== 'undefined' && !History.getAll().some(item => item.taskId === taskId)) {
                        await History.add({ type: 'video', url: localUrl, taskId,
                            prompt: job?.prompt || '(H3 长视频)', model: job?.model || 'minimax-h3', time: job?.time || Date.now() });
                    }
                } else Logger.warn(`[H3 时间线] 保存历史视频失败: ${saved?.error || '未知错误'}`);
            }
            if (this.activeTaskId === taskId) {
                if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
                this.previewUrl = localUrl ? null : URL.createObjectURL(blob);
                const video = document.getElementById('timelineOutputVideo');
                video.src = localUrl || this.previewUrl;
                this.previewTaskId = taskId;
                document.getElementById('timelineVideoWrap').classList.remove('hidden');
                UI.toast('H3 长视频已生成，可以预览', 'success');
            }
        } catch (error) {
            UI.toast(`预览加载失败：${error.message}`, 'error');
        } finally {
            this.savingOutputs.delete(taskId);
        }
    },

    downloadOutput() {
        if (!this.previewTaskId) return;
        const url = document.getElementById('timelineOutputVideo').src;
        if (!url) return;
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.previewTaskId}.mp4`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        document.getElementById('timelineVideoMenu').classList.add('hidden');
        document.getElementById('timelineVideoMenuBtn').setAttribute('aria-expanded', 'false');
    },

    async _pollTask(taskId) {
        if (this.pollControllers.has(taskId)) return;
        const controller = new AbortController();
        this.pollControllers.set(taskId, controller);
        const signal = controller.signal;
        const terminal = ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'];
        while (!signal.aborted) {
            try {
                const task = await API.getTimelineVideoTask(taskId, { signal });
                if (!this.jobs.some(item => item.id === taskId)) {
                    this.pollControllers.delete(taskId);
                    return;
                }
                const data = task.data || task;
                const job = this.jobs.find(item => item.id === taskId);
                if (job) {
                    job.status = String(data.status || 'running').toLowerCase();
                    job.progress = Number(data.progress) || 0;
                    job.lastResponse = data;
                    this._saveJobs();
                    this._renderJobs();
                }
                if (this.activeTaskId === taskId) this._renderTaskProgress(data);
                if (terminal.includes(String(data.status || '').toLowerCase())) {
                    if (['completed', 'success', 'succeeded'].includes(String(data.status).toLowerCase())) {
                        await this._showOutput(taskId);
                    }
                    this.pollControllers.delete(taskId);
                    return;
                }
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 2000);
                    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('已取消轮询', 'AbortError')); }, { once: true });
                });
            } catch (error) {
                if (error.name === 'AbortError') { this.pollControllers.delete(taskId); return; }
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
            const job = this.jobs.find(item => item.id === taskId);
            if (job) { job.status = String(task.status || 'cancelling'); job.lastResponse = task; this._saveJobs(); this._renderJobs(); }
            this._renderTaskProgress(task);
            if (String(task.status).toLowerCase() === 'cancelled') {
                this.pollControllers.get(taskId)?.abort();
            }
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
                timelineModel: draft.model, timelineSize: draft.size === '1536x832' ? '1344x768' : draft.size, timelineFps: draft.fps,
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
