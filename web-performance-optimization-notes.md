# Web 性能优化实战笔记

> 基于「星空」个人主页项目（WebGL2 粒子系统 + 静态站点）的优化实践总结。
> 托管环境：4Mbps 带宽、128MB 空间、24GB 月流量的虚拟主机。

---

## 一、核心原则：关键渲染路径

浏览器渲染一个页面需要经历：**HTML → CSS → JS → 首屏绘制**。优化的核心思路就是让这条路径尽可能短。

### 关键概念

| 术语 | 含义 |
|------|------|
| FCP (First Contentful Paint) | 用户第一次看到内容的时间 |
| LCP (Largest Contentful Paint) | 最大内容绘制完成的时间 |
| TTI (Time to Interactive) | 页面可交互的时间 |
| CLS (Cumulative Layout Shift) | 布局抖动累积值 |

**目标**：FCP < 1.5s，LCP < 2.5s，即使在 4Mbps 带宽下。

---

## 二、内联 vs 外部文件：缓存策略

### 问题

把 CSS 和 JS 全部内联到 HTML 中（例如 index.html 有 49KB，其中 CSS 600 行 + JS 850 行），意味着：

1. **浏览器无法独立缓存 CSS/JS** — 每次访问都要重新下载全部代码
2. HTML 文件体积膨胀 — 首次解析就慢

### 解决方案：Critical CSS + External Files

```html
<head>
    <!-- 关键 CSS 内联：仅保留首屏渲染必需的样式 -->
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #0a0a18; }
        canvas#c { display: block; position: fixed; inset: 0; width: 100%; height: 100%; }
        #loading { /* loading 屏幕样式 */ }
    </style>
    <!-- 其余 CSS 外部加载（可缓存） -->
    <link rel="stylesheet" href="./static/css/index.css">
</head>
```

### 效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| index.html | 49 KB | 6.5 KB |
| CSS（外部，可缓存） | - | 11 KB |
| JS（外部，可缓存） | - | 31 KB |
| 二次访问传输量 | 49 KB | 6.5 KB（CSS/JS 命中缓存） |

### 关键认知

- **Critical CSS**：只把首次渲染必需的样式（body 背景色、canvas 布局、loading 指示器）内联
- **非关键 CSS 全部外部化**：overlay 元素、动画 keyframes、hover 效果等可以等外部 CSS 加载后再渲染
- **JS 放 body 末尾**：不阻塞 HTML 解析，等 DOM ready 后执行

---

## 三、图片优化

### 格式选择

| 格式 | 适用场景 | 压缩率 |
|------|----------|--------|
| WebP | 照片、复杂图像（替代 JPG/PNG） | 比 JPG 小 30-50%，比 PNG 小 50-70% |
| SVG | 图标、简单图形 | 矢量无损，但复杂路径可能很大 |
| PNG | 需要透明度的简单图像 | 适合色数少的图 |
| AVIF | 下一代格式（兼容性较差） | 比 WebP 再小 20% |

### 实际案例

```
starry-night.jpg (689 KB) → starry-night.webp (460 KB)   -33%
logo1.png        (679 KB) → logo1.webp        (348 KB)   -49%
sponsor.jpg       (62 KB) → sponsor.webp       (29 KB)   -53%
```

### 注意事项

- **不是所有图都适合转 WebP**：已经很小的 PNG（< 50KB）转 lossy WebP 可能反而更大
- **WebGL 纹理图可以激进压缩**：如果只是用来计算流场（降采样到 200px），原图质量不需要那么高
- **使用 `cwebp` 命令行工具**：`cwebp -q 80 input.jpg -o output.webp`

---

## 四、音频优化

### 立体声 vs 单声道

对于网页背景音乐，用户通常不需要立体声空间感。转为单声道可以显著减小文件体积。

```bash
# 转换为单声道 96kbps（背景音乐够用）
ffmpeg -i theme.mp3 -ac 1 -b:a 96k output.mp3

# 音效转为单声道 64kbps（短音效不需要高码率）
ffmpeg -i sound-effect.mp3 -ac 1 -b:a 64k output.mp3
```

### 实际案例

```
my-theme.mp3     (2020 KB, stereo 128k) → (1469 KB, mono 96k)    -27%
light-off.mp3     (129 KB, stereo 256k) → (32 KB, mono 64k)      -75%
light-on.mp3       (15 KB, stereo 256k) → (4 KB, mono 64k)       -73%
```

### 加载策略：不卡顿的核心方案

在低带宽环境（4Mbps）下，音频的流式播放（边下边播）容易导致缓冲卡顿。解决方案是**先完整下载到内存，再播放**：

