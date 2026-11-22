const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Script } = require('node:vm');

function selectAdaptive4k(manifest) {
  if (typeof manifest !== 'string') return null;
  const lines = manifest.trimEnd().split(/\r?\n/);
  if (lines[0] !== '#EXTM3U' || lines[lines.length - 1] !== '#EXT-X-ENDLIST') {
    return null;
  }

  let selected;
  for (let index = 1; index < lines.length - 1; index += 2) {
    const attributes = lines[index];
    const uri = lines[index + 1];
    if (!attributes.startsWith('#EXT-X-STREAM-INF:') || !/^https?:\/\/[^\s]+$/.test(uri)) {
      return null;
    }
    if (/(?:^|[:,])RESOLU=2160(?:,|$)/.test(attributes) &&
        /(?:^|[:,])QUALITY=6(?:,|$)/.test(attributes) &&
        /(?:^|[:,])STREAMTYPE="mp5hd4"(?:,|$)/.test(attributes)) {
      if (selected) return null;
      selected = [attributes, uri];
    }
  }

  if (!selected) return null;
  return [lines[0], ...selected, lines[lines.length - 1], ''].join('\r\n');
}

function localAdaptive4k(resource, language) {
  if (!resource.user?.vip) return null;
  const auto = resource.streamList?.find(stream => stream.id === 'auto' && stream.lang === language);
  if (!auto?.uri?.HLS) return null;
  const manifest = selectAdaptive4k(auto.uri.HLSCONTENT);
  if (!manifest) return null;

  return {
    ...auto,
    id: 'local_adaptive_sdr4k',
    name: '4k',
    uri: { ...auto.uri, HLSCONTENT: manifest },
  };
}

const ident = '[a-zA-Z_$][\\w$]*';
const member = `${ident}(?:\\.${ident})*`;

function matchOnce(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `无法唯一识别${label}`);
  return matches[0];
}

function patchPlayer(original) {
  const prefix = matchOnce(original, new RegExp(String.raw`var ${ident}=\{"1080p":\["mp4hd3v2","mp4hd3","cmaf4hd3","mp5hd3"`, 'g'), '播放器画质映射');
  const lookup = matchOnce(original, new RegExp(String.raw`(?<head>\.prototype\.getStream=function\((?<language>${ident}),(?<key>${ident})\)\{)return this\._checkEmptyStream\(\)\?null:this\._model\.streamList\.find`, 'g'), '播放器流查找');
  const start = matchOnce(original, new RegExp(String.raw`(?<owner>${ident})\.prototype\.setMultiQuality=function\((?<input>${ident})\)\{`, 'g'), '播放器画质菜单入口');
  const end = original.indexOf(`${start.groups.owner}.prototype.hasQuality=function`, start.index);
  assert(end > start.index && prefix.index < lookup.index && lookup.index < start.index, '无法确定播放器代码结构');
  const menu = original.slice(start.index, end);
  const { list } = matchOnce(menu, new RegExp(String.raw`\.streamTypeFilter,(?<list>${ident})=${start.groups.input};if\(!`, 'g'), '播放器档位列表').groups;
  const loop = matchOnce(menu, new RegExp(String.raw`var ${ident}=!1;if\(${list}\.forEach\(\(function\((?<item>${ident})\)\{`, 'g'), '播放器档位渲染循环');
  const { item } = loop.groups;
  const { platform } = matchOnce(menu, new RegExp(String.raw`(?<platform>${member})\.isMac&&\(`, 'g'), 'Windows 平台校验').groups;
  const { env } = matchOnce(menu, new RegExp(String.raw`this\._context\.config\.environment===(?<env>${member})\.ElectronIku\)\{`, 'g'), '桌面播放器校验').groups;
  const { engine } = matchOnce(menu, new RegExp(String.raw`this\._context\.supportType===(?<engine>${member})\.M3U8`, 'g'), '播放器引擎校验').groups;
  assert(original.includes(`${engine}.NPlayer`) && menu.includes('this.dispatchPropertyChangeEvent("multiQuality")'), '无法确认原生播放器菜单路径');
  const caption = matchOnce(menu, new RegExp(String.raw`var (?<title>${ident})=${item}\.title&&${ident}\?${item}\.title:(?<labels>${ident})\[${item}\.name\]\.name,${ident}=${item}\.label&&${ident}\?${item}\.label:\k<labels>\[${item}\.name\]\.label(?:,${ident}=\k<labels>\[${item}\.name\]\.spm\|\|"")?;`, 'g'), '播放器画质标题');
  const replacements = [
    [prefix[0], `${selectAdaptive4k.toString()}\n${localAdaptive4k.toString()}\n${prefix[0]}`],
    [lookup[0], `${lookup.groups.head}if(${lookup.groups.key}==="local_adaptive_sdr4k")return localAdaptive4k(this,${lookup.groups.language});${lookup[0].slice(lookup.groups.head.length)}`],
    [loop[0], `if(!${platform}.isMac && this._context.config.environment===${env}.ElectronIku && this._context.supportType===${engine}.NPlayer && !${list}.some((function(t){return t.name==="4k"}))){const allowed4k=localAdaptive4k(this.mediaResource,this._language);if(allowed4k)${list}=${list}.concat(allowed4k)}${loop[0]}`],
    [caption[0], `${caption[0]}if(${item}.id==="local_adaptive_sdr4k")${caption.groups.title}="智能 4K（固定）";`],
  ];
  return replaceOnce(original, replacements);
}

