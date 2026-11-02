const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildZip } = require('../core/zip');
const {
    buildComicInfoXml, buildInfoJson, upsertZipEntry, writeMetadata, hasCurrentComicInfo,
    readComicInfo, hasTagData, FORMAT_MARKER
} = require('../core/comicInfo');

const TYPED = {
    tags: [
        { type: 'artist', name: 'tamano kedama' },
        { type: 'group', name: 'some circle' },
        { type: 'language', name: 'english' },
        { type: 'language', name: 'translated' },
        { type: 'category', name: 'doujinshi' },
        { type: 'tag', name: 'sole female' },
        { type: 'tag', name: 'x & <y>' },
        { type: 'character', name: 'asahi' },
        { type: 'parody', name: 'original' }
    ],
    uploadDate: 1700000000,
    scanlator: 'someone',
    titlePretty: 'Pretty "Title"'
};

function sha1First512000(file) {
    return crypto.createHash('sha1').update(fs.readFileSync(file).subarray(0, 512000)).digest('hex');
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ci-')); }

// A stored zip above 512000 bytes whose ComicInfo.xml (old format) is the last entry, like the
// archives nhdl wrote before.
function bigArchive({ comicInfoFirst = false } = {}) {
    const pages = [1, 2, 3].map(n => ({ name: `${n}.jpg`, data: Buffer.alloc(300000, n) }));
    const old = { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Tags>tag: old</Tags></ComicInfo>') };
    return buildZip(comicInfoFirst ? [old, ...pages] : [...pages, old]);
}

test('ComicInfo.xml: plain tags, Penciller, Characters, LanguageISO, Genre, no Title', () => {
    const xml = buildComicInfoXml(123, TYPED, { url: 'https://nhentai.net/g/123/' });
    assert.match(xml, /<Tags>sole female, x &amp; &lt;y&gt;<\/Tags>/);
    assert.doesNotMatch(xml, /tag: |language: |parody: |character: /);
    assert.match(xml, /<Writer>tamano kedama<\/Writer>/);
    assert.match(xml, /<Penciller>tamano kedama<\/Penciller>/);
    assert.match(xml, /<Publisher>some circle<\/Publisher>/);
    assert.match(xml, /<Characters>asahi<\/Characters>/);
    assert.match(xml, /<LanguageISO>en<\/LanguageISO>/);
    assert.match(xml, /<Genre>doujinshi<\/Genre>/);
    assert.match(xml, /<Translator>someone<\/Translator>/);
    assert.match(xml, /<Year>2023<\/Year>/);
    assert.match(xml, /<Web>https:\/\/nhentai.net\/g\/123\/<\/Web>/);
    assert.doesNotMatch(xml, /<Title>/);
    assert.ok(xml.includes(FORMAT_MARKER));
});

test('untyped provider tags are plain tags; artist, language and genre come from the entry', () => {
    const meta = { tags: [{ name: 'stockings' }, { name: 'big breasts' }], category: 'western' };
    const xml = buildComicInfoXml('rox:849292', meta, { artist: 'Aarokira', language: 'English' });
    assert.match(xml, /<Tags>stockings, big breasts<\/Tags>/);
    assert.match(xml, /<Penciller>Aarokira<\/Penciller>/);
    assert.match(xml, /<LanguageISO>en<\/LanguageISO>/);
    assert.match(xml, /<Genre>western<\/Genre>/);
    assert.match(xml, /<Web>https:\/\/hentairox.com\/gallery\/849292\/<\/Web>/);
});

test('a gallery without tags still gets the minimal fields', () => {
    const xml = buildComicInfoXml('xxx:536627', { tags: [], tagsFetched: true, category: 'manga' }, { artist: 'Raikageart', language: 'Japanese' });
    assert.doesNotMatch(xml, /<Tags>/);
    assert.match(xml, /<Writer>Raikageart<\/Writer>/);
    assert.match(xml, /<Penciller>Raikageart<\/Penciller>/);
    assert.match(xml, /<Genre>manga<\/Genre>/);
    assert.match(xml, /<LanguageISO>ja<\/LanguageISO>/);
    assert.match(xml, /<Web>https:\/\/nhentai.xxx\/g\/536627\/<\/Web>/);
    const placeholder = buildComicInfoXml(1, {}, { artist: 'Other' });
    assert.doesNotMatch(placeholder, /<Writer>/, '"Other" is a placeholder, not an artist');
});

test('info.json: HDoujin style, tags as a list without namespaces', () => {
    const obj = JSON.parse(buildInfoJson(123, TYPED, { url: 'https://nhentai.net/g/123/' }));
    assert.deepEqual(obj.manga_info.tags, ['sole female', 'x & <y>']);
    assert.equal(obj.manga_info.artist, 'tamano kedama');
    assert.equal(obj.manga_info.circle, 'some circle');
    assert.equal(obj.manga_info.characters, 'asahi');
    assert.equal(obj.manga_info.parody, 'original');
    assert.equal(obj.manga_info.language, 'english');
    assert.equal(obj.manga_info.url, 'https://nhentai.net/g/123/');
    const none = JSON.parse(buildInfoJson(1, { tags: [] }, { artist: 'A' }));
    assert.equal('tags' in none.manga_info, false);
});

test('hasTagData is true for tags or for a fetch that returned none', () => {
    assert.equal(hasTagData(null), false);
    assert.equal(hasTagData({ tags: [] }), false);
    assert.equal(hasTagData({ tags: [], tagsFetched: true }), true);
    assert.equal(hasTagData(TYPED), true);
});

test('upsertZipEntry keeps entries, replaces by name, and stays a valid zip', () => {
    const dir = tmpDir();
    const base = buildZip([{ name: '1.jpg', data: Buffer.from('aaa') }, { name: '2.jpg', data: Buffer.from('bbbb') }]);
    const twice = upsertZipEntry(upsertZipEntry(base, 'ComicInfo.xml', Buffer.from('<a/>')), 'ComicInfo.xml', Buffer.from('<b/>'));
    const file = path.join(dir, 't.cbz');
    fs.writeFileSync(file, twice);
    const script = 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(",".join(sorted(z.namelist())), z.read("ComicInfo.xml").decode(), z.read("2.jpg").decode())';
    assert.equal(execFileSync('python', ['-I', '-c', script, file]).toString().trim(), '1.jpg,2.jpg,ComicInfo.xml <b/> bbbb');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('writing over an old ComicInfo.xml keeps the SHA1 of the first 512000 bytes (LANraragi ID)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.cbz');
    fs.writeFileSync(file, bigArchive());
    const before = sha1First512000(file);
    assert.equal(hasCurrentComicInfo(file, 'cbz'), false);

    const r = writeMetadata(123, file, 'cbz', TYPED, { url: 'https://nhentai.net/g/123/' });
    assert.equal(r.written, true);
    assert.equal(sha1First512000(file), before, 'first 512000 bytes changed');
    assert.equal(hasCurrentComicInfo(file, 'cbz'), true);
    assert.match(readComicInfo(file, 'cbz'), /<Penciller>tamano kedama<\/Penciller>/);

    const script = 'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nn=sorted(z.namelist())\ninfo=json.loads(z.read("info.json"))\nprint(",".join(n), info["manga_info"]["tags"])';
    assert.equal(execFileSync('python', ['-I', '-c', script, file]).toString().trim(), "1.jpg,2.jpg,3.jpg,ComicInfo.xml,info.json ['sole female', 'x & <y>']");

    // a second write (e.g. a later backfill) is also hash-stable
    assert.equal(writeMetadata(123, file, 'cbz', TYPED, {}).written, true);
    assert.equal(sha1First512000(file), before);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a write that would change the archive ID is refused and leaves the file untouched', () => {
    const dir = tmpDir();
    const small = path.join(dir, 'small.cbz');
    fs.writeFileSync(small, buildZip([{ name: '1.jpg', data: Buffer.alloc(1000, 1) }]));
    const smallBytes = fs.readFileSync(small);
    const r1 = writeMetadata(1, small, 'cbz', TYPED, {});
    assert.equal(r1.written, false);
    assert.match(r1.reason, /512000/);
    assert.ok(fs.readFileSync(small).equals(smallBytes));

    const early = path.join(dir, 'early.cbz'); // old ComicInfo.xml sits inside the hashed window
    fs.writeFileSync(early, bigArchive({ comicInfoFirst: true }));
    const earlyBytes = fs.readFileSync(early);
    assert.equal(writeMetadata(1, early, 'cbz', TYPED, {}).written, false);
    assert.ok(fs.readFileSync(early).equals(earlyBytes));
    assert.equal(fs.existsSync(`${early}.nhdl-tmp`), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('folder galleries get both files; missing targets are reported', () => {
    const dir = tmpDir();
    assert.equal(writeMetadata(1, dir, 'folder', { tags: [] }, { artist: 'A' }).written, true);
    assert.ok(fs.existsSync(path.join(dir, 'ComicInfo.xml')));
    assert.ok(fs.existsSync(path.join(dir, 'info.json')));
    assert.equal(writeMetadata(1, path.join(dir, 'nope'), 'folder', {}, {}).written, false);
    fs.rmSync(dir, { recursive: true, force: true });
});
