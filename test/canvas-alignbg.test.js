// 画布：默认背景色 / 对齐排列 / Ctrl 框选 / 参考图序号标签 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('temp'), 'aistudio-alignbg-test'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const lines = [];
function assert(name, cond, extra) {
    if (cond) console.log(`PASS ${name}`);
    else { failures++; console.log(`FAIL ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
    lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
}

(async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await sleep(1800);

    await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.tab-btn[data-tab="canvas"]').click();
        const CM = CanvasModule;
        CM._projects().forEach(p => localStorage.removeItem('aistudio_canvas_project_' + p.id));
        localStorage.removeItem('aistudio_canvas_projects');
        localStorage.removeItem('aistudio_canvas_settings');
        return true;
    })()`);
    await sleep(1500);

    // ============ 1. 背景色默认值（默认按钮只重置颜色，不影响点/网格） ============
    const rBg = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const vp = document.getElementById('canvasViewport');
        const sel = document.getElementById('canvasBgStyle');
        const color = document.getElementById('canvasBgColor');
        const btn = document.getElementById('canvasBgDefaultBtn');
        const CM = CanvasModule;
        // 深色主题 + 无自定义色 → 默认黑
        document.documentElement.setAttribute('data-theme', 'dark');
        await new Promise(res => setTimeout(res, 100));
        r.darkBg = getComputedStyle(vp).backgroundColor;
        r.noDefaultOption = !sel.querySelector('option[value="default"]');
        r.hasDefaultBtn = !!btn;
        r.colorEnabled = !color.disabled;
        // 浅色主题（MutationObserver 联动）→ 默认 R170 G200 B185
        document.documentElement.setAttribute('data-theme', 'light');
        await new Promise(res => setTimeout(res, 100));
        r.lightBg = getComputedStyle(vp).backgroundColor;
        // 点阵图案 + 默认色共存（图案不影响底色默认值）
        sel.value = 'dots';
        sel.dispatchEvent(new Event('change'));
        await new Promise(res => setTimeout(res, 50));
        r.dotsWithDefaultColor = getComputedStyle(vp).backgroundColor;
        r.dotsCls = vp.classList.contains('bg-dots');
        // 自定义颜色
        color.value = '#ff8800';
        color.dispatchEvent(new Event('input'));
        await new Promise(res => setTimeout(res, 50));
        r.customColor = getComputedStyle(vp).backgroundColor;
        // 点「默认」按钮 → 清自定义色，恢复主题默认，且图案设置保持 dots
        btn.click();
        await new Promise(res => setTimeout(res, 50));
        r.restoredBg = getComputedStyle(vp).backgroundColor;
        r.bgColorCleared = (JSON.parse(localStorage.getItem('aistudio_canvas_settings')).bgColor || '') === '';
        r.styleKeptDots = vp.classList.contains('bg-dots') && sel.value === 'dots';
        return r;
    })()`);
    assert('bg.darkIsBlack', rBg.darkBg === 'rgb(0, 0, 0)', rBg.darkBg);
    assert('bg.lightIs170-200-185', rBg.lightBg === 'rgb(170, 200, 185)', rBg.lightBg);
    assert('bg.noDefaultOption', rBg.noDefaultOption === true, rBg.noDefaultOption);
    assert('bg.hasDefaultBtn', rBg.hasDefaultBtn === true, rBg.hasDefaultBtn);
    assert('bg.colorEnabled', rBg.colorEnabled === true, rBg.colorEnabled);
    assert('bg.dotsWithDefaultColor', rBg.dotsWithDefaultColor === 'rgb(170, 200, 185)', rBg.dotsWithDefaultColor);
    assert('bg.dotsClassApplied', rBg.dotsCls === true, rBg.dotsCls);
    assert('bg.customColor', rBg.customColor === 'rgb(255, 136, 0)', rBg.customColor);
    assert('bg.restoreClearsColor', rBg.restoredBg === 'rgb(170, 200, 185)', rBg.restoredBg);
    assert('bg.bgColorCleared', rBg.bgColorCleared === true, rBg.bgColorCleared);
    assert('bg.styleKeptDots', rBg.styleKeptDots === true, rBg.styleKeptDots);

    // ============ 2. 对齐与排列 ============
    const rAl = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const a = CM.addNode('text', 100, 300, {});
        const b = CM.addNode('text', 400, 100, {});
        const c = CM.addNode('text', 700, 200, {});
        r.alignBtnCount = document.querySelectorAll('.canvas-align-btn').length;
        // 左对齐
        CM.selection = new Set([a.id, b.id, c.id]);
        CM._renderSelection();
        r.before = { a: { x: a.x, y: a.y, w: a.w }, b: { x: b.x, y: b.y }, c: { x: c.x, y: c.y }, sel: CM.selection.size };
        CM._alignSelected('left');
        r.after = [a.x, b.x, c.x];
        // addNode 以坐标为中心放置（x=100 → 节点左缘=-20），对齐后全部等于最小 x
        r.leftAligned = a.x === b.x && b.x === c.x && a.x === -20;
        // 顶对齐
        CM._alignSelected('top');
        r.topAligned = a.y === b.y && b.y === c.y && a.y === 60;
        // 水平等距（排序后间距相等）
        a.x = 0; b.x = 400; c.x = 1000;
        CM._alignSelected('distX');
        const xs = [a.x, b.x, c.x];
        r.distXGaps = [xs[1] - xs[0], xs[2] - xs[1]];
        r.distXEven = Math.abs(r.distXGaps[0] - r.distXGaps[1]) <= 1;
        // 不足 2 个 → 无操作
        CM.selection = new Set([a.id]);
        const bx = b.x, by = b.y;
        CM._alignSelected('left');
        r.singleNoop = b.x === bx && b.y === by;
        // Ctrl 框选：模拟带 ctrlKey 的背景 mousedown
        const vp = document.getElementById('canvasViewport');
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ctrlKey: true });
        vp.dispatchEvent(ev);
        r.ctrlBoxSelect = CM._drag && CM._drag.type === 'select';
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));
        return r;
    })()`);
    assert('align.buttonsPresent', rAl.alignBtnCount === 8, rAl.alignBtnCount);
    assert('align.left', rAl.leftAligned, { after: rAl.after, before: rAl.before });
    assert('align.top', rAl.topAligned, rAl.topAligned);
    assert('align.distXEven', rAl.distXEven, rAl.distXGaps);
    assert('align.singleNoop', rAl.singleNoop, rAl.singleNoop);
    assert('align.ctrlBoxSelect', rAl.ctrlBoxSelect, rAl.ctrlBoxSelect);

    // ============ 3. 参考图序号标签 ============
    const rRef = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const i1 = CM.addNode('image', 1300, 100, { url: 'https://example.com/1.jpg', name: '第一张' });
        const i2 = CM.addNode('image', 1300, 300, { url: 'https://example.com/2.jpg', name: '第二张' });
        const v = CM.addNode('video', 1600, 200, { duration: 5, model: 'doubao-seedance-v4' });
        CM._connect(i1.id, v.id);
        CM._connect(i2.id, v.id);
        CM.renderEdges();
        const vel = document.querySelector('.cnode[data-id="' + v.id + '"]');
        let box = vel.querySelector('.cnode-ref-labels');
        r.labelsShown = !!box;
        r.labelTexts = box ? Array.from(box.querySelectorAll('.cnode-ref-label')).map(t => t.textContent) : [];
        r.firstLabelTitle = box?.querySelector('.cnode-ref-label')?.title || '';
        // 单图 → 不显示
        CM.deleteEdge(CM.edges.find(e => e.to === v.id).id);
        CM.renderEdges();
        r.singleNoLabels = !vel.querySelector('.cnode-ref-labels');
        // 点击标签选中来源节点
        CM._connect(i1.id, v.id);
        CM._connect(i2.id, v.id);
        CM.renderEdges();
        box = vel.querySelector('.cnode-ref-labels');
        const firstTag = box.querySelector('.cnode-ref-label');
        r.firstTagSrc = firstTag?.dataset.src;
        // 标签序号必须与生成时的上游媒体顺序一致（upstream 即 referenceImages 顺序）
        r.expectedSrc = CM.upstream(v.id).filter(m => m.type === 'image' || m.type === 'material')[0]?.id;
        r.selBeforeClick = Array.from(CM.selection);
        // 模拟真实鼠标序列：mousedown（曾被视频节点抢走选中）→ click
        firstTag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        firstTag.click();
        r.selAfterClick = Array.from(CM.selection);
        r.clickSelectsSource = CM.selection.has(r.expectedSrc);
        // 按下标签不应触发节点拖拽状态
        r.noNodeDragOnMousedown = !CM._drag || CM._drag.type !== 'node';
        // 标签点选 → 来源节点橘黄色高亮（ref-pick 类 + 橘色边框），普通选中仍是蓝色
        const srcEl = document.querySelector('.cnode[data-id="' + r.expectedSrc + '"]');
        r.srcHasRefPick = srcEl.classList.contains('ref-pick') && srcEl.classList.contains('selected');
        r.orangeBorder = getComputedStyle(srcEl).borderTopColor;
        // 普通点击其它节点 → 橘黄高亮清除，恢复蓝色（重渲染后需重新查询元素）
        CM._selectNode(v.id);
        const srcEl2 = document.querySelector('.cnode[data-id="' + r.expectedSrc + '"]');
        r.refPickCleared = !srcEl2.classList.contains('ref-pick');
        r.normalIsBlue = getComputedStyle(document.querySelector('.cnode[data-id="' + v.id + '"]')).borderTopColor;
        return r;
    })()`);
    assert('ref.labelsShown', rRef.labelsShown, rRef.labelsShown);
    assert('ref.twoLabels', rRef.labelTexts.length === 2, rRef.labelTexts);
    assert('ref.labelText', rRef.labelTexts[0] === '图片1' && rRef.labelTexts[1] === '图片2', rRef.labelTexts);
    assert('ref.titleHasName', rRef.firstLabelTitle.includes('第一张'), rRef.firstLabelTitle);
    assert('ref.singleNoLabels', rRef.singleNoLabels, rRef.singleNoLabels);
    assert('ref.clickSelectsSource', rRef.clickSelectsSource, { src: rRef.firstTagSrc, exp: rRef.expectedSrc, before: rRef.selBeforeClick, after: rRef.selAfterClick });
    assert('ref.noNodeDragOnMousedown', rRef.noNodeDragOnMousedown, rRef.noNodeDragOnMousedown);
    assert('ref.orangeHighlight', rRef.srcHasRefPick === true && rRef.orangeBorder === 'rgb(249, 115, 22)', { pick: rRef.srcHasRefPick, border: rRef.orangeBorder });
    assert('ref.pickClearedOnNormalSelect', rRef.refPickCleared === true && rRef.normalIsBlue === 'rgb(59, 130, 246)', { cleared: rRef.refPickCleared, border: rRef.normalIsBlue });
    // 标签文字显著性：字号≥11px、加粗、不透明
    rRef.labelStyle = await win.webContents.executeJavaScript(`(() => {
        const t = document.querySelector('.cnode-ref-label');
        const cs = getComputedStyle(t);
        return { fs: parseFloat(cs.fontSize), fw: cs.fontWeight, op: parseFloat(cs.opacity) };
    })()`);
    assert('ref.prominentStyle', rRef.labelStyle.fs >= 11 && parseInt(rRef.labelStyle.fw) >= 600 && rRef.labelStyle.op === 1, rRef.labelStyle);
    // 两种主题下标签都为鲜蓝底白字（不再随 --accent 反转导致深色模式下看不清）
    rRef.labelTheme = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        const t = document.querySelector('.cnode-ref-label');
        for (const th of ['light', 'dark']) {
            document.documentElement.setAttribute('data-theme', th);
            await new Promise(res => setTimeout(res, 350)); // 等主题过渡
            const cs = getComputedStyle(t);
            out[th] = { bg: cs.backgroundColor, color: cs.color };
        }
        return out;
    })()`);
    assert('ref.lightThemeBlueChip', rRef.labelTheme.light.bg === 'rgb(59, 130, 246)' && rRef.labelTheme.light.color === 'rgb(255, 255, 255)', rRef.labelTheme.light);
    assert('ref.darkThemeBlueChip', rRef.labelTheme.dark.bg === 'rgb(59, 130, 246)' && rRef.labelTheme.dark.color === 'rgb(255, 255, 255)', rRef.labelTheme.dark);

    // ============ 4. 固定按钮主题适配 + 项目重命名 ============
    const rMisc = await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        const CM = CanvasModule;
        const pin = document.getElementById('canvasToolbarPinBtn');
        // 浅色主题下固定 → 激活态应为浅色柔和底（rgba 黑 4%），而非深黑反色
        document.documentElement.setAttribute('data-theme', 'light');
        await new Promise(res => setTimeout(res, 400)); // 等主题过渡动画结束
        pin.click();
        await new Promise(res => setTimeout(res, 450)); // 等按钮背景 transition 结束
        r.pinActive = pin.classList.contains('active');
        r.pinBgLight = getComputedStyle(pin).backgroundColor;
        // 深色主题下 → 深色柔和底（rgba 白 5%）
        document.documentElement.setAttribute('data-theme', 'dark');
        await new Promise(res => setTimeout(res, 450));
        r.pinBgDark = getComputedStyle(pin).backgroundColor;
        pin.click(); // 还原
        document.documentElement.setAttribute('data-theme', 'light');
        await new Promise(res => setTimeout(res, 50));

        // 项目重命名：模拟真实双击序列（单击触发重渲染 → dblclick 落在新元素上）
        const list = document.getElementById('canvasProjectsList');
        if (CM._projects().length === 0) CM._createProject('重命名前的项目'); // setup 清过索引则重建
        CM._renderProjects();
        const pid = CM.currentProjectId;
        const item = list.querySelector('.canvas-project-item[data-id="' + pid + '"]');
        r.itemExists = !!item;
        item.click(); // 单击（活动项目也会 _renderProjects 重建列表）
        const item2 = list.querySelector('.canvas-project-item[data-id="' + pid + '"]');
        item2.querySelector('.canvas-project-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(res => setTimeout(res, 50));
        const input = list.querySelector('.canvas-project-rename');
        r.renameInputShown = !!input;
        if (input) {
            input.value = '重命名后的项目';
            input.dispatchEvent(new Event('blur')); // 无头环境无窗口焦点，显式触发提交
            await new Promise(res => setTimeout(res, 80));
        }
        r.renamed = CM._projects().find(x => x.id === pid)?.name === '重命名后的项目';
        // 非活动项目重命名（委托按 id 查实时元素）
        const pB = CM._createProject('待改名B');
        await new Promise(res => setTimeout(res, 50));
        const itemB = list.querySelector('.canvas-project-item[data-id="' + pB.id + '"]');
        itemB.querySelector('.canvas-project-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(res => setTimeout(res, 50));
        const inputB = list.querySelector('.canvas-project-rename');
        r.inactiveInputShown = !!inputB;
        if (inputB) {
            inputB.value = '改名B完成';
            inputB.dispatchEvent(new Event('blur'));
            await new Promise(res => setTimeout(res, 80));
        }
        r.inactiveRenamed = CM._projects().find(x => x.id === pB.id)?.name === '改名B完成';
        CM._loadProject(pid); // 还原当前项目
        return r;
    })()`);
    assert('pin.activeToggles', rMisc.pinActive === true, rMisc.pinActive);
    assert('pin.lightThemeSoftBg', rMisc.pinBgLight === 'rgba(0, 0, 0, 0.04)', rMisc.pinBgLight);
    assert('pin.darkThemeSoftBg', rMisc.pinBgDark === 'rgba(255, 255, 255, 0.05)', rMisc.pinBgDark);
    assert('proj.itemExists', rMisc.itemExists, rMisc.itemExists);
    assert('proj.renameInputShown', rMisc.renameInputShown, rMisc.renameInputShown);
    assert('proj.renamed', rMisc.renamed === true, rMisc.renamed);
    assert('proj.inactiveInputShown', rMisc.inactiveInputShown, rMisc.inactiveInputShown);
    assert('proj.inactiveRenamed', rMisc.inactiveRenamed === true, rMisc.inactiveRenamed);

    // 控制台错误已在各场景隐含（页面崩溃会抛异常）

    console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
    await sleep(300);
    fs.writeFileSync(path.join(__dirname, 'alignbg.result.txt'), `ALL=${failures === 0 ? 'PASS' : 'FAIL:' + failures}\n` + lines.join('\n') + '\n');
    app.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.log('TEST ERROR:', e.message);
    fs.writeFileSync(path.join(__dirname, 'alignbg.result.txt'), `ERROR:${e.message}\n`);
    app.exit(2);
});
