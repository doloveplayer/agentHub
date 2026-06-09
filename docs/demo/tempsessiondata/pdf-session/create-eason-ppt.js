import pptxgen from 'pptxgenjs';

const pptx = new pptxgen();

// Presentation settings
pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pptx.author = 'CodeAgent';
pptx.title = '陈奕迅 Eason Chan';

// ==================== Color Palette ====================
const C = {
  black:    '0A0A0A',
  darkGray: '1A1A1A',
  midGray:  '2A2A2A',
  gold:     'D4A843',
  goldLight:'E8C96A',
  goldDark: 'B8892E',
  white:    'F5F5F5',
  muted:    '8A8A8A',
  dim:      '555555',
};

const W = 13.33;
const H = 7.5;

// ==================== Helper: draw gold line ====================
function goldLine(slide, x1, y1, x2, y2, opts = {}) {
  slide.addShape(pptx.shapes.LINE, {
    x: x1, y: y1, w: x2 - x1, h: y2 - y1,
    line: { color: opts.color || C.gold, width: opts.width || 1.5 },
    flipV: y2 < y1,
  });
}

// ==================== Helper: gold rectangle ====================
function goldRect(slide, x, y, w, h, opts = {}) {
  slide.addShape(pptx.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: opts.fill || C.gold },
    rectRadius: opts.radius || 0,
    line: opts.border ? { color: opts.border, width: 1 } : undefined,
  });
}

// ==================== Helper: decorative vinyl grooves ====================
function drawVinylGrooves(slide, cx, cy, maxR, count, color) {
  for (let i = 0; i < count; i++) {
    const r = maxR - i * (maxR / count) * 0.8;
    if (r < 10) break;
    slide.addShape(pptx.shapes.OVAL, {
      x: cx - r, y: cy - r, w: r * 2, h: r * 2,
      line: { color, width: 0.3 + (i % 3 === 0 ? 0.4 : 0) },
      fill: { type: 'none' },
    });
  }
}

// ==================== Helper: gold diamond ====================
function goldDiamond(slide, cx, cy, size, color) {
  slide.addShape(pptx.shapes.DIAMOND, {
    x: cx - size / 2, y: cy - size / 2, w: size, h: size,
    fill: { color: color || C.gold },
  });
}

// ==================== PAGE 1: Cover ====================
const slide1 = pptx.addSlide();
slide1.background = { fill: C.black };

// Top-left decorative corner lines
goldLine(slide1, 0.4, 0.4, 1.8, 0.4, { width: 2 });
goldLine(slide1, 0.4, 0.4, 0.4, 1.6, { width: 2 });

// Bottom-right decorative corner lines
goldLine(slide1, W - 1.8, H - 0.4, W - 0.4, H - 0.4, { width: 2 });
goldLine(slide1, W - 0.4, H - 1.6, W - 0.4, H - 0.4, { width: 2 });

// Centered vinyl record motif (right side)
const vinylCx = W - 3.2;
const vinylCy = H / 2;
// Outer ring
slide1.addShape(pptx.shapes.OVAL, {
  x: vinylCx - 2.3, y: vinylCy - 2.3, w: 4.6, h: 4.6,
  line: { color: C.gold, width: 2 },
  fill: { type: 'none' },
});
drawVinylGrooves(slide1, vinylCx, vinylCy, 2.2, 12, C.goldDark);
// Center hole
slide1.addShape(pptx.shapes.OVAL, {
  x: vinylCx - 0.4, y: vinylCy - 0.4, w: 0.8, h: 0.8,
  fill: { color: C.black },
  line: { color: C.gold, width: 1.5 },
});
// Center dot
slide1.addShape(pptx.shapes.OVAL, {
  x: vinylCx - 0.08, y: vinylCy - 0.08, w: 0.16, h: 0.16,
  fill: { color: C.gold },
});

// Text content — left side
// Main title: Chinese name
slide1.addText('陈 奕 迅', {
  x: 0.8, y: 2.0, w: 7, h: 1.2,
  fontSize: 52, fontFace: 'Arial Black', color: C.gold,
  bold: true, charSpacing: 12, align: 'left',
});

// Subtitle: English name
slide1.addText('EASON CHAN', {
  x: 0.8, y: 3.15, w: 7, h: 0.6,
  fontSize: 28, fontFace: 'Arial', color: C.goldLight,
  charSpacing: 8, align: 'left',
});

// Decorative gold line under titles
goldLine(slide1, 0.8, 3.85, 5.5, 3.85, { width: 2.5 });