function replaceOnce(original, replacements) {
  let source = original;
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, `Expected one match for ${before}`);
    source = source.replace(before, () => after);
  }
  return source;
}

const automaticCheck = 'case 0:return s=t.source,c=void 0===s?"menu":s,p=t.bizSource,e.n=1,X();case 1:if(global.onceInstalled';
const updaterSetup = 'function $(){o.ipcMain.on("check-update",(function(){H({source:"menu"})}))';
const automaticClear = 'global.remoteCacheVersion=t,Object(h.clearCache)().then((function(){Object(M.reloadWindow)()}))';

function patchMaintenance(original) {
  return replaceOnce(original, [
    [automaticCheck, 'case 0:s=t.source,c=void 0===s?"menu":s;if(c!=="menu"){f.a.info("[youku-4k-repair] Skipped background app update");return e.a(2)}return p=t.bizSource,e.n=1,X();case 1:if(global.onceInstalled'],
    [updaterSetup, 'function $(){r.autoUpdater.autoInstallOnAppQuit=!1,o.ipcMain.on("check-update",(function(){H({source:"menu"})}))'],
    [automaticClear, 'global.remoteCacheVersion=t,r.kuLog.info("[youku-4k-repair] Skipped automatic resource cache clear")'],
  ]);
}

const player = {
  marker: 'local_adaptive_sdr4k',
  build: patchPlayer,
};
const maintenance = {
  marker: '[youku-4k-repair] Skipped background app update',
  file: 'main.prod.js',
  build: patchMaintenance,
};

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function needEnv(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`环境变量 ${name} 缺失或无效。`);
  return value;
}

function backupDirectory() {
  return path.join(needEnv('LOCALAPPDATA'), 'youku-4k-repair', 'backups');
}