```javascript
// ❌ 传统方式：流式加载，4Mbps 下容易卡顿
<audio src="./my-theme.mp3" preload="auto">

// ✅ 优化方式：整块下载到内存后播放
<audio id="bgMusic" loop preload="metadata">

// JS 中：页面空闲时预加载
function preloadMusic() {
    return fetch('./my-theme.mp3')
        .then(r => r.blob())
        .then(blob => {
            bgMusic.src = URL.createObjectURL(blob);
            // 此时音频数据全在内存中，播放绝不会卡顿
        });
}

// 利用 requestIdleCallback 在浏览器空闲时预加载
if ('requestIdleCallback' in window) {
    requestIdleCallback(() => preloadMusic());
} else {
    setTimeout(() => preloadMusic(), 3000);
}
```

### 为什么不用 `preload="auto"`？

`preload="auto"` 会让浏览器在页面加载早期就开始下载音频，与关键资源（HTML、CSS、WebGL 纹理）争抢带宽。在 4Mbps 带宽下，这直接拖慢首屏渲染。

### 为什么不用懒加载（Intersection Observer）？

懒加载适合图片，不适合音频。音频懒加载意味着用户点击播放时才开始下载，在低带宽下会造成可感知的延迟和卡顿。正确做法是**页面空闲时预加载到内存**，用户点击时立即播放。

---

## 五、服务端压缩（.htaccess）

### Gzip 压缩

对于文本类资源（HTML/CSS/JS/SVG/JSON），gzip 压缩通常能减少 60-80% 的传输量。这是**投入产出比最高的优化**。

```apache
# .htaccess
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html
    AddOutputFilterByType DEFLATE text/css
    AddOutputFilterByType DEFLATE application/javascript
    AddOutputFilterByType DEFLATE application/json
    AddOutputFilterByType DEFLATE image/svg+xml
</IfModule>
```

### 浏览器缓存

```apache
<IfModule mod_expires.c>
    ExpiresActive On
    # 图片/音频：30天（几乎不变的资源）
    ExpiresByType image/webp "access plus 30 days"
    ExpiresByType audio/mpeg "access plus 30 days"
    # CSS/JS：7天（可能会更新）
    ExpiresByType text/css "access plus 7 days"
    ExpiresByType application/javascript "access plus 7 days"
    # HTML：1小时（内容可能随时更新）
    ExpiresByType text/html "access plus 1 hour"
</IfModule>
```

### 在 4Mbps 下的效果估算

假设 index.css (11KB) + index.js (31KB) + starry-night.webp (460KB) + 音频 (1469KB)：

| 资源 | 原始大小 | Gzip 后约 | 节省 |
|------|----------|-----------|------|
| index.html | 6.5 KB | ~2 KB | 69% |
| index.css | 11 KB | ~3 KB | 73% |
| index.js | 31 KB | ~9 KB | 71% |
| SVG 文件 | ~420 KB | ~120 KB | 71% |
| **文本资源合计** | **~470 KB** | **~135 KB** | **71%** |

图片和音频是二进制格式，已经压缩过，gzip 对它们几乎无效。

---

## 六、WebGL 性能模式

### 已有的优秀实践

这个项目的 WebGL 部分已经做得很好：

1. **Instanced Rendering**：180,000 个粒子用 `gl.drawArraysInstanced` 一次调用渲染，而不是 180,000 次 draw call
2. **FBO Ping-Pong**：双缓冲避免读写同一纹理
3. **DPR 封顶 2.0**：`Math.min(devicePixelRatio, 2)` 防止 4K 屏幕性能暴跌
4. **移动端降粒子**：桌面 180K → 移动端 50K
5. **Typed Arrays**：`Float32Array` 直接操作，避免对象和 GC 开销

### 可进一步优化的方向

```javascript
// 动态帧率适配：检测到掉帧时自动降低粒子数
let lastFrameTime = 0;
let lowFpsCount = 0;

function render(timestamp) {
    const dt = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    // 连续 30 帧低于 30fps → 降低粒子数
    if (dt > 33) lowFpsCount++;
    else lowFpsCount = Math.max(0, lowFpsCount - 1);

    if (lowFpsCount > 30) {
        // 减少 20% 粒子
        activeParticles = Math.max(10000, activeParticles * 0.8);
        lowFpsCount = 0;
    }
    // ...
}
```

---

## 七、带宽约束下的资源加载策略

### 4Mbps = 500 KB/s 的实际体验