// Tagline
slide1.addText('华 语 流 行 乐 坛 之 王', {
  x: 0.8, y: 4.1, w: 7, h: 0.5,
  fontSize: 16, fontFace: 'Arial', color: C.muted,
  charSpacing: 6, align: 'left',
});

// Year range
slide1.addText('1974 —', {
  x: 0.8, y: 4.7, w: 3, h: 0.4,
  fontSize: 14, fontFace: 'Consolas', color: C.dim,
  align: 'left',
});

// Bottom gold bar
goldRect(slide1, 0, H - 0.08, W, 0.08, { fill: C.gold });

// Small decorative diamonds
goldDiamond(slide1, 3.2, 1.5, 0.18, C.goldDark);
goldDiamond(slide1, 6.5, 1.2, 0.12, C.dim);
goldDiamond(slide1, 1.5, 5.5, 0.15, C.dim);


// ==================== PAGE 2: Profile & Career ====================
const slide2 = pptx.addSlide();
slide2.background = { fill: C.black };

// Top gold accent bar
goldRect(slide2, 0, 0, W, 0.05, { fill: C.gold });

// Section title
slide2.addText('ARTIST PROFILE', {
  x: 0.7, y: 0.4, w: 5, h: 0.4,
  fontSize: 11, fontFace: 'Consolas', color: C.muted, charSpacing: 4,
});
slide2.addText('个人档案', {
  x: 0.7, y: 0.7, w: 5, h: 0.55,
  fontSize: 30, fontFace: 'Arial Black', color: C.gold, bold: true,
});

// Divider line under header
goldLine(slide2, 0.7, 1.35, 3.2, 1.35, { width: 1.5 });

// ===== Left column: Info cards =====
const cardX = 0.7;
const cardW = 5.5;
const infoItems = [
  { label: '中文名', value: '陈奕迅 (Eason)' },
  { label: '出生日期', value: '1974年7月27日' },
  { label: '出生地', value: '中国香港' },
  { label: '国    籍', value: '中国' },
  { label: '职    业', value: '歌手、演员、音乐人' },
  { label: '音乐风格', value: '流行、摇滚、R&B、爵士、实验' },
  { label: '唱片公司', value: '环球唱片 / 新艺宝唱片' },
];

let infoY = 1.6;
for (const item of infoItems) {
  // Gold label
  slide2.addText(item.label, {
    x: cardX, y: infoY, w: 1.3, h: 0.32,
    fontSize: 11, fontFace: 'Arial', color: C.gold, bold: true, align: 'left',
    margin: 0,
  });
  // Value
  slide2.addText(item.value, {
    x: cardX + 1.3, y: infoY, w: cardW - 1.3, h: 0.32,
    fontSize: 12, fontFace: 'Calibri', color: C.white, align: 'left',
    margin: 0,
  });
  // Subtle separator line
  goldLine(slide2, cardX, infoY + 0.38, cardX + cardW, infoY + 0.38, {
    width: 0.3, color: '333333'
  });
  infoY += 0.48;
}

// Bio paragraph
slide2.addText(
  '陈奕迅被誉为"歌神"张学友的接班人，更是华语乐坛最具影响力的男歌手之一。\n' +
  '他以极富感染力的嗓音和对情感的精准诠释著称，能驾驭从深情慢歌到\n' +
  '劲爆摇滚的多种风格。其独特的咬字方式和舞台魅力，使他成为横跨\n' +
  '港台及内地乐坛的标志性人物。',
  {
    x: cardX, y: infoY + 0.15, w: cardW, h: 1.5,
    fontSize: 11, fontFace: 'Calibri', color: C.muted, lineSpacingMultiple: 1.3,
    align: 'left', valign: 'top',
  }
);

// ===== Right column: Career milestones (timeline) =====
const rcX = 7.0;
const rcW = 5.8;

// Section header
slide2.addText('CAREER HIGHLIGHTS', {
  x: rcX, y: 0.4, w: rcW, h: 0.4,
  fontSize: 11, fontFace: 'Consolas', color: C.muted, charSpacing: 4,
});
slide2.addText('里程碑', {
  x: rcX, y: 0.7, w: rcW, h: 0.55,
  fontSize: 30, fontFace: 'Arial Black', color: C.gold, bold: true,
});
goldLine(slide2, rcX, 1.35, rcX + 2.2, 1.35, { width: 1.5 });

