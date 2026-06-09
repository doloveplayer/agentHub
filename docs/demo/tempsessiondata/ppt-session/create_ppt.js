const pptxgen = require("pptxgenjs");

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE"; // 16:9

// ==================== 第1页：《十年》 ====================
// 风格：忧伤怀旧，冷色调，极简
const slide1 = pptx.addSlide();
slide1.background = { type: "solid", color: "1B2838" }; // 深蓝灰

// 左侧竖线装饰
slide1.addShape(pptx.ShapeType.rect, {
  x: 0.6, y: 0.8, w: 0.04, h: 3.5,
  fill: { color: "5B7B9A" },
});

// 歌名
slide1.addText("十 年", {
  x: 0.9, y: 0.9, w: 5, h: 1.2,
  fontSize: 48, fontFace: "Microsoft YaHei",
  color: "C8D6E5", bold: true,
});

// 副标题
slide1.addText("—— 如果那两个字没有颤抖", {
  x: 0.9, y: 2.0, w: 5, h: 0.6,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: "5B7B9A", italic: true,
});

// 分隔线
slide1.addShape(pptx.ShapeType.rect, {
  x: 0.9, y: 2.7, w: 3.5, h: 0.02,
  fill: { color: "3D5A80" },
});

// 歌曲信息
const info1 = [
  ["作词", "林夕"],
  ["作曲", "陈小霞"],
  ["收录专辑", "《黑白灰》(2003)"],
  ["风格", "抒情 · 怀旧 · 伤感"],
];
let yPos1 = 3.0;
info1.forEach(([label, value]) => {
  slide1.addText(label, {
    x: 0.9, y: yPos1, w: 1.2, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "5B7B9A",
  });
  slide1.addText(value, {
    x: 2.1, y: yPos1, w: 4, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "C8D6E5",
  });
  yPos1 += 0.4;
});

// 右侧歌词引用区
slide1.addShape(pptx.ShapeType.rect, {
  x: 6.5, y: 1.0, w: 6.3, h: 3.8,
  fill: { color: "1E3248" },
  rectRadius: 0.1,
});

slide1.addText(
  '"十年之后，我们是朋友，\n还可以问候，只是那种温柔，\n再也找不到拥抱的理由。"',
  {
    x: 6.9, y: 1.4, w: 5.5, h: 3.0,
    fontSize: 18, fontFace: "Microsoft YaHei",
    color: "8FABC7", italic: true,
    lineSpacingMultiple: 1.8,
    valign: "middle",
  }
);

// 底部标注
slide1.addText("陈奕迅 Eason Chan · 2003", {
  x: 0.9, y: 5.0, w: 5, h: 0.4,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: "3D5A80",
});

// ==================== 第2页：《浮夸》 ====================
// 风格：暗黑张扬，戏剧感，红色+黑
const slide2 = pptx.addSlide();
slide2.background = { type: "solid", color: "0D0D0D" }; // 纯黑

// 顶部红色光带
slide2.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 13.33, h: 0.06,
  fill: { color: "C0392B" },
});

// 大字歌名
slide2.addText("浮 夸", {
  x: 0.8, y: 0.5, w: 6, h: 1.5,
  fontSize: 64, fontFace: "Microsoft YaHei",
  color: "E74C3C", bold: true,
});

// 英文副标
slide2.addText("Exaggerated", {
  x: 1.0, y: 1.8, w: 4, h: 0.5,
  fontSize: 14, fontFace: "Arial",
  color: "7F1D1D", bold: true,
  charSpacing: 8,
});

// 中间装饰 — 红色竖线
slide2.addShape(pptx.ShapeType.rect, {
  x: 1.0, y: 2.5, w: 0.06, h: 2.8,
  fill: { color: "C0392B" },
});

// 歌曲信息（左侧）
const info2 = [
  ["作词", "黄伟文"],
  ["作曲", "C.Y. Kong"],
  ["收录专辑", "《U87》(2005)"],
  ["风格", "戏剧 · 宣泄 · 摇滚"],
];
let yPos2 = 2.7;
info2.forEach(([label, value]) => {
  slide2.addText(label, {
    x: 1.3, y: yPos2, w: 1.2, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "7F1D1D",
  });
  slide2.addText(value, {
    x: 2.5, y: yPos2, w: 3.5, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "E8E8E8",
  });
  yPos2 += 0.4;
});

