const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildZip } = require('../core/zip');
const { buildComicInfoXml, upsertZipEntry, writeComicInfo, hasFullMetadata } = require('../core/comicInfo');

const META = {
    tags: [
        { type: 'artist', name: 'tamano kedama' },
        { type: 'group', name: 'some circle' },
        { type: 'language', name: 'english' },
        { type: 'category', name: 'doujinshi' },
        { type: 'tag', name: 'x & <y>' },
        { type: 'parody', name: 'original' }
    ],
    uploadDate: 1700000000,
    scanlator: 'someone',
    titlePretty: 'Pretty "Title"'
};

test('buildComicInfoXml maps tag types to ComicInfo fields and escapes XML', () => {
    const xml = buildComicInfoXml(123, META, { webUrl: 'https://nhentai.net/g/123/' });
    assert.match(xml, /<Writer>tamano kedama<\/Writer>/);
    assert.match(xml, /<Publisher>some circle<\/Publisher>/);
    assert.match(xml, /<Genre>doujinshi<\/Genre>/);
    assert.match(xml, /<Translator>someone<\/Translator>/);
    assert.match(xml, /<Year>2023<\/Year>/);
    assert.match(xml, /<Tags>language: english, parody: original, tag: x &amp; &lt;y&gt;<\/Tags>/);
    assert.match(xml, /<Title>123 Pretty &quot;Title&quot;<\/Title>/);
    assert.match(xml, /<Web>https:\/\/nhentai.net\/g\/123\/<\/Web>/);
});

test('hasFullMetadata requires a non-empty tag list', () => {
    assert.equal(hasFullMetadata(null), false);
    assert.equal(hasFullMetadata({ tags: [] }), false);
    assert.equal(hasFullMetadata(META), true);
});

test('upsertZipEntry keeps existing entries, adds and replaces, and stays a valid zip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ci-'));
    const base = buildZip([
        { name: '1.jpg', data: Buffer.from('aaa') },
        { name: '2.jpg', data: Buffer.from('bbbb') }
    ]);
    const once = upsertZipEntry(base, 'ComicInfo.xml', Buffer.from('<a/>'));
    const twice = upsertZipEntry(once, 'ComicInfo.xml', Buffer.from('<b/>'));
    const file = path.join(dir, 't.cbz');
    fs.writeFileSync(file, twice);
    const script = [
        'import zipfile,sys',
        'z=zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None',
        'print(",".join(sorted(z.namelist())), z.read("ComicInfo.xml").decode(), z.read("2.jpg").decode())'
    ].join('\n');
    const out = execFileSync('python', ['-c', script, file]).toString().trim();
    assert.equal(out, '1.jpg,2.jpg,ComicInfo.xml <b/> bbbb');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('writeComicInfo writes into a folder and skips entries without tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ci-'));
    assert.equal(writeComicInfo(1, dir, 'folder', { tags: [] }).written, false);
    assert.equal(writeComicInfo(1, dir, 'folder', META).written, true);
    assert.ok(fs.existsSync(path.join(dir, 'ComicInfo.xml')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('hasComicInfo detects the entry in a zip and in a folder', () => {
    const { hasComicInfo } = require('../core/comicInfo');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ci-'));
    const file = path.join(dir, 'a.cbz');
    const base = buildZip([{ name: '1.jpg', data: Buffer.from('x') }]);
    fs.writeFileSync(file, base);
    assert.equal(hasComicInfo(file, 'cbz'), false);
    fs.writeFileSync(file, upsertZipEntry(base, 'ComicInfo.xml', Buffer.from('<a/>')));
    assert.equal(hasComicInfo(file, 'cbz'), true);
    assert.equal(hasComicInfo(dir, 'folder'), false);
    fs.rmSync(dir, { recursive: true, force: true });
});
