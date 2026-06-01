import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parsePptxFallbackSlides } from './pptxFallback.js';

test('parsePptxFallbackSlides reads multiple slides and text boxes from pptx xml', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
      <p:sldSz cx="12192000" cy="6858000"/>
    </p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
    </Relationships>`);
  zip.file('ppt/slides/slide1.xml', slideXml('PawCare Background', '4FACFE'));
  zip.file('ppt/slides/slide2.xml', slideXml('Project Structure', 'FF8C42'));

  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  const slides = await parsePptxFallbackSlides(buffer);

  assert.equal(slides.length, 2);
  assert.equal(slides[0].elements.some((element) => element.text.includes('PawCare Background')), true);
  assert.equal(slides[1].elements.some((element) => element.text.includes('Project Structure')), true);
  assert.equal(slides[0].elements.some((element) => element.fill === '#4FACFE'), true);
});

test('parsePptxFallbackSlides reads the generated PawCare structure deck when available', async (t) => {
  const fixturePath = findPawCareStructureDeck();
  if (!fixturePath) {
    t.skip('PawCare_Structure.pptx fixture is not present in .sandboxes');
    return;
  }

  const buffer = readFileSync(fixturePath);
  const slides = await parsePptxFallbackSlides(toArrayBuffer(buffer));
  const allText = slides.flatMap((slide) => slide.elements.map((element) => element.text)).join('\n');
  const shapeCount = slides.reduce((sum, slide) => sum + slide.elements.filter((element) => element.fill).length, 0);

  assert.equal(slides.length, 2);
  assert.match(allText, /项目目录结构|Project Structure/);
  assert.match(allText, /组件架构|数据流/);
  assert.ok(shapeCount > 0);
});

function slideXml(text: string, color: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>
          </p:spPr>
        </p:sp>
        <p:sp>
          <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
          </p:spPr>
          <p:txBody><a:p><a:r><a:rPr sz="2800"/><a:t>${text}</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
    </p:sld>`;
}

function findPawCareStructureDeck(): string | null {
  const sandboxRoot = '.sandboxes';
  if (!existsSync(sandboxRoot)) return null;

  for (const entry of readdirSync(sandboxRoot)) {
    const candidate = join(sandboxRoot, entry, 'PawCare_Structure.pptx');
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const sliced = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return sliced instanceof ArrayBuffer ? sliced : new Uint8Array(buffer).buffer;
}