// Timeline items
const milestones = [
  { year: '1995', text: '参加TVB新秀歌唱大赛获冠军，正式出道' },
  { year: '1996', text: '首张粤语专辑《陈奕迅》发行' },
  { year: '2000', text: '《K歌之王》席卷华语乐坛' },
  { year: '2003', text: '《富士山下》成为永恒经典' },
  { year: '2005', text: '获叱咤乐坛男歌手金奖（六度封王）' },
  { year: '2010', text: '《陀飞轮》获多项金曲奖' },
  { year: '2014', text: '《四季》专辑再创高峰' },
  { year: '2023', text: '《Fear and Dreams》世界巡回演唱会' },
];

let mlY = 1.6;
for (const m of milestones) {
  // Gold dot
  slide2.addShape(pptx.shapes.OVAL, {
    x: rcX, y: mlY + 0.1, w: 0.14, h: 0.14,
    fill: { color: C.gold },
  });

  // Vertical connecting line (not for last item)
  if (m !== milestones[milestones.length - 1]) {
    goldLine(slide2, rcX + 0.07, mlY + 0.26, rcX + 0.07, mlY + 0.48, {
      width: 0.5, color: '333333'
    });
  }

  // Year
  slide2.addText(m.year, {
    x: rcX + 0.3, y: mlY, w: 0.7, h: 0.32,
    fontSize: 12, fontFace: 'Consolas', color: C.gold, bold: true, align: 'left',
    margin: 0,
  });

  // Text
  slide2.addText(m.text, {
    x: rcX + 1.05, y: mlY, w: rcW - 1.2, h: 0.32,
    fontSize: 11, fontFace: 'Calibri', color: C.white, align: 'left',
    margin: 0,
  });

  mlY += 0.48;
}

// Bottom gold bar
goldRect(slide2, 0, H - 0.05, W, 0.05, { fill: C.gold });

// Page number
slide2.addText('02', {
  x: W - 1.2, y: H - 0.55, w: 0.8, h: 0.35,
  fontSize: 14, fontFace: 'Consolas', color: C.dim, align: 'right',
});


// ==================== PAGE 3: Iconic Works & Legacy ====================
const slide3 = pptx.addSlide();
slide3.background = { fill: C.black };

// Top gold accent bar
goldRect(slide3, 0, 0, W, 0.05, { fill: C.gold });

// Section title
slide3.addText('ICONIC WORKS & LEGACY', {
  x: 0.7, y: 0.4, w: 8, h: 0.4,
  fontSize: 11, fontFace: 'Consolas', color: C.muted, charSpacing: 4,
});
slide3.addText('经典作品与传奇', {
  x: 0.7, y: 0.7, w: 8, h: 0.55,
  fontSize: 30, fontFace: 'Arial Black', color: C.gold, bold: true,
});
goldLine(slide3, 0.7, 1.35, 4.0, 1.35, { width: 1.5 });

// ===== Left: Classic Albums (2x3 grid of cards) =====
const albums = [
  { title: '《My Happy Age》', year: '1998', tag: '粤语经典' },
  { title: '《打得火热》', year: '2000', tag: '突破之作' },
  { title: '《Special Thanks To...》', year: '2002', tag: '实验先锋' },
  { title: '《Black, White & Colour》', year: '2003', tag: '封神之年' },
  { title: '《U87》', year: '2005', tag: '传世经典' },
  { title: '《认了吧》', year: '2007', tag: '情感巅峰' },
];

const gridStartX = 0.7;
const gridStartY = 1.6;
const albumCardW = 2.7;
const albumCardH = 1.55;
const gapX = 0.3;
const gapY = 0.25;

for (let i = 0; i < albums.length; i++) {
  const a = albums[i];
  const col = i % 3;
  const row = Math.floor(i / 3);
  const cx = gridStartX + col * (albumCardW + gapX);
  const cy = gridStartY + row * (albumCardH + gapY);

  // Card background
  slide3.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: cx, y: cy, w: albumCardW, h: albumCardH,
    fill: { color: C.darkGray },
    rectRadius: 0.08,
    line: { color: '333333', width: 0.5 },
  });

  // Gold top accent on card
  goldRect(slide3, cx + 0.15, cy + 0.12, 0.4, 0.04, { fill: C.gold });

  // Album title
  slide3.addText(a.title, {
    x: cx + 0.15, y: cy + 0.3, w: albumCardW - 0.3, h: 0.35,
    fontSize: 12, fontFace: 'Arial Black', color: C.white, bold: true,
    align: 'left', margin: 0,
  });

  // Year
  slide3.addText(a.year, {
    x: cx + 0.15, y: cy + 0.7, w: 0.8, h: 0.25,
    fontSize: 11, fontFace: 'Consolas', color: C.gold, align: 'left', margin: 0,
  });

  // Tag
  slide3.addText(a.tag, {
    x: cx + 0.95, y: cy + 0.72, w: 1.5, h: 0.22,
    fontSize: 9, fontFace: 'Calibri', color: C.muted, align: 'left', margin: 0,
  });
}

