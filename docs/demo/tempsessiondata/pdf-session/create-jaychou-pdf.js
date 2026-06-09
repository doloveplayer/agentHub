import { PDFDocument, rgb, StandardFonts, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs';

async function createPDF() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Load Chinese fonts
  const regularFontBytes = fs.readFileSync('/workspace/SourceHanSansSC-Regular.otf');
  const boldFontBytes = fs.readFileSync('/workspace/SourceHanSansSC-Bold.otf');

  const regularFont = await pdfDoc.embedFont(regularFontBytes, { subset: true });
  const boldFont = await pdfDoc.embedFont(boldFontBytes, { subset: true });

  const W = 595.28;  // A4 width
  const H = 841.89;  // A4 height

  // ===================== Color Palette =====================
  const darkBg      = rgb(0.08, 0.08, 0.12);
  const accentGold  = rgb(0.85, 0.65, 0.13);
  const accentPurple= rgb(0.55, 0.27, 0.68);
  const accentPink  = rgb(0.91, 0.30, 0.50);
  const white       = rgb(1, 1, 1);
  const lightGray   = rgb(0.85, 0.85, 0.85);
  const midGray     = rgb(0.60, 0.60, 0.65);
  const softBg      = rgb(0.95, 0.95, 0.97);

  // ===================== Helper functions =====================
  function drawDecorativeCircles(page, count, baseX, baseY, baseR, color) {
    for (let i = 0; i < count; i++) {
      const cx = baseX + Math.sin(i * 1.7) * 60;
      const cy = baseY + Math.cos(i * 2.3) * 40;
      const r = baseR + i * 3;
      page.drawCircle({ x: cx, y: cy, size: r, color: color, opacity: 0.15 - i * 0.02 });
    }
  }

  function drawMusicNotes(page, x, y, color) {
    // Simplified music note shapes using lines and circles
    page.drawCircle({ x: x, y: y, size: 4, color });
    page.drawLine({ start: { x: x + 4, y: y }, end: { x: x + 4, y: y + 18 }, color, thickness: 1.5 });
    page.drawEllipse({ x: x + 1, y: y - 1, xScale: 5, yScale: 3.5, color });
    // Second note
    page.drawCircle({ x: x + 20, y: y + 5, size: 4, color });
    page.drawLine({ start: { x: x + 24, y: y + 5 }, end: { x: x + 24, y: y + 23 }, color, thickness: 1.5 });
    page.drawEllipse({ x: x + 21, y: y + 4, xScale: 5, yScale: 3.5, color });
    page.drawLine({ start: { x: x + 4, y: y + 18 }, end: { x: x + 24, y: y + 23 }, color, thickness: 2 });
  }

  function drawWave(page, startY, color, amplitude, segments) {
    const step = W / segments;
    for (let i = 0; i < segments; i++) {
      const x1 = i * step;
      const y1 = startY + Math.sin(i * 0.5) * amplitude;
      const x2 = (i + 1) * step;
      const y2 = startY + Math.sin((i + 1) * 0.5) * amplitude;
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color, thickness: 1 });
    }
  }

  function drawGradientBar(page, x, y, w, h, color1, color2, steps) {
    const stepW = w / steps;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const r = color1.red + (color2.red - color1.red) * t;
      const g = color1.green + (color2.green - color1.green) * t;
      const b = color1.blue + (color2.blue - color1.blue) * t;
      page.drawRectangle({ x: x + i * stepW, y, width: stepW + 0.5, height: h, color: rgb(r, g, b) });
    }
  }

  // ===================== PAGE 1: Cover =====================
  const p1 = pdfDoc.addPage([W, H]);

  // Dark background
  p1.drawRectangle({ x: 0, y: 0, width: W, height: H, color: darkBg });

  // Decorative gradient accent bar at top
  drawGradientBar(p1, 0, H - 8, W, 8, accentPurple, accentPink, 80);

  // Abstract geometric decorations
  p1.drawCircle({ x: W - 80, y: H - 120, size: 100, color: accentPurple, opacity: 0.08 });
  p1.drawCircle({ x: 60, y: 180, size: 120, color: accentPink, opacity: 0.06 });
  p1.drawCircle({ x: W / 2, y: H / 2 - 50, size: 200, color: accentGold, opacity: 0.04 });

  // Large decorative rings
  p1.drawCircle({ x: W - 100, y: H - 200, size: 80, borderColor: accentGold, borderWidth: 1.5, opacity: 0.3 });
  p1.drawCircle({ x: W - 100, y: H - 200, size: 100, borderColor: accentPurple, borderWidth: 0.8, opacity: 0.2 });

  // Music notes decorations
  drawMusicNotes(p1, 50, H - 250, accentGold);
  drawMusicNotes(p1, W - 120, 300, accentPurple);
  drawMusicNotes(p1, 100, 150, accentPink);

  // Wave decorations
  drawWave(p1, 100, accentGold, 15, 40);
  drawWave(p1, 80, accentPurple, 10, 40);

  // Central content
  const titleY = H * 0.6;

  // "JAY CHOU" in large English
  const englishTitle = 'JAY CHOU';
  const engTitleWidth = boldFont.widthOfTextAtSize(englishTitle, 72);
  p1.drawText(englishTitle, {
    x: (W - engTitleWidth) / 2,
    y: titleY + 40,
    size: 72,
    font: boldFont,
    color: white,
  });

  // Gradient underline for English title
  drawGradientBar(p1, (W - 160) / 2, titleY + 32, 160, 3, accentGold, accentPink, 40);

  // "周杰伦" in large Chinese
  const chTitle = '周 杰 伦';
  const chTitleWidth = boldFont.widthOfTextAtSize(chTitle, 48);
  p1.drawText(chTitle, {
    x: (W - chTitleWidth) / 2,
    y: titleY - 25,
    size: 48,
    font: boldFont,
    color: accentGold,
  });

  // Subtitle
  const subtitle = '华 语 流 行 音 乐 天 王';
  const subWidth = regularFont.widthOfTextAtSize(subtitle, 18);
  p1.drawText(subtitle, {
    x: (W - subWidth) / 2,
    y: titleY - 70,
    size: 18,
    font: regularFont,
    color: lightGray,
  });

  // Decorative divider
  const dividerY = titleY - 100;
  p1.drawLine({ start: { x: W / 2 - 60, y: dividerY }, end: { x: W / 2 - 10, y: dividerY }, color: accentGold, thickness: 1 });
  p1.drawCircle({ x: W / 2, y: dividerY, size: 4, color: accentGold });
  p1.drawLine({ start: { x: W / 2 + 10, y: dividerY }, end: { x: W / 2 + 60, y: dividerY }, color: accentGold, thickness: 1 });

  // Dates
  const dates = '1979.01.18 — 至今';
  const datesWidth = regularFont.widthOfTextAtSize(dates, 14);
  p1.drawText(dates, {
    x: (W - datesWidth) / 2,
    y: dividerY - 30,
    size: 14,
    font: regularFont,
    color: midGray,
  });

  // Bottom decorative bar
  drawGradientBar(p1, 0, 0, W, 6, accentGold, accentPurple, 80);

  // Bottom text
  const bottomText = 'MUSIC · FILM · CULTURE';
  const btWidth = regularFont.widthOfTextAtSize(bottomText, 11);
  p1.drawText(bottomText, {
    x: (W - btWidth) / 2,
    y: 20,
    size: 11,
    font: regularFont,
    color: midGray,
  });


  // ===================== PAGE 2: Profile =====================
  const p2 = pdfDoc.addPage([W, H]);
  p2.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  // Top accent bar
  drawGradientBar(p2, 0, H - 6, W, 6, accentPurple, accentPink, 80);

  // Section header
  p2.drawText('个人简介', {
    x: 50, y: H - 70, size: 32, font: boldFont, color: darkBg
  });
  drawGradientBar(p2, 50, H - 82, 80, 3, accentGold, accentPink, 30);
  p2.drawText('PROFILE', {
    x: 50, y: H - 105, size: 12, font: regularFont, color: midGray
  });

  // Profile info card
  const cardY = H - 460;
  const cardH = 320;
  p2.drawRectangle({
    x: 40, y: cardY, width: W - 80, height: cardH,
    color: softBg, borderRadius: 8
  });
  // Left accent stripe
  p2.drawRectangle({
    x: 40, y: cardY, width: 5, height: cardH,
    color: accentGold
  });

  const infoItems = [
    ['中文名', '周杰伦 (Jay Chou)'],
    ['出生日期', '1979年1月18日'],
    ['出生地', '台湾省新北市'],
    ['国    籍', '中国'],
    ['职    业', '歌手、词曲创作人、音乐制作人、演员、导演'],
    ['经纪公司', '杰威尔音乐 (JVR Music)'],
    ['毕业院校', '淡江中学音乐班'],
  ];

  let infoY = cardY + cardH - 35;
  for (const [label, value] of infoItems) {
    p2.drawText(label, {
      x: 70, y: infoY, size: 14, font: boldFont, color: accentPurple
    });
    p2.drawText(value, {
      x: 180, y: infoY, size: 14, font: regularFont, color: darkBg
    });
    infoY -= 38;
  }

  // Bio paragraph
  p2.drawText('音乐传奇', {
    x: 50, y: cardY - 40, size: 22, font: boldFont, color: darkBg
  });
  drawGradientBar(p2, 50, cardY - 50, 60, 2.5, accentGold, accentPink, 20);

  const bioLines = [
    '周杰伦，华语乐坛划时代的音乐天才。他以独创的"中国风"音乐风格，',
    '将东方古典韵味与西方流行音乐完美融合，开创了华语音乐的全新纪元。',
    '自2000年出道以来，他以惊人的创作才华和独特的音乐理念，',
    '连续二十余年引领华语音乐潮流，被誉为"亚洲流行天王"。',
    '',
    '他的音乐不仅打破了传统华语歌曲的框架，更影响了整整一代人的审美。',
    '从《双截棍》的说唱中国风，到《青花瓷》的古典雅韵，每一首歌都',
    '是一个时代的印记。他是华语音乐史上唱片销量最高的歌手之一，',
    '也是无数音乐人心中不可逾越的丰碑。',
  ];

  let bioY = cardY - 80;
  for (const line of bioLines) {
    if (line) {
      p2.drawText(line, {
        x: 50, y: bioY, size: 12, font: regularFont, color: rgb(0.25, 0.25, 0.30)
      });
    }
    bioY -= 20;
  }

  // Bottom wave decoration
  drawWave(p2, 50, accentGold, 8, 40);
  drawWave(p2, 35, accentPurple, 5, 40);

  // Footer
  const footer2 = '— 周杰伦 · 华语流行音乐天王 —';
  const f2Width = regularFont.widthOfTextAtSize(footer2, 9);
  p2.drawText(footer2, { x: (W - f2Width) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== PAGE 3: Career Timeline =====================
  const p3 = pdfDoc.addPage([W, H]);
  p3.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  // Top accent bar
  drawGradientBar(p3, 0, H - 6, W, 6, accentGold, accentPurple, 80);

  // Section header
  p3.drawText('音乐生涯', {
    x: 50, y: H - 70, size: 32, font: boldFont, color: darkBg
  });
  drawGradientBar(p3, 50, H - 82, 80, 3, accentGold, accentPink, 30);
  p3.drawText('CAREER TIMELINE', {
    x: 50, y: H - 105, size: 12, font: regularFont, color: midGray
  });

  // Timeline
  const timeline = [
    ['2000', '发行首张专辑《Jay》，横空出世', accentPurple],
    ['2001', '第二张专辑《范特西》轰动乐坛', accentPurple],
    ['2003', '专辑《叶惠美》再创高峰', accentPink],
    ['2004', '《七里香》专辑风靡亚洲', accentPink],
    ['2005', '《十一月的萧邦》持续辉煌', accentGold],
    ['2006', '《依然范特西》经典延续', accentGold],
    ['2008', '《魔杰座》实验性突破', accentPurple],
    ['2010', '《跨时代》开启新十年', accentPurple],
    ['2011', '《惊叹号》电子风格尝试', accentPink],
    ['2012', '《十二新作》回归中国风', accentPink],
    ['2014', '《哎呦，不错哦》多元融合', accentGold],
    ['2016', '《周杰伦的床边故事》', accentGold],
    ['2019', '《最伟大的作品》概念专辑', accentPurple],
    ['2022', '持续创作，影响力不减', accentPink],
  ];

  const lineX = 160;
  let tY = H - 150;
  const tStep = 48;

  // Vertical timeline line
  p3.drawLine({
    start: { x: lineX, y: tY + 10 },
    end: { x: lineX, y: tY - (timeline.length - 1) * tStep - 10 },
    color: lightGray,
    thickness: 2,
  });

  for (let i = 0; i < timeline.length; i++) {
    const [year, desc, color] = timeline[i];
    const y = tY - i * tStep;

    // Year dot
    p3.drawCircle({ x: lineX, y: y, size: 6, color });
    p3.drawCircle({ x: lineX, y: y, size: 9, borderColor: color, borderWidth: 1.5 });

    // Year label (left of line)
    const yearWidth = boldFont.widthOfTextAtSize(year, 14);
    p3.drawText(year, {
      x: lineX - 20 - yearWidth, y: y - 5, size: 14, font: boldFont, color
    });

    // Description (right of line)
    p3.drawText(desc, {
      x: lineX + 25, y: y - 5, size: 12, font: regularFont, color: darkBg
    });
  }

  // Decorative music notes
  drawMusicNotes(p3, W - 100, H - 200, accentGold);
  drawMusicNotes(p3, 60, 200, accentPurple);

  // Footer
  const footer3 = '— 周杰伦 · 华语流行音乐天王 —';
  const f3Width = regularFont.widthOfTextAtSize(footer3, 9);
  p3.drawText(footer3, { x: (W - f3Width) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== PAGE 4: Classic Albums =====================
  const p4 = pdfDoc.addPage([W, H]);
  p4.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  drawGradientBar(p4, 0, H - 6, W, 6, accentPink, accentGold, 80);

  p4.drawText('经典专辑', {
    x: 50, y: H - 70, size: 32, font: boldFont, color: darkBg
  });
  drawGradientBar(p4, 50, H - 82, 80, 3, accentGold, accentPink, 30);
  p4.drawText('ICONIC ALBUMS', {
    x: 50, y: H - 105, size: 12, font: regularFont, color: midGray
  });

  const albums = [
    { title: 'Jay (2000)', songs: '星晴 · 娘子 · 黑色幽默 · 可爱女人 · 龙卷风', rating: '★★★★★', color: accentPurple },
    { title: '范特西 (2001)', songs: '简单爱 · 爱在西元前 · 双截棍 · 开不了口', rating: '★★★★★', color: accentPurple },
    { title: '八度空间 (2002)', songs: '半兽人 · 暗号 · 龙拳 · 火力全开', rating: '★★★★☆', color: accentPink },
    { title: '叶惠美 (2003)', songs: '以父之名 · 懦夫 · 晴天 · 三年二班', rating: '★★★★★', color: accentPink },
    { title: '七里香 (2004)', songs: '七里香 · 我的地盘 · 借口 · 将军', rating: '★★★★★', color: accentGold },
    { title: '十一月的萧邦 (2005)', songs: '夜曲 · 发如雪 · 枫 · 浪漫手机', rating: '★★★★★', color: accentGold },
    { title: '依然范特西 (2006)', songs: '夜的第七章 · 听妈妈的话 · 菊花台', rating: '★★★★★', color: accentPurple },
    { title: '我很忙 (2007)', songs: '牛仔很忙 · 彩虹 · 青花瓷 · 最长的电影', rating: '★★★★★', color: accentPink },
    { title: '魔杰座 (2008)', songs: '兰亭序 · 稻香 · 说好的幸福呢', rating: '★★★★☆', color: accentGold },
    { title: '跨时代 (2010)', songs: '烟花易冷 · 免费教学录影带 · 超人不会飞', rating: '★★★★☆', color: accentPurple },
  ];

  let albumY = H - 150;
  for (let i = 0; i < albums.length; i++) {
    const album = albums[i];

    // Album card background
    p4.drawRectangle({
      x: 40, y: albumY - 5, width: W - 80, height: 58,
      color: i % 2 === 0 ? softBg : white,
    });

    // Left accent dot
    p4.drawCircle({ x: 55, y: albumY + 24, size: 5, color: album.color });

    // Album title
    p4.drawText(album.title, {
      x: 70, y: albumY + 28, size: 14, font: boldFont, color: darkBg
    });

    // Star rating
    const starWidth = regularFont.widthOfTextAtSize(album.rating, 11);
    p4.drawText(album.rating, {
      x: W - 60 - starWidth, y: albumY + 30, size: 11, font: regularFont, color: accentGold
    });

    // Songs
    p4.drawText(album.songs, {
      x: 70, y: albumY + 6, size: 10, font: regularFont, color: midGray
    });

    albumY -= 65;
  }

  // Footer
  const footer4 = '— 周杰伦 · 华语流行音乐天王 —';
  const f4Width = regularFont.widthOfTextAtSize(footer4, 9);
  p4.drawText(footer4, { x: (W - f4Width) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== PAGE 5: Famous Songs =====================
  const p5 = pdfDoc.addPage([W, H]);
  p5.drawRectangle({ x: 0, y: 0, width: W, height: H, color: darkBg });

  // Top accent bar
  drawGradientBar(p5, 0, H - 6, W, 6, accentGold, accentPink, 80);

  // Decorative circles
  p5.drawCircle({ x: W - 60, y: H - 100, size: 80, borderColor: accentGold, borderWidth: 1, opacity: 0.2 });
  p5.drawCircle({ x: 80, y: 150, size: 60, borderColor: accentPurple, borderWidth: 1, opacity: 0.15 });

  // Section header
  p5.drawText('传世金曲', {
    x: 50, y: H - 70, size: 32, font: boldFont, color: white
  });
  drawGradientBar(p5, 50, H - 82, 80, 3, accentGold, accentPink, 30);
  p5.drawText('TIMELESS HITS', {
    x: 50, y: H - 105, size: 12, font: regularFont, color: midGray
  });

  const songs = [
    { name: '青花瓷', genre: '中国风', desc: '古典意境的巅峰之作', color: accentGold },
    { name: '晴天', genre: '流行', desc: '青春记忆中最美的旋律', color: accentPink },
    { name: '七里香', genre: '流行', desc: '夏日恋曲的永恒经典', color: accentPurple },
    { name: '双截棍', genre: '说唱', desc: '开创华语说唱新纪元', color: accentGold },
    { name: '夜曲', genre: '古典', desc: '钢琴与说唱的完美交融', color: accentPink },
    { name: '以父之名', genre: '哥特', desc: '恢弘壮阔的音乐史诗', color: accentPurple },
    { name: '简单爱', genre: 'R&B', desc: '最纯粹的爱情表达', color: accentGold },
    { name: '发如雪', genre: '中国风', desc: '古风美学的极致展现', color: accentPink },
    { name: '稻香', genre: '流行', desc: '温暖治愈的田园牧歌', color: accentPurple },
    { name: '菊花台', genre: '中国风', desc: '古风电影配乐的标杆', color: accentGold },
    { name: '兰亭序', genre: '中国风', desc: '水墨画般的音乐诗篇', color: accentPink },
    { name: '烟花易冷', genre: '中国风', desc: '千年古都的悲壮传说', color: accentPurple },
    { name: '听妈妈的话', genre: '说唱', desc: '感恩与成长的心声', color: accentGold },
    { name: '告白气球', genre: '流行', desc: '甜蜜浪漫的告白神曲', color: accentPink },
  ];

  let songY = H - 145;
  const songStep = 48;
  const col1X = 50;
  const col2X = W / 2 + 15;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const isRight = i % 2 === 1;
    const sx = isRight ? col2X : col1X;
    const sy = isRight ? songY : songY;

    if (!isRight) {
      // Song card on left column
      p5.drawRectangle({
        x: col1X - 5, y: songY + 30 - 5, width: W / 2 - 45, height: songStep - 5,
        color: rgb(0.12, 0.12, 0.18)
      });
    } else {
      p5.drawRectangle({
        x: col2X - 5, y: songY + 30 - 5, width: W / 2 - 45, height: songStep - 5,
        color: rgb(0.12, 0.12, 0.18)
      });
    }

    // Colored dot
    p5.drawCircle({ x: sx + 5, y: sy + 20, size: 4, color: song.color });

    // Song name
    p5.drawText(song.name, {
      x: sx + 15, y: sy + 15, size: 13, font: boldFont, color: white
    });

    // Genre tag
    const genreWidth = regularFont.widthOfTextAtSize(`[${song.genre}]`, 9);
    p5.drawText(`[${song.genre}]`, {
      x: sx + 15, y: sy + 1, size: 9, font: regularFont, color: song.color
    });

    // Description
    p5.drawText(song.desc, {
      x: sx + 15 + genreWidth + 10, y: sy + 1, size: 9, font: regularFont, color: midGray
    });

    if (!isRight) {
      // Keep position for next song
    } else {
      songY -= songStep;
    }
  }

  // Music notes decoration
  drawMusicNotes(p5, 50, 100, accentGold);
  drawMusicNotes(p5, W - 100, 80, accentPurple);

  // Footer
  const footer5 = '— 周杰伦 · 华语流行音乐天王 —';
  const f5Width = regularFont.widthOfTextAtSize(footer5, 9);
  p5.drawText(footer5, { x: (W - f5Width) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== PAGE 6: Awards & Impact =====================
  const p6 = pdfDoc.addPage([W, H]);
  p6.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  drawGradientBar(p6, 0, H - 6, W, 6, accentPurple, accentGold, 80);

  // Section 1: Awards
  p6.drawText('荣誉殿堂', {
    x: 50, y: H - 70, size: 32, font: boldFont, color: darkBg
  });
  drawGradientBar(p6, 50, H - 82, 80, 3, accentGold, accentPink, 30);
  p6.drawText('HALL OF HONORS', {
    x: 50, y: H - 105, size: 12, font: regularFont, color: midGray
  });

  const awards = [
    { icon: '01', title: '金曲奖最佳国语男歌手', desc: '累计获奖及提名超过40次', color: accentGold },
    { icon: '02', title: '世界音乐大奖全球最高销量', desc: '连续多届蝉联华语区销量冠军', color: accentPurple },
    { icon: '03', title: 'MTV亚洲大奖', desc: '最受欢迎歌手奖等重量级奖项', color: accentPink },
    { icon: '04', title: '全球华语榜中榜', desc: '历年累计获奖最多的歌手', color: accentGold },
    { icon: '05', title: 'IFPI国际唱片业协会', desc: '全球华人最高唱片销量认证', color: accentPurple },
    { icon: '06', title: '福布斯中国名人榜', desc: '连续多年蝉联榜单前列', color: accentPink },
  ];

  let awardY = H - 145;
  for (const award of awards) {
    // Number circle
    p6.drawCircle({ x: 65, y: awardY, size: 16, color: award.color });
    const numW = boldFont.widthOfTextAtSize(award.icon, 11);
    p6.drawText(award.icon, {
      x: 65 - numW / 2, y: awardY - 4.5, size: 11, font: boldFont, color: white
    });

    p6.drawText(award.title, {
      x: 90, y: awardY + 3, size: 13, font: boldFont, color: darkBg
    });
    p6.drawText(award.desc, {
      x: 90, y: awardY - 15, size: 10, font: regularFont, color: midGray
    });

    awardY -= 50;
  }

  // Section 2: Cultural Impact
  p6.drawText('文化影响力', {
    x: 50, y: awardY - 20, size: 24, font: boldFont, color: darkBg
  });
  drawGradientBar(p6, 50, awardY - 30, 65, 2.5, accentGold, accentPink, 20);

  const impacts = [
    '开创"中国风"音乐流派，让东方美学走向世界',
    '融合说唱、R&B、古典等多种风格，拓宽华语音乐边界',
    '影响一代人的音乐审美和文化认同',
    '电影《头文字D》获金马奖最佳新演员',
    '导演处女作《不能说的秘密》成为华语经典电影',
    '杰威尔音乐培养新生代音乐人',
  ];

  let impY = awardY - 58;
  for (const imp of impacts) {
    // Bullet
    p6.drawCircle({ x: 58, y: impY + 4, size: 3, color: accentGold });
    p6.drawText(imp, {
      x: 70, y: impY, size: 11, font: regularFont, color: rgb(0.25, 0.25, 0.30)
    });
    impY -= 24;
  }

  // Decorative elements
  drawWave(p6, 60, accentGold, 8, 40);
  drawWave(p6, 45, accentPurple, 5, 40);

  // Footer
  const footer6 = '— 周杰伦 · 华语流行音乐天王 —';
  const f6Width = regularFont.widthOfTextAtSize(footer6, 9);
  p6.drawText(footer6, { x: (W - f6Width) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== PAGE 7: Closing =====================
  const p7 = pdfDoc.addPage([W, H]);
  p7.drawRectangle({ x: 0, y: 0, width: W, height: H, color: darkBg });

  // Top accent bar
  drawGradientBar(p7, 0, H - 6, W, 6, accentGold, accentPurple, 80);

  // Large decorative rings
  p7.drawCircle({ x: W / 2, y: H / 2 + 50, size: 150, borderColor: accentGold, borderWidth: 1.5, opacity: 0.15 });
  p7.drawCircle({ x: W / 2, y: H / 2 + 50, size: 180, borderColor: accentPurple, borderWidth: 0.8, opacity: 0.1 });
  p7.drawCircle({ x: W / 2, y: H / 2 + 50, size: 120, borderColor: accentPink, borderWidth: 0.5, opacity: 0.08 });

  // Music notes
  drawMusicNotes(p7, 80, H - 200, accentGold);
  drawMusicNotes(p7, W - 130, H - 200, accentPurple);
  drawMusicNotes(p7, 80, 250, accentPink);
  drawMusicNotes(p7, W - 130, 250, accentGold);

  // Quote
  const quoteY = H / 2 + 60;
  const quote = '"如果我足够幸运，我可能会改变一些事情"';
  const quoteWidth = boldFont.widthOfTextAtSize(quote, 22);
  p7.drawText(quote, {
    x: (W - quoteWidth) / 2, y: quoteY, size: 22, font: boldFont, color: accentGold
  });

  // Attribution
  const attr = '— 周杰伦';
  const attrWidth = regularFont.widthOfTextAtSize(attr, 14);
  p7.drawText(attr, {
    x: (W + quoteWidth) / 2 - attrWidth + 10, y: quoteY - 30, size: 14, font: regularFont, color: midGray
  });

  // Central divider
  drawGradientBar(p7, (W - 200) / 2, quoteY - 60, 200, 2, accentGold, accentPink, 50);

  // Thank you text
  const thankText = '感 谢 观 阅';
  const thankWidth = boldFont.widthOfTextAtSize(thankText, 28);
  p7.drawText(thankText, {
    x: (W - thankWidth) / 2, y: quoteY - 100, size: 28, font: boldFont, color: white
  });

  const subThank = 'THANK YOU FOR READING';
  const stWidth = regularFont.widthOfTextAtSize(subThank, 12);
  p7.drawText(subThank, {
    x: (W - stWidth) / 2, y: quoteY - 125, size: 12, font: regularFont, color: midGray
  });

  // Bottom waves
  drawWave(p7, 80, accentGold, 12, 40);
  drawWave(p7, 60, accentPurple, 8, 40);

  // Bottom bar
  drawGradientBar(p7, 0, 0, W, 6, accentPurple, accentGold, 80);

  // Credits
  const credits = 'JAY CHOU · MUSIC · 1979 — PRESENT';
  const crWidth = regularFont.widthOfTextAtSize(credits, 9);
  p7.drawText(credits, { x: (W - crWidth) / 2, y: 18, size: 9, font: regularFont, color: midGray });


  // ===================== Save PDF =====================
  const pdfBytes = await pdfDoc.save();
  const outputPath = '/workspace/周杰伦_Jay_Chou.pdf';
  fs.writeFileSync(outputPath, pdfBytes);
  console.log(`PDF created successfully: ${outputPath}`);
  console.log(`File size: ${(pdfBytes.length / 1024).toFixed(1)} KB`);
  console.log(`Pages: ${pdfDoc.getPageCount()}`);
}

createPDF().catch(console.error);