// 右侧歌词区
slide2.addShape(pptx.ShapeType.rect, {
  x: 6.8, y: 0.8, w: 5.8, h: 4.5,
  fill: { color: "1A0A0A" },
  rectRadius: 0.08,
  line: { color: "7F1D1D", width: 1 },
});

slide2.addText(
  '"你当我是浮夸吧，\n夸张只因我很怕，\n似木头，似石头的话，\n得到注意吗？\n\n其实怕被忘记，\n至放大来演吧。"',
  {
    x: 7.2, y: 1.1, w: 5.0, h: 4.0,
    fontSize: 17, fontFace: "Microsoft YaHei",
    color: "E74C3C", italic: true,
    lineSpacingMultiple: 1.6,
    valign: "middle",
  }
);

// 底部
slide2.addText("陈奕迅 Eason Chan · 2005", {
  x: 1.3, y: 5.1, w: 4, h: 0.4,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: "7F1D1D",
});

// ==================== 第3页：《单车》 ====================
// 风格：温暖治愈，暖色调，父子深情
const slide3 = pptx.addSlide();
slide3.background = { type: "solid", color: "FDF5E6" }; // 老花白/米色

// 顶部暖色条
slide3.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 13.33, h: 0.06,
  fill: { color: "D4873F" },
});

// 歌名
slide3.addText("单 车", {
  x: 0.8, y: 0.5, w: 6, h: 1.2,
  fontSize: 52, fontFace: "Microsoft YaHei",
  color: "5D4037", bold: true,
});

// 副标题
slide3.addText("—— 难离难舍想抱紧些", {
  x: 1.0, y: 1.6, w: 5, h: 0.5,
  fontSize: 15, fontFace: "Microsoft YaHei",
  color: "A0735A", italic: true,
});

// 分隔线
slide3.addShape(pptx.ShapeType.rect, {
  x: 1.0, y: 2.3, w: 3.5, h: 0.02,
  fill: { color: "D4A76A" },
});

// 信息区（左侧）
const info3 = [
  ["作词", "黄伟文"],
  ["作曲", "柳重言"],
  ["收录专辑",  "《Shall We Dance? Shall We Talk!》(2001)"],
  ["风格", "温情 · 亲情 · 治愈"],
];
let yPos3 = 2.6;
info3.forEach(([label, value]) => {
  slide3.addText(label, {
    x: 1.0, y: yPos3, w: 1.2, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "A0735A",
  });
  slide3.addText(value, {
    x: 2.2, y: yPos3, w: 4.2, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "5D4037",
  });
  yPos3 += 0.4;
});

// 右侧歌词区
slide3.addShape(pptx.ShapeType.rect, {
  x: 6.8, y: 0.8, w: 5.8, h: 4.5,
  fill: { color: "FFF8F0" },
  rectRadius: 0.1,
  line: { color: "D4A76A", width: 1.2 },
});

slide3.addText(
  '"难离难舍想抱紧些，\n茫茫人生好像荒野，\n如孩儿能伏于爸爸的肩膊，\n哪怕遥遥长路多斜。"',
  {
    x: 7.2, y: 1.2, w: 5.0, h: 3.5,
    fontSize: 18, fontFace: "Microsoft YaHei",
    color: "795548", italic: true,
    lineSpacingMultiple: 1.8,
    valign: "middle",
  }
);

// 底部
slide3.addText("陈奕迅 Eason Chan · 2001", {
  x: 1.0, y: 5.1, w: 5, h: 0.4,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: "A0735A",
});

// ==================== 导出 ====================
const outPath = "/workspace/陈奕迅歌曲介绍.pptx";
pptx.writeFile({ fileName: outPath })
  .then(() => console.log("PPT 已生成: " + outPath))
  .catch(err => console.error("生成失败:", err));
