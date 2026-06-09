# Demo 文件说明

## 替换占位文件

将以下占位文件替换为实际的 demo 截图和视频：

### 缩略图（PNG，建议 640×400，<100KB）
- `pptx-thumb.png` → PPT 生成的截图
- `html-thumb.png` → HTML 页面制作的截图
- `game-thumb.png` → 游戏脚本的截图

### 演示视频（MP4，建议 ≤720p，<5MB）
- `pptx-demo.mp4` → PPT 生成完整流程
- `html-demo.mp4` → HTML 页面制作完整流程
- `game-demo.mp4` → 游戏脚本运行流程

### 录制工具推荐
- macOS: QuickTime Player（文件 > 新建屏幕录制）
- Windows: Xbox Game Bar（Win+G）
- 跨平台: OBS Studio
- GIF 转 MP4: `ffmpeg -i demo.gif -c:v libx264 -pix_fmt yuv420p demo.mp4`

## 自定义卡片

编辑 `docs/index.html` 中 `demos` 数组，修改或增加卡片：

```javascript
const demos = [
  { title: '标题', desc: '描述', thumb: 'demos/xxx-thumb.png', src: 'demos/xxx-demo.mp4', type: 'video' },
  // 添加更多卡片...
];
```