// ===== Right: Signature Songs + Stats =====
const rSideX = 7.0;
const rSideW = 5.8;

slide3.addText('SIGNATURE SONGS', {
  x: rSideX, y: 1.6, w: rSideW, h: 0.35,
  fontSize: 11, fontFace: 'Consolas', color: C.muted, charSpacing: 3,
});
goldLine(slide3, rSideX, 1.98, rSideX + 2.0, 1.98, { width: 0.8 });

const songs = [
  { name: '《十年》', note: '华语情歌的代名词' },
  { name: '《K歌之王》', note: 'KTV 必点曲目' },
  { name: '《富士山下》', note: '粤语经典的巅峰' },
  { name: '《浮夸》', note: '极致的情感爆发' },
  { name: '《好久不见》', note: '重逢的万千感慨' },
  { name: '《陀飞轮》', note: '对时间的深刻思考' },
  { name: '《不要说话》', note: '无声胜有声的告白' },
  { name: '《淘汰》', note: '周杰伦词曲的经典之作' },
];

let songY = 2.15;
for (const s of songs) {
  // Gold diamond bullet
  goldDiamond(slide3, rSideX + 0.1, songY + 0.12, 0.12, C.gold);

  slide3.addText(s.name, {
    x: rSideX + 0.3, y: songY, w: 1.8, h: 0.28,
    fontSize: 12, fontFace: 'Arial', color: C.goldLight, bold: true,
    align: 'left', margin: 0,
  });
  slide3.addText(s.note, {
    x: rSideX + 2.1, y: songY, w: 3.5, h: 0.28,
    fontSize: 10, fontFace: 'Calibri', color: C.muted,
    align: 'left', margin: 0,
  });

  songY += 0.35;
}

// ===== Bottom: Stats callout row =====
const statsY = 5.6;
goldLine(slide3, 0.7, statsY, W - 0.7, statsY, { width: 0.5, color: '333333' });

const stats = [
  { num: '30+', label: '音乐生涯（年）' },
  { num: '60+', label: '发行专辑（张）' },
  { num: '500+', label: '经典歌曲（首）' },
  { num: '200+', label: '场演唱会（场）' },
];

const statW = (W - 1.4) / 4;
for (let i = 0; i < stats.length; i++) {
  const sx = 0.7 + i * statW;

  // Big number
  slide3.addText(stats[i].num, {
    x: sx, y: statsY + 0.2, w: statW, h: 0.6,
    fontSize: 36, fontFace: 'Arial Black', color: C.gold, bold: true,
    align: 'center', margin: 0,
  });

  // Label
  slide3.addText(stats[i].label, {
    x: sx, y: statsY + 0.78, w: statW, h: 0.3,
    fontSize: 11, fontFace: 'Calibri', color: C.muted,
    align: 'center', margin: 0,
  });

  // Separator between stats (not after last)
  if (i < stats.length - 1) {
    goldLine(slide3, sx + statW, statsY + 0.25, sx + statW, statsY + 0.95, {
      width: 0.3, color: '333333'
    });
  }
}

// Bottom gold bar
goldRect(slide3, 0, H - 0.05, W, 0.05, { fill: C.gold });

// Quote at bottom
slide3.addText('"若无其事，原来是最好的报复。"', {
  x: 0.7, y: H - 0.55, w: 6, h: 0.35,
  fontSize: 10, fontFace: 'Calibri', color: C.dim, italic: true, align: 'left',
  margin: 0,
});

// Page number
slide3.addText('03', {
  x: W - 1.2, y: H - 0.55, w: 0.8, h: 0.35,
  fontSize: 14, fontFace: 'Consolas', color: C.dim, align: 'right',
});


// ==================== Save ====================
const outputPath = '/workspace/陈奕迅_Eason_Chan.pptx';
await pptx.writeFile({ fileName: outputPath });
console.log(`PPTX created: ${outputPath}`);