function playerTarget(appData) {
  const declared = new Set();
  for (const profile of ['v2', '']) {
    const layouts = path.join(appData, 'layout_caches', profile, 'playerPage');
    if (!fs.existsSync(layouts)) continue;
    const cache = path.join(appData, 'local_caches', profile, 'static');
    for (const file of fs.readdirSync(layouts, { withFileTypes: true })) {
      if (!file.isFile() || !/^[\da-f]{32}$/i.test(file.name)) continue;
      const page = fs.readFileSync(path.join(layouts, file.name), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const scripts = page.matchAll(/<script\b[^>]*\ssrc\s*=\s*(["'])(?:(?:https?|client):)?\/\/(g\.alicdn\.com\/kplayer\/kuplayer\/[\w.-]+\/index\.js)(?:\?rnd=[\w.-]+)?\1/gi);
      for (const match of scripts) {
        const filename = createHash('md5').update(`https://${match[2]}`).digest('hex');
        declared.add(path.join(cache, `${filename}.js`));
      }
    }
  }
  if (declared.size > 1) throw new Error('发现多个播放页指向不同播放器。请使用 Skill 核对正在加载的脚本。');
  const [target] = declared;
  if (!target || !fs.existsSync(target)) throw new Error('未找到播放页对应的播放器缓存。请先打开影片，再退出优酷重试。');
  return target;
}

function targetPath(spec, installDir) {
  if (spec === player) return playerTarget(path.join(needEnv('APPDATA'), 'youku-app'));
  if (!installDir || !path.isAbsolute(installDir)) throw new Error('请使用包含 YOUKU.exe 的绝对安装目录。');
  if (!fs.existsSync(path.join(installDir, 'YOUKU.exe'))) throw new Error('该目录里没有 YOUKU.exe。');
  return path.join(installDir, 'resources', 'app', 'app', 'main', 'dist', spec.file);
}

function inspectTarget(spec, target) {
  if (!fs.existsSync(target)) throw new Error('未找到对应的优酷文件。');
  const current = fs.readFileSync(target);
  if (!current.includes(spec.marker)) {
    const source = current.toString('utf8');
    assert(Buffer.from(source).equals(current), '播放器文件编码无法识别');
    const patched = Buffer.from(spec.build(source));
    new Script(patched.toString('utf8'), { filename: path.basename(target) });
    return { current, original: current, patched, isPatched: false };
  }

  const directory = backupDirectory();
  const suffix = `-${path.basename(target)}`;
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const original = fs.readFileSync(path.join(directory, entry.name));
      if (`${digest(original)}${suffix}` !== entry.name) continue;
      let patched;
      try {
        patched = Buffer.from(spec.build(original.toString('utf8')));
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        continue;
      }
      if (current.equals(patched)) return { current, original, patched, isPatched: true };
    }
  }
  throw new Error('检测到已有修改，找不到与当前文件匹配的原始备份。请使用 Skill 核对。');
}

function requireClosed() {
  const tasklist = path.join(needEnv('SystemRoot'), 'System32', 'tasklist.exe');
  const processes = execFileSync(tasklist, ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (/^"(?:youku|youkunplayer)\.exe",/im.test(processes)) {
    throw new Error('请从托盘退出优酷后重试。');
  }
}

function replaceAtomically(target, currentHash, bytes) {
  const pending = path.join(path.dirname(target), `.youku-4k-repair-${randomUUID()}.tmp`);
  fs.writeFileSync(pending, bytes, { flag: 'wx' });
  try {
    if (digest(fs.readFileSync(target)) !== currentHash) throw new Error('操作期间文件发生变化。');
    fs.renameSync(pending, target);
  } finally {
    fs.rmSync(pending, { force: true });
  }
  if (digest(fs.readFileSync(target)) !== digest(bytes)) throw new Error('写入后的 SHA-256 验证失败。');
}

function change(spec, target, restore) {
  const { current, original, patched, isPatched } = inspectTarget(spec, target);
  if (restore !== isPatched) return '已是所需状态';
  const bytes = restore ? original : patched;
  if (!restore) {
    const backup = path.join(backupDirectory(), `${digest(original)}-${path.basename(target)}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' });
    if (!fs.readFileSync(backup).equals(original)) throw new Error('备份的 SHA-256 不匹配。');
  }
  replaceAtomically(target, digest(current), bytes);
  return restore ? '已还原' : '已应用并校验';
}

function selfCheck() {
  const lower = '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLU=1080,QUALITY=5,STREAMTYPE="mp5hd3"';
  const regular = '#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLU=2160,QUALITY=6,STREAMTYPE="mp5hd4"';
  const premium = '#EXT-X-STREAM-INF:BANDWIDTH=300,RESOLU=2160,QUALITY=25,STREAMTYPE="hls5hd4_hbr_bit10"';
  const signedUri = 'https://example.test/ordinary?a=1&sig=abc%3D';
  const fixture = ['#EXTM3U', lower, 'https://example.test/lower', regular, signedUri, premium, 'https://example.test/premium', '#EXT-X-ENDLIST', ''].join('\n');
  const expected = ['#EXTM3U', regular, signedUri, '#EXT-X-ENDLIST', ''].join('\r\n');
  assert.equal(selectAdaptive4k(fixture), expected);
  assert.equal(selectAdaptive4k(fixture.replace('QUALITY=6', 'QUALITY=25')), null);
  assert.equal(selectAdaptive4k(fixture.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO')), null);

  const drmInfo = { type: 'customized' };
  const auto = { id: 'auto', lang: 'default', drmInfo, uri: { HLS: 'blob:existing', HLSCONTENT: fixture } };
  const resource = { streamList: [auto], user: { vip: true } };
  assert.equal(localAdaptive4k(resource, 'default').drmInfo, drmInfo);
  assert.equal(auto.uri.HLSCONTENT, fixture);
  assert.equal(localAdaptive4k(resource, 'other'), null);
  assert.equal(localAdaptive4k({ ...resource, user: { vip: false } }, 'default'), null);
  assert.throws(() => patchPlayer('unknown build'), /无法唯一识别/);
  assert.throws(() => patchMaintenance('unknown build'), /Expected one match/);

  const fixtureMain = [automaticCheck, updaterSetup, automaticClear, 'manual.clearCache()'].join('\n');
  const changedMain = patchMaintenance(fixtureMain);
  assert.match(changedMain, /if\(c!=="menu"\).*return e\.a\(2\)/);
  assert.match(changedMain, /ipcMain\.on\("check-update",\(function\(\)\{H\(\{source:"menu"\}\)/);
  assert.match(changedMain, /autoInstallOnAppQuit=!1/);
  assert.doesNotMatch(changedMain, /Object\(h\.clearCache\)/);
  assert.match(changedMain, /manual\.clearCache\(\)/);
}

function cli(args) {
  const [command, installDir, ...rest] = args;
  if (!rest.length && command === 'check' && !installDir) {
    selfCheck();
    console.log('离线检查通过');
    return;
  }
  if (rest.length || process.platform !== 'win32') throw new Error('补丁操作仅支持 Windows。');
  if (command === 'status') {
    const specs = [{ label: '4K 菜单', spec: player }];
    if (installDir) specs.push({ label: '更新与缓存保护', spec: maintenance });
    for (const { label, spec } of specs) {
      try {
        const { isPatched } = inspectTarget(spec, targetPath(spec, installDir));
        console.log(`${label}：${isPatched ? '已应用' : '匹配，可应用'}`);
      } catch (error) {
        console.error(`${label}：${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  const updatePlayer = ['apply', 'restore'].includes(command) && !installDir;
  const updateMaintenance = ['protect', 'unprotect'].includes(command) && installDir;
  if (!updatePlayer && !updateMaintenance) throw new Error('用法：check | status [安装目录] | apply | restore | protect <安装目录> | unprotect <安装目录>');
  const spec = updatePlayer ? player : maintenance;
  const target = targetPath(spec, installDir);
  requireClosed();
  console.log(change(spec, target, command === 'restore' || command === 'unprotect'));
}

if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchPlayer, patchMaintenance, playerTarget, change, player, maintenance };
