import JSZip from 'jszip';

export interface PptxFallbackElement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill?: string;
  fontSize?: number;
  bold?: boolean;
}

export interface PptxFallbackSlide {
  index: number;
  width: number;
  height: number;
  elements: PptxFallbackElement[];
}

const DEFAULT_WIDTH_EMU = 12_192_000;
const DEFAULT_HEIGHT_EMU = 6_858_000;

export async function parsePptxFallbackSlides(buffer: ArrayBuffer): Promise<PptxFallbackSlide[]> {
  const zip = await JSZip.loadAsync(buffer);
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('text');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('text');
  if (!presentationXml || !relsXml) return [];

  const { widthEmu, heightEmu } = parseSlideSize(presentationXml);
  const slideTargets = parseSlideTargets(presentationXml, relsXml);
  const slides: PptxFallbackSlide[] = [];

  for (let index = 0; index < slideTargets.length; index++) {
    const target = slideTargets[index];
    const slideXml = await zip.file(`ppt/${target}`)?.async('text');
    if (!slideXml) continue;
    slides.push({
      index,
      width: widthEmu,
      height: heightEmu,
      elements: parseSlideElements(slideXml, widthEmu, heightEmu),
    });
  }

  return slides;
}

function parseSlideSize(xml: string): { widthEmu: number; heightEmu: number } {
  const match = xml.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  return {
    widthEmu: match ? Number(match[1]) : DEFAULT_WIDTH_EMU,
    heightEmu: match ? Number(match[2]) : DEFAULT_HEIGHT_EMU,
  };
}

function parseSlideTargets(presentationXml: string, relsXml: string): string[] {
  const rels = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = rel[0];
    if (!tag.includes('/relationships/slide"')) continue;
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?ppt\//, ''));
  }

  const targets: string[] = [];
  for (const slide of presentationXml.matchAll(/<p:sldId\b[^>]*>/g)) {
    const id = attr(slide[0], 'r:id');
    const target = id ? rels.get(id) : undefined;
    if (target) targets.push(target);
  }
  return targets;
}

function parseSlideElements(xml: string, widthEmu: number, heightEmu: number): PptxFallbackElement[] {
  const elements: PptxFallbackElement[] = [];
  const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) || [];

  shapes.forEach((shape, index) => {
    const xfrm = shape.match(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/)?.[0] || '';
    const off = xfrm.match(/<a:off\b[^>]*>/)?.[0] || '';
    const ext = xfrm.match(/<a:ext\b[^>]*>/)?.[0] || '';
    const x = ratioNumber(attr(off, 'x'), widthEmu);
    const y = ratioNumber(attr(off, 'y'), heightEmu);
    const w = ratioNumber(attr(ext, 'cx'), widthEmu);
    const h = ratioNumber(attr(ext, 'cy'), heightEmu);
    if (w <= 0 || h <= 0) return;

    const text = decodeXmlEntities([...shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => match[1])
      .join('\n')
      .trim());
    const fillMatch = shape.match(/<a:solidFill>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"[\s\S]*?<\/a:solidFill>/);
    const fontSizeMatch = shape.match(/<a:rPr\b[^>]*\bsz="(\d+)"/);

    elements.push({
      id: `shape-${index}`,
      x,
      y,
      w,
      h,
      text,
      fill: fillMatch ? `#${fillMatch[1].toUpperCase()}` : undefined,
      fontSize: fontSizeMatch ? Number(fontSizeMatch[1]) / 100 : undefined,
      bold: /<a:rPr\b[^>]*\bb="1"/.test(shape),
    });
  });

  return elements;
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(':', '\\:');
  return tag.match(new RegExp(`\\b${escaped}="([^"]*)"`))?.[1];
}

function ratioNumber(raw: string | undefined, denominator: number): number {
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && denominator > 0 ? value / denominator : 0;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}