| 场景 | 传输量 | 耗时（4Mbps） |
|------|--------|---------------|
| 首次访问（全部资源） | ~2.5 MB | ~5 秒 |
| 二次访问（缓存命中） | ~6.5 KB (仅HTML) | < 0.1 秒 |
| 首屏渲染（关键路径） | ~475 KB (HTML+CSS+纹理) | ~1 秒 |

### 加载优先级策略

```
第一优先级（阻塞渲染）:
  ├── index.html (6.5 KB → gzip 2 KB)
  ├── index.css (11 KB → gzip 3 KB)
  └── index.js (31 KB → gzip 9 KB)

第二优先级（渲染启动后）:
  └── starry-night.webp (460 KB, JS 动态加载)

第三优先级（页面空闲时）:
  └── my-theme.mp3 (1469 KB, requestIdleCallback)

按需加载（用户操作触发）:
  ├── 音效 (click.mp3, light-*.mp3)
  └── 博客内容 (JSON + 子页面)
```

### 流量预算计算

```
24 GB / 月 ÷ 首次访问 ~2.5 MB ≈ 9,800 次访问/月
24 GB / 月 ÷ 二次访问 ~6.5 KB ≈ 3,800,000 次访问/月
```

对于个人主页来说完全够用。

---

## 八、关键概念总结

### 1. 分层缓存思维

| 层级 | 资源 | 缓存时长 | 原因 |
|------|------|----------|------|
| L1 浏览器内存 | 音频 blob URL | 会话期 | 播放零延迟 |
| L2 浏览器磁盘 | CSS/JS 文件 | 7 天 | 二次访问秒开 |
| L3 浏览器磁盘 | 图片/音频文件 | 30 天 | 几乎不变 |
| L4 服务端 | Gzip 压缩 | 每次请求 | 减少传输量 |

### 2. 不同类型资源的最佳实践

| 类型 | 格式 | 压缩手段 | 加载策略 |
|------|------|----------|----------|
| 关键 CSS | 内联 | Gzip | 同步 |
| 非关键 CSS | 外部 .css | Gzip + 缓存 | link rel=stylesheet |
| JS | 外部 .js | Gzip + 缓存 | body 末尾 |
| 照片 | WebP | 有损压缩 q=80 | 按需/预加载 |
| 背景音乐 | MP3 mono 96k | 码率降低 | requestIdleCallback |
| 音效 | MP3 mono 64k | 码率降低 | 按需加载 |
| 数据 | JSON | Gzip | fetch 按需 |
| 矢量图 | SVG | Gzip（效果显著） | 与 CSS 一起 |

### 3. 虚拟主机的限制与应对

| 限制 | 值 | 应对策略 |
|------|-----|----------|
| 带宽 | 4Mbps | Gzip + 图片压缩 + 缓存 |
| 空间 | 128MB | 只部署必要文件，去除截图等 |
| 月流量 | 24GB | 长缓存减少重复传输 |
| 无 CDN | - | .htaccess 配缓存头 + Gzip |

---

## 九、工具清单

| 用途 | 工具 | 命令示例 |
|------|------|----------|
| 图片转 WebP | cwebp | `cwebp -q 80 input.jpg -o output.webp` |
| 音频压缩 | ffmpeg | `ffmpeg -i in.mp3 -ac 1 -b:a 96k out.mp3` |
| SVG 压缩 | SVGO | `svgo input.svg -o output.svg` |
| 性能测试 | Lighthouse | Chrome DevTools → Lighthouse |
| 网络模拟 | Chrome DevTools | Network → Throttling → Custom (4Mbps) |
| Gzip 测试 | curl | `curl -H "Accept-Encoding: gzip" -I https://site.com` |

---

## 十、优化前后对比

### 首页首次加载

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| HTML 大小 | 49 KB | 6.5 KB | -87% |
| 核心纹理 | 689 KB (JPG) | 460 KB (WebP) | -33% |
| 背景音乐 | 2020 KB (stereo) | 1469 KB (mono) | -27% |
| 音效总计 | 150 KB | 41 KB | -73% |
| 可缓存资源 | 0% | 90%+ | -- |
| 首屏关键路径 | ~750 KB | ~475 KB | -37% |
| 加入 Gzip 后首屏 | ~750 KB | ~150 KB | -80% |

### 在 4Mbps 下的首屏体验

```
优化前：~750KB / 500KB/s = 1.5 秒首屏（无缓存）
优化后：~150KB / 500KB/s = 0.3 秒首屏（Gzip 压缩后）
二次访问：~2KB / 500KB/s = 即时（缓存命中）
```