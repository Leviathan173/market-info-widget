'use strict';

/**
 * electron-builder 打包后的收尾：写入应用图标与版本信息。
 *
 * 为什么不用 electron-builder 自带的 rcedit：
 * 它在 Windows 上会下载 winCodeSign 压缩包，包里带 macOS 符号链接，
 * 普通用户权限解压会失败（客户端没有所需的特权）。这里改用纯 JS 的 resedit 直接改 PE 资源，
 * 因此 package.json 里关闭了 signAndEditExecutable。
 */

const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

const ICON_PATH = path.join(__dirname, 'icon.ico');
const FALLBACK_ICON_PNG = path.join(__dirname, 'icon.png');
const VERSION = require('../package.json').version;

function patchExe(exePath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // 图标
  if (fs.existsSync(ICON_PATH)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ICON_PATH));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((item) => item.data),
    );
  } else if (fs.existsSync(FALLBACK_ICON_PNG)) {
    console.warn('[afterPack] 未找到 icon.ico，跳过图标写入');
  }

  // 版本信息
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const lang = { lang: 1033, codepage: 1200 };
    vi.setStringValues(lang, {
      ProductName: 'MarketInfo',
      FileDescription: '市场速览 · 金十快讯与行情',
      CompanyName: 'maigo',
      LegalCopyright: 'Copyright © 2026 maigo',
      OriginalFilename: 'MarketInfo.exe',
      InternalName: 'MarketInfo',
    });
    vi.setFileVersion(VERSION, 1033);
    vi.setProductVersion(VERSION, 1033);
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack] 未找到可执行文件:', exePath);
    return;
  }

  try {
    patchExe(exePath);
    console.log('[afterPack] 已写入图标与版本信息:', path.basename(exePath));
  } catch (err) {
    console.error('[afterPack] 写入资源失败:', err.message);
    throw err;
  }
};