/* global Vue, ElementPlus, LabelRender */
// 打印模板设计器：拖放组件、移动/缩放、属性编辑、多模板管理、导入导出。
(function () {
  const { ref, computed, onMounted, onBeforeUnmount } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;
  const PX_PER_MM = 96 / 25.4;
  const snap = (v) => Math.round(v * 2) / 2; // 0.5mm 对齐
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const TYPE_LABEL = { text: $t('文本'), field: $t('字段'), barcode: $t('条形码'), qrcode: $t('二维码'), image: $t('图片'), hline: $t('横线'), vline: $t('竖线'), rect: $t('矩形'), ellipse: $t('椭圆') };
  const ICONS = {
    text: 'T', field: '≡', barcode: '▥', qrcode: '▦', image: '▣', hline: '—', vline: '│', rect: '□', ellipse: '○',
  };

  window.LabelDesigner = {
    name: 'LabelDesigner',
    props: { s: { type: Object, required: true } },
    emits: ['test-print'],
    setup(props, { emit }) {
      const s = props.s;
      const zoom = ref(4);
      const selectedId = ref('');
      const canvas = ref(null);
      const sample = LabelRender.sampleData();

      const tpl = computed(() => s.templates.find((t) => t.id === s.activeTemplate) || s.templates[0]);
      const selected = computed(() => tpl.value?.elements.find((e) => e.id === selectedId.value) || null);
      const fieldOptions = Object.entries(LabelRender.FIELDS).map(([value, f]) => ({ value, label: f.label }));
      const elHtml = (el) => LabelRender.elementInner(el, { ...sample, codeText: codePreview() }, tpl.value);
      const codePreview = () => (s.code.prefixEnabled ? s.code.prefix || '' : '') + '45';

      // ---------- 组件增删 ----------
      function addElement(item, x, y) {
        const t = tpl.value;
        const el = {
          id: uid(),
          type: item.type,
          x: snap(Math.max(0, Math.min(x ?? 1, t.width - 2))),
          y: snap(Math.max(0, Math.min(y ?? 1, t.height - 2))),
          w: Math.min(item.w, t.width),
          h: Math.min(item.h, t.height),
          ...JSON.parse(JSON.stringify(item.props)),
        };
        t.elements.push(el);
        selectedId.value = el.id;
      }
      function removeSelected() {
        const t = tpl.value;
        const i = t.elements.findIndex((e) => e.id === selectedId.value);
        if (i >= 0) t.elements.splice(i, 1);
        selectedId.value = '';
      }
      function duplicateSelected() {
        if (!selected.value) return;
        const el = { ...JSON.parse(JSON.stringify(selected.value)), id: uid() };
        el.x = snap(el.x + 1);
        el.y = snap(el.y + 1);
        tpl.value.elements.push(el);
        selectedId.value = el.id;
      }
      function moveLayer(dir) {
        const els = tpl.value.elements;
        const i = els.findIndex((e) => e.id === selectedId.value);
        const j = dir === 'up' ? i + 1 : i - 1;
        if (i < 0 || j < 0 || j >= els.length) return;
        [els[i], els[j]] = [els[j], els[i]];
      }

      // ---------- 拖放（从组件面板拖到画布） ----------
      let dragItem = null;
      function onPaletteDragStart(item, e) {
        dragItem = item;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', item.label);
      }
      function onCanvasDrop(e) {
        if (!dragItem) return;
        const rect = canvas.value.getBoundingClientRect();
        const scale = rect.width / tpl.value.width; // 屏幕像素 / mm
        addElement(dragItem, (e.clientX - rect.left) / scale - dragItem.w / 2, (e.clientY - rect.top) / scale - dragItem.h / 2);
        dragItem = null;
      }

      // ---------- 画布内移动 / 缩放 ----------
      let action = null;
      function startDrag(el, mode, e) {
        selectedId.value = el.id;
        const rect = canvas.value.getBoundingClientRect();
        action = { el, mode, sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h, scale: rect.width / tpl.value.width };
        e.preventDefault();
        e.stopPropagation();
      }
      function onMouseMove(e) {
        if (!action) return;
        const { el, mode, sx, sy, ox, oy, ow, oh, scale } = action;
        const dx = (e.clientX - sx) / scale;
        const dy = (e.clientY - sy) / scale;
        const t = tpl.value;
        if (mode === 'move') {
          el.x = snap(Math.max(-el.w + 1, Math.min(t.width - 1, ox + dx)));
          el.y = snap(Math.max(-el.h + 1, Math.min(t.height - 1, oy + dy)));
        } else {
          el.w = snap(Math.max(1, ow + dx));
          el.h = snap(Math.max(0.5, oh + dy));
        }
      }
      function onMouseUp() {
        action = null;
      }
      function onKey(e) {
        if (!selected.value) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        const step = e.shiftKey ? 2 : 0.5;
        const el = selected.value;
        if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
        else if (e.key === 'ArrowLeft') el.x = snap(el.x - step);
        else if (e.key === 'ArrowRight') el.x = snap(el.x + step);
        else if (e.key === 'ArrowUp') el.y = snap(el.y - step);
        else if (e.key === 'ArrowDown') el.y = snap(el.y + step);
        else return;
        e.preventDefault();
      }
      onMounted(() => {
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('keydown', onKey);
      });
      onBeforeUnmount(() => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('keydown', onKey);
      });

      // ---------- 图片 ----------
      function pickImage() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const f = input.files[0];
          if (!f) return;
          if (f.size > 1024 * 1024) return ElMessage.warning($t('图片请小于 1MB'));
          const r = new FileReader();
          r.onload = () => {
            selected.value.src = r.result;
          };
          r.readAsDataURL(f);
        };
        input.click();
      }

      // ---------- 模板管理 ----------
      async function newTemplate(copy) {
        const base = copy ? JSON.parse(JSON.stringify(tpl.value)) : { width: tpl.value.width, height: tpl.value.height, dateFormat: 'MM/DD HH:mm:ss', elements: [] };
        const { value } = await ElMessageBox.prompt($t('模板名称'), copy ? $t('复制模板') : $t('新建模板'), {
          inputValue: copy ? base.name + $t(' 副本') : $t('新模板({0}*{1})', base.width, base.height),
        }).catch(() => ({}));
        if (!value) return;
        const t = { ...base, id: uid(), name: value };
        t.elements.forEach((e) => (e.id = uid()));
        s.templates.push(t);
        s.activeTemplate = t.id;
        selectedId.value = '';
      }
      async function deleteTemplate() {
        if (s.templates.length <= 1) return ElMessage.warning($t('至少保留一个模板'));
        const ok = await ElMessageBox.confirm($t('删除模板「{0}」？', tpl.value.name), $t('删除模板'), { type: 'warning' }).catch(() => false);
        if (!ok) return;
        const i = s.templates.indexOf(tpl.value);
        s.templates.splice(i, 1);
        s.activeTemplate = s.templates[0].id;
      }
      async function clearTemplate() {
        const ok = await ElMessageBox.confirm($t('清空当前模板的所有组件？'), $t('清空'), { type: 'warning' }).catch(() => false);
        if (ok) tpl.value.elements.splice(0);
      }
      function rotatePaper() {
        const t = tpl.value;
        [t.width, t.height] = [t.height, t.width];
      }
      async function exportTemplate() {
        const res = await window.api.invoke('template:export', JSON.parse(JSON.stringify(tpl.value)));
        if (res?.ok) ElMessage.success($t('已导出：') + res.filePath);
      }
      async function importTemplate() {
        const t = await window.api.invoke('template:import');
        if (!t) return;
        if (!Array.isArray(t.elements) || !t.width || !t.height) return ElMessage.error($t('不是有效的模板文件'));
        t.id = uid();
        t.elements.forEach((e) => (e.id = uid()));
        t.name = t.name || $t('导入的模板');
        s.templates.push(t);
        s.activeTemplate = t.id;
        ElMessage.success($t('已导入：') + t.name);
      }

      return {
        zoom, selectedId, canvas, tpl, selected, fieldOptions, elHtml, palette: LabelRender.PALETTE, dateFormats: LabelRender.DATE_FORMATS,
        TYPE_LABEL, ICONS, PX_PER_MM,
        addElement, removeSelected, duplicateSelected, moveLayer, onPaletteDragStart, onCanvasDrop, startDrag, pickImage,
        newTemplate, deleteTemplate, clearTemplate, rotatePaper, exportTemplate, importTemplate,
        testPrint: () => emit('test-print'),
      };
    },
    template: `
<div class="designer">
  <div class="designer-top">
    <span>{{ $t('模板') }}</span>
    <el-select v-model="s.activeTemplate" size="small" style="width:200px">
      <el-option v-for="t in s.templates" :key="t.id" :label="t.name" :value="t.id"></el-option>
    </el-select>
    <el-input v-model="tpl.name" size="small" style="width:170px" :placeholder="$t('模板名称')"></el-input>
    <el-button size="small" @click="newTemplate(false)">{{ $t('新建') }}</el-button>
    <el-button size="small" @click="newTemplate(true)">{{ $t('复制') }}</el-button>
    <el-button size="small" type="danger" plain @click="deleteTemplate">{{ $t('删除') }}</el-button>
    <el-button size="small" @click="exportTemplate">{{ $t('导出模板') }}</el-button>
    <el-button size="small" @click="importTemplate">{{ $t('导入模板') }}</el-button>
    <el-button size="small" type="danger" plain @click="clearTemplate">{{ $t('清空') }}</el-button>
    <el-button size="small" type="primary" @click="testPrint">{{ $t('打印测试') }}</el-button>
  </div>
  <div class="designer-top">
    <span>{{ $t('纸张 宽') }}</span>
    <el-input-number v-model="tpl.width" :min="10" :max="150" :step="1" size="small" controls-position="right" style="width:90px"></el-input-number>
    <span>{{ $t('mm 高') }}</span>
    <el-input-number v-model="tpl.height" :min="10" :max="150" :step="1" size="small" controls-position="right" style="width:90px"></el-input-number>
    <span>mm</span>
    <el-button size="small" @click="rotatePaper">{{ $t('宽高互换') }}</el-button>
    <span class="ml8">{{ $t('缩放') }}</span>
    <el-slider v-model="zoom" :min="2" :max="8" :step="0.5" style="width:120px" :format-tooltip="v => v * 100 + '%'"></el-slider>
    <span class="ml8">{{ $t('日期格式') }}</span>
    <el-select v-model="tpl.dateFormat" size="small" style="width:170px">
      <el-option v-for="f in dateFormats" :key="f" :label="f" :value="f"></el-option>
    </el-select>
  </div>
  <div class="designer-body">
    <div class="palette">
      <div class="muted small">{{ $t('拖到画布，或点击添加') }}</div>
      <div class="palette-grid">
        <div v-for="item in palette" :key="item.label" class="palette-item" draggable="true"
             @dragstart="onPaletteDragStart(item, $event)" @click="addElement(item)">
          <span class="palette-icon">{{ ICONS[item.type] }}</span>{{ item.label }}
        </div>
      </div>
      <div class="muted small mt8">{{ $t('方向键微调 0.5mm（Shift 2mm），Delete 删除') }}</div>
    </div>

    <div class="stage" @mousedown.self="selectedId = ''">
      <div class="stage-inner" :style="{ zoom: zoom }">
        <div ref="canvas" class="label-root design-canvas" :style="{ width: tpl.width + 'mm', height: tpl.height + 'mm' }"
             @dragover.prevent @drop.prevent="onCanvasDrop" @mousedown.self="selectedId = ''">
          <div v-for="el in tpl.elements" :key="el.id" class="lb-el design-el" :class="{ selected: el.id === selectedId }"
               :style="{ left: el.x + 'mm', top: el.y + 'mm', width: el.w + 'mm', height: el.h + 'mm' }"
               @mousedown="startDrag(el, 'move', $event)">
            <div class="design-el-inner" v-html="elHtml(el)"></div>
            <div v-if="el.id === selectedId" class="resize-handle" @mousedown="startDrag(el, 'resize', $event)"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="props">
      <template v-if="selected">
        <div class="props-title">{{ TYPE_LABEL[selected.type] }}{{ $t('属性') }}</div>
        <el-form label-width="64px" size="small">
          <el-form-item :label="$t('位置')">
            X <el-input-number v-model="selected.x" :step="0.5" controls-position="right" style="width:78px"></el-input-number>
            Y <el-input-number v-model="selected.y" :step="0.5" controls-position="right" style="width:78px"></el-input-number>
          </el-form-item>
          <el-form-item :label="$t('大小')">
            {{ $t('宽') }} <el-input-number v-model="selected.w" :min="0.5" :step="0.5" controls-position="right" style="width:78px"></el-input-number>
            {{ $t('高') }} <el-input-number v-model="selected.h" :min="0.5" :step="0.5" controls-position="right" style="width:78px"></el-input-number>
          </el-form-item>
          <el-form-item v-if="selected.type === 'text'" :label="$t('文字')">
            <el-input v-model="selected.text"></el-input>
          </el-form-item>
          <el-form-item v-if="['field','barcode','qrcode'].includes(selected.type)" :label="$t('内容')">
            <el-select v-model="selected.field">
              <el-option v-for="f in fieldOptions" :key="f.value" :label="f.label" :value="f.value"></el-option>
              <el-option v-if="selected.type === 'qrcode'" :label="$t('自定义文字')" value="custom"></el-option>
            </el-select>
          </el-form-item>
          <el-form-item v-if="selected.type === 'qrcode' && selected.field === 'custom'" :label="$t('文字')">
            <el-input v-model="selected.text" :placeholder="$t('如店铺链接')"></el-input>
          </el-form-item>
          <template v-if="selected.type === 'field'">
            <el-form-item :label="$t('前缀')"><el-input v-model="selected.prefix" :placeholder="$t('如 ma:')"></el-input></el-form-item>
            <el-form-item :label="$t('后缀')"><el-input v-model="selected.suffix" :placeholder="$t('如 đ')"></el-input></el-form-item>
          </template>
          <template v-if="selected.type === 'text' || selected.type === 'field'">
            <el-form-item :label="$t('字号(mm)')"><el-input-number v-model="selected.fontSize" :min="1" :max="40" :step="0.2" controls-position="right"></el-input-number></el-form-item>
            <el-form-item :label="$t('样式')">
              <el-checkbox v-model="selected.bold">{{ $t('粗体') }}</el-checkbox>
              <el-checkbox v-model="selected.wrap">{{ $t('自动换行') }}</el-checkbox>
              <el-checkbox v-model="selected.border">{{ $t('边框') }}</el-checkbox>
            </el-form-item>
            <el-form-item :label="$t('对齐')">
              <el-radio-group v-model="selected.align">
                <el-radio-button value="left">{{ $t('左') }}</el-radio-button>
                <el-radio-button value="center">{{ $t('中') }}</el-radio-button>
                <el-radio-button value="right">{{ $t('右') }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </template>
          <el-form-item v-if="selected.type === 'barcode'" :label="$t('显示')">
            <el-checkbox v-model="selected.showText">{{ $t('条码下方显示文字') }}</el-checkbox>
          </el-form-item>
          <el-form-item v-if="selected.type === 'image'" :label="$t('图片')">
            <el-button @click="pickImage">{{ $t('选择图片') }}</el-button>
          </el-form-item>
          <el-form-item v-if="['hline','vline','rect','ellipse'].includes(selected.type)" :label="$t('线宽(mm)')">
            <el-input-number v-model="selected.lineWidth" :min="0.1" :max="3" :step="0.05" controls-position="right"></el-input-number>
          </el-form-item>
          <el-form-item>
            <el-button @click="duplicateSelected">{{ $t('复制') }}</el-button>
            <el-button @click="moveLayer('up')">{{ $t('上移一层') }}</el-button>
            <el-button @click="moveLayer('down')">{{ $t('下移一层') }}</el-button>
          </el-form-item>
          <el-form-item><el-button type="danger" @click="removeSelected">{{ $t('删除组件') }}</el-button></el-form-item>
        </el-form>
      </template>
      <div v-else class="muted small">{{ $t('点击画布上的组件编辑属性。') }}<br><br>{{ $t('预览用的是示例数据；打印时会替换成真实的用户名、编号、弹幕内容。') }}</div>
    </div>
  </div>
</div>`,
  };
})();
